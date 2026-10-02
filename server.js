'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const { generateBlock, generateOutline, refineOutline, generateCoverImageWithGemini, pools } = require('./aiService');
const { buildPdf, buildEpub } = require('./bookBuildService');
const { generateLocalCoverSvg } = require('./coverService');
const { PLANS, findOrCreateCustomer, createLifetimeCharge, createMonthlySubscription, getPaymentStatus } = require('./asaasService');
const researchEngine = require('./research/researchEngine');
const { compressReferenceText } = require('./promptCompression');
const { getPool, hasDatabase, initializeStore } = require('./accountStore');
const {
  destroySession,
  digestSignupIp,
  expiredSessionCookie,
  getUserForRequest,
  requestEmailCode,
  sessionCookie,
  verifyEmailCode,
} = require('./authService');
const { completeReservation, findReservation, reserveEbook } = require('./entitlementService');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------
const corsOrigin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*'
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : '*';

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '2mb' }));

// Log simples de todas as requisições
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Site: serve a página pronta (public/index.html) direto no endereço raiz.
// Basta abrir o link do Render no navegador — sem baixar nenhum arquivo.
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Healthcheck em JSON (útil para checar rápido se o serviço está de pé)
// ---------------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ebook-ai-backend',
    keysConfigured: {
      gemini: pools.gemini.length,
      groq: pools.groq.length,
      mistral: pools.mistral.length,
      openrouter: pools.openrouter.length,
      cloudflare: pools.cloudflare.length,
      database: Boolean(process.env.DATABASE_URL),
      emailLogin: Boolean(process.env.DATABASE_URL && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.AUTH_SESSION_SECRET),
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', uptimeSeconds: process.uptime() });
});

app.post('/api/auth/request-code', async (req, res) => {
  try {
    const result = await requestEmailCode(req.body && req.body.email, req.ip);
    return res.json({ success: true, email: result.email, message: 'Confira sua caixa de entrada para pegar o código.' });
  } catch (error) {
    return res.status(error.status || 503).json({
      error: error.message || 'Não foi possível enviar o código de acesso.',
      retryAfter: error.retryAfter || null,
    });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const result = await verifyEmailCode(req.body && req.body.email, req.body && req.body.code, req.ip);
    const secure = process.env.NODE_ENV === 'production' || req.get('x-forwarded-proto') === 'https';
    res.setHeader('Set-Cookie', sessionCookie(result.sessionToken, result.expiresAt, secure));
    return res.json({ success: true, user: result.user });
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.message || 'Não foi possível confirmar o código.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await getUserForRequest(req);
    return res.json({ authenticated: Boolean(user), user });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'O banco de dados não está disponível.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    await destroySession(req);
    const secure = process.env.NODE_ENV === 'production' || req.get('x-forwarded-proto') === 'https';
    res.setHeader('Set-Cookie', expiredSessionCookie(secure));
    return res.json({ success: true });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'Não foi possível encerrar a sessão.' });
  }
});

async function requireUser(req, res, next) {
  try {
    req.user = await getUserForRequest(req);
    if (!req.user) return res.status(401).json({ error: 'Entre com seu e-mail para continuar.' });
    return next();
  } catch (error) {
    return res.status(503).json({ error: error.message || 'A autenticação está indisponível.' });
  }
}

async function loadOptionalUser(req, res, next) {
  try {
    req.user = await getUserForRequest(req);
    return next();
  } catch (error) {
    return res.status(503).json({ error: error.message || 'A autenticação está indisponível.' });
  }
}

async function requireEbookReservation(req, res, next) {
  try {
    const reservation = await findReservation(
      req.user && req.user.id,
      req.body && req.body.reservationId,
      digestSignupIp(req.ip)
    );
    if (!reservation || reservation.status !== 'pending') {
      if (!hasDatabase()) {
        req.ebookReservation = { id: String(req.body && req.body.reservationId || 'local-memory-reservation'), status: 'pending' };
        return next();
      }
      return res.status(403).json({ error: 'Inicie ou retome um e-book antes de gerar conteúdo.' });
    }
    req.ebookReservation = reservation;
    return next();
  } catch (error) {
    if (!hasDatabase()) {
      req.ebookReservation = { id: String(req.body && req.body.reservationId || 'local-memory-reservation'), status: 'pending' };
      return next();
    }
    return res.status(503).json({ error: error.message || 'Não foi possível verificar sua cota.' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/research-status
// Painel simples do Research Engine: quantas fontes conectadas, quantas
// pesquisas estão guardadas em cache. Cada pesquisa individual já devolve
// suas próprias estatísticas dentro de /api/generate-block (researchStats).
// ---------------------------------------------------------------------------
app.get('/api/research-status', (req, res) => {
  res.json({
    connectorsAvailable: researchEngine.connectors.map((c) => c.name),
    europeanaConfigured: Boolean(process.env.EUROPEANA_API_KEY),
    cache: researchEngine.cacheStats(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/ebooks/reserve
// Reserva a cortesia única ou confirma acesso por plano pago/administrador.
// ---------------------------------------------------------------------------
app.post('/api/ebooks/reserve', loadOptionalUser, async (req, res) => {
  try {
    const reservation = await reserveEbook(req.user, digestSignupIp(req.ip));
    return res.json({ success: true, ...reservation });
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.message || 'Não foi possível reservar seu e-book.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate-block
// Recebe referências já preparadas e devolve 1 bloco após uma chamada final
// de polimento. Dividido em blocos pequenos para caber no limite do Render.
// ---------------------------------------------------------------------------
app.post('/api/generate-block', loadOptionalUser, requireEbookReservation, async (req, res) => {
  const { bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext, bookDescription, blocksPerChapter, language, allChapterTitles, bookStateSummary, researchContext: preparedResearchContext, researchPrepared } = req.body || {};

  const missing = [];
  if (!bookTitle) missing.push('bookTitle');
  if (!chapterTitle) missing.push('chapterTitle');
  if (!blockNumber) missing.push('blockNumber');
  if (!niche) missing.push('niche');
  if (!targetAudience) missing.push('targetAudience');
  if (!tone) missing.push('tone');

  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Campos obrigatórios ausentes no body.',
      missingFields: missing,
    });
  }

  const blockNum = Number(blockNumber);
  const maxBlocks = Number(blocksPerChapter) || 6;
  if (!Number.isInteger(blockNum) || blockNum < 1 || blockNum > 30) {
    return res.status(400).json({
      error: 'blockNumber deve ser um número inteiro entre 1 e 30.',
    });
  }

  try {
    // Research Engine: pesquisa fatos em fontes públicas ANTES de chamar a
    // IA (só na prática, na primeira vez por capítulo — depois vem do
    // cache). Se a pesquisa falhar por qualquer motivo, a geração continua
    // normalmente sem esse contexto extra — nunca trava o e-book por causa
    // disso, como pedido.
    let researchContext = typeof preparedResearchContext === 'string'
      ? compressReferenceText(preparedResearchContext, `${niche} ${chapterTitle}`, 3600)
      : '';
    let researchStats = null;
    if (researchPrepared) {
      console.log(`[fase-rag] Reutilizando micro-contexto preparado para "${chapterTitle}".`);
    } else {
      try {
        const researchResult = await researchEngine.research({ topic: niche, chapterTitle });
        researchContext = compressReferenceText(researchResult.context, `${niche} ${chapterTitle}`, 3600);
        researchStats = researchResult.stats;
      } catch (researchError) {
        console.error('Research Engine falhou, seguindo sem contexto extra:', researchError.message);
      }
    }

    const result = await generateBlock({
      bookTitle,
      chapterTitle,
      blockNumber: blockNum,
      niche,
      targetAudience,
      tone,
      recentContext: recentContext || '',
      bookDescription: bookDescription || '',
      blocksPerChapter: maxBlocks,
      language: language || 'português do Brasil',
      allChapterTitles: Array.isArray(allChapterTitles) ? allChapterTitles : [],
      researchContext,
      bookStateSummary: bookStateSummary || '',
    });

    return res.json({
      success: true,
      bookTitle,
      chapterTitle,
      researchStats,
      blockNumber: blockNum,
      ...result,
    });
  } catch (error) {
    console.error(`Erro ao gerar bloco ${blockNum} de "${chapterTitle}":`, error);
    const statusCode = error.retryable ? 503 : 500;
    return res.status(statusCode).json({
      success: false,
      retryable: Boolean(error.retryable),
      provider: error.provider || null,
      error: error.retryable
        ? 'Sem cota disponível agora nesse provedor. Tente este mesmo bloco novamente em alguns minutos.'
        : 'Falha ao gerar o bloco.',
      details: error.message,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate-outline
// A IA decide sozinha o subtítulo, a descrição e os títulos dos capítulos —
// a pessoa só informa o título, o nicho, o público e quantos capítulos quer.
// ---------------------------------------------------------------------------
app.post('/api/generate-outline', loadOptionalUser, requireEbookReservation, async (req, res) => {
  const { bookTitle, niche, targetAudience, tone, numChapters, language } = req.body || {};

  const missing = [];
  if (!bookTitle) missing.push('bookTitle');
  if (!niche) missing.push('niche');
  if (!targetAudience) missing.push('targetAudience');
  if (!tone) missing.push('tone');
  if (!numChapters) missing.push('numChapters');

  if (missing.length > 0) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes no body.', missingFields: missing });
  }

  const n = Number(numChapters);
  if (!Number.isInteger(n) || n < 1 || n > 30) {
    return res.status(400).json({ error: 'numChapters deve ser um número inteiro entre 1 e 30.' });
  }

  try {
    const outline = await generateOutline({
      bookTitle,
      niche,
      targetAudience,
      tone,
      numChapters: n,
      language: language || 'português do Brasil',
    });
    return res.json({ success: true, ...outline });
  } catch (error) {
    console.error('Erro ao gerar esboço:', error);
    const statusCode = error.retryable ? 503 : 500;
    return res.status(statusCode).json({
      success: false,
      retryable: Boolean(error.retryable),
      error: 'Falha ao gerar o esboço automático.',
      details: error.message,
    });
  }
});

// Pré-carrega pesquisa pública de todos os capítulos antes de chamar qualquer IA.
app.post('/api/prepare-book', loadOptionalUser, requireEbookReservation, async (req, res) => {
  const { niche, chapters } = req.body || {};
  if (!niche || !Array.isArray(chapters) || chapters.length === 0 || chapters.length > 30) {
    return res.status(400).json({ error: 'Informe o nicho e uma lista de 1 a 30 capítulos.' });
  }

  const results = [];
  for (let index = 0; index < chapters.length; index += 2) {
    const batch = chapters.slice(index, index + 2);
    results.push(...await Promise.allSettled(batch.map((chapterTitle) =>
      researchEngine.research({ topic: niche, chapterTitle })
    )));
  }
  const researchByChapter = {};
  let tokensBefore = 0;
  let tokensAfter = 0;
  results.forEach((result, index) => {
    const chapterTitle = chapters[index];
    if (result.status === 'fulfilled') {
      researchByChapter[chapterTitle] = result.value.context;
      tokensBefore += result.value.stats.tokensBeforeRaw || 0;
      tokensAfter += result.value.stats.tokensAfter || 0;
    } else {
      researchByChapter[chapterTitle] = '';
      console.error(`[fase-rag] Pesquisa pública indisponível para "${chapterTitle}":`, result.reason && result.reason.message);
    }
  });
  console.log(`[fase-rag] Pesquisa pública preparada antes da IA: estimativa ${tokensBefore} -> ${tokensAfter} tokens de referência.`);
  return res.json({ success: true, researchByChapter, savingsEstimate: Math.max(0, tokensBefore - tokensAfter) });
});

app.post('/api/refine-outline', loadOptionalUser, requireEbookReservation, async (req, res) => {
  const { bookTitle, niche, targetAudience, tone, numChapters, language, chapters, researchContext } = req.body || {};
  if (!bookTitle || !niche || !Array.isArray(chapters) || chapters.length !== Number(numChapters)) {
    return res.status(400).json({ error: 'Envie os dados do livro e o esqueleto local completo.' });
  }
  try {
    const outline = await refineOutline({
      bookTitle,
      niche,
      targetAudience,
      tone,
      numChapters: Number(numChapters),
      language,
      chapters,
      researchContext: typeof researchContext === 'string' ? researchContext : '',
    });
    return res.json({ success: true, ...outline });
  } catch (error) {
    console.error('Falha inesperada ao refinar o sumário; mantendo esqueleto local:', error.message);
    return res.json({ success: true, chapters, subtitle: '', description: '', localFallback: true });
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate-cover
// Gera a capa em SVG local, sem consumir chamadas ou créditos de IA.
// Body: { title, subtitle?, author?, niche, stylePreference? }
// ---------------------------------------------------------------------------
app.post('/api/generate-cover', loadOptionalUser, requireEbookReservation, async (req, res) => {
  const { title, subtitle, author, niche, stylePreference } = req.body || {};

  if (!title || !niche) {
    return res.status(400).json({
      error: 'Campos obrigatórios ausentes no body.',
      missingFields: [!title && 'title', !niche && 'niche'].filter(Boolean),
    });
  }

  try {
    let image;
    let local = false;
    try {
      image = await generateCoverImageWithGemini({
        title,
        subtitle: subtitle || '',
        author: author || '',
        niche,
        stylePreference,
      });
    } catch (error) {
      console.error('Gemini indisponível para a capa; usando desenho local:', error.message);
      image = {
        bytes: generateLocalCoverSvg({ title, subtitle: subtitle || '', author: author || '', niche }),
        mimeType: 'image/svg+xml',
      };
      local = true;
    }
    return res.json({
      success: true,
      imageBase64: image.bytes.toString('base64'),
      mimeType: image.mimeType,
      local,
      title,
      niche,
    });
  } catch (error) {
    console.error('Falha ao gerar a capa local:', error.message);
    return res.status(503).json({
      success: false,
      error: 'Não foi possível criar a capa local.',
      details: error.message,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/build-book
// Monta o PDF e o EPUB finais a partir dos capítulos já gerados (texto puro).
// NÃO chama nenhuma IA aqui — só formata o que já foi gerado, então é rápido
// e nunca esbarra no limite de 30s do Render. Exige usuário e reserva ativa.
// Body esperado:
// {
//   "title": "...", "subtitle": "...", "author": "...",
//   "chapters": [ { "position": 1, "title": "...", "content": "..." }, ... ],
//   "coverBase64": "...", "coverMime": "image/png" (gerados pelo Gemini)
// }
// ---------------------------------------------------------------------------
app.post('/api/build-book', loadOptionalUser, requireEbookReservation, async (req, res) => {
  const { title, subtitle, author, niche, chapters, coverBase64, coverMime: coverMimeIn } = req.body || {};

  if (!title || !author || !Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({
      error: 'Campos obrigatórios ausentes: title, author e chapters (lista não vazia).',
    });
  }

  try {
    let coverBytes = null;
    let coverMime = null;
    if (coverBase64) {
      // Capa local já veio em base64; não precisa baixar nada.
      coverBytes = new Uint8Array(Buffer.from(coverBase64, 'base64'));
      coverMime = coverMimeIn || 'image/png';
    }

    const buildInput = {
      title,
      subtitle: subtitle || null,
      author,
      niche: niche || '',
      chapters: chapters.map((c, i) => ({
        position: c.position || i + 1,
        title: c.title || `Capítulo ${i + 1}`,
        content: c.content || '',
      })),
      coverBytes,
      coverMime,
    };

    const pdfBytes = await buildPdf(buildInput);
    const epubBytes = buildEpub(buildInput);
    const completed = await completeReservation(
      req.user && req.user.id,
      req.ebookReservation.id,
      digestSignupIp(req.ip)
    );
    if (!completed) {
      return res.status(409).json({ success: false, error: 'Esta reserva já foi concluída ou não está mais ativa.' });
    }

    return res.json({
      success: true,
      pdfBase64: Buffer.from(pdfBytes).toString('base64'),
      epubBase64: Buffer.from(epubBytes).toString('base64'),
      pdfSizeBytes: pdfBytes.length,
      epubSizeBytes: epubBytes.length,
    });
  } catch (error) {
    console.error('Erro ao montar o livro:', error);
    return res.status(500).json({
      success: false,
      error: 'Falha ao montar o PDF/EPUB.',
      details: error.message,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/create-payment
// Cria (ou reaproveita) o cliente no Asaas e gera uma cobrança (plano mensal
// ou vitalício), retornando o link de pagamento (PIX, boleto ou cartão).
// Body: { name, email, cpfCnpj, plan: "monthly" | "lifetime" }
// ---------------------------------------------------------------------------
app.post('/api/create-payment', requireUser, async (req, res) => {
  const { name, cpfCnpj, plan, coupon } = req.body || {};

  if (!cpfCnpj || !plan) {
    return res.status(400).json({ error: 'Informe CPF/CNPJ e o plano desejado.' });
  }
  if (plan !== 'monthly' && plan !== 'lifetime') {
    return res.status(400).json({ error: 'plan deve ser "monthly" ou "lifetime".' });
  }

  try {
    const email = req.user.email;
    const customerId = await findOrCreateCustomer({ name: name || email, email, cpfCnpj });
    const externalReference = `ebook-${req.user.id}-${crypto.randomUUID()}`;
    const couponCode = typeof coupon === 'string' && coupon.trim().toLowerCase() === 'chequetto30'
      ? 'chequetto30'
      : null;
    const amount = Number((PLANS[plan].price * (couponCode ? 0.7 : 1)).toFixed(2));
    const description = `Gerador de E-book — ${PLANS[plan].label}${couponCode ? ' (cupom 30%)' : ''}`;

    const result =
      plan === 'lifetime'
        ? await createLifetimeCharge({ customerId, description, externalReference, value: amount })
        : await createMonthlySubscription({ customerId, description, externalReference, value: amount });

    await getPool().query(
      `INSERT INTO payments (user_id, external_reference, asaas_payment_id, subscription_id, plan, coupon_code, amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, externalReference, result.paymentId, result.subscriptionId, plan, couponCode, amount]
    );

    return res.json({ success: true, plan, amount, coupon: couponCode, ...result });
  } catch (error) {
    console.error('Erro ao criar cobrança Asaas:', error);
    return res.status(500).json({ success: false, error: 'Falha ao criar a cobrança.', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/payment-status/:id
// Consulta o status de um pagamento (PENDING, RECEIVED, CONFIRMED, OVERDUE...).
// ---------------------------------------------------------------------------
app.get('/api/payment-status/:id', requireUser, async (req, res) => {
  try {
    const ownedPayment = await getPool().query(
      'SELECT id FROM payments WHERE asaas_payment_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!ownedPayment.rowCount) return res.status(404).json({ error: 'Cobrança não encontrada.' });
    const status = await getPaymentStatus(req.params.id);
    return res.json({ success: true, ...status });
  } catch (error) {
    console.error('Erro ao consultar pagamento:', error);
    return res.status(500).json({ success: false, error: 'Falha ao consultar o pagamento.', details: error.message });
  }
});

app.get('/api/admin/users', requireUser, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  try {
    const result = await getPool().query(
      `SELECT u.id, u.email, u.free_ebook_used, u.has_lifetime_access, u.paid_until,
              u.created_at,
              COUNT(p.id) FILTER (WHERE p.status IN ('RECEIVED', 'CONFIRMED'))::INTEGER AS paid_count,
              COUNT(p.id) FILTER (WHERE p.status = 'PENDING')::INTEGER AS pending_count,
              COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('RECEIVED', 'CONFIRMED')), 0) AS paid_total
         FROM users u LEFT JOIN payments p ON p.user_id = u.id
        GROUP BY u.id ORDER BY u.created_at DESC`
    );
    return res.json({ success: true, users: result.rows });
  } catch (error) {
    return res.status(503).json({ error: 'Não foi possível carregar os usuários.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/asaas-webhook
// Recebe as notificações automáticas do Asaas quando um pagamento muda de
// status (confirmado, atrasado, etc). Configure esta URL no painel do Asaas:
// Configurações -> Webhooks -> https://SEU-APP.onrender.com/api/asaas-webhook
// ---------------------------------------------------------------------------
app.post('/api/asaas-webhook', async (req, res) => {
  const event = req.body || {};
  const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN || '';
  const receivedToken = req.get('asaas-access-token') || '';
  const expectedBuffer = Buffer.from(expectedToken);
  const receivedBuffer = Buffer.from(receivedToken);
  if (!expectedToken || expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return res.status(401).json({ error: 'Token do webhook inválido.' });
  }

  const payment = event.payment || {};
  const paidStatuses = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'];
  if (!paidStatuses.includes(event.event)) return res.status(200).json({ received: true });

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM payments
        WHERE asaas_payment_id = $1 OR external_reference = $2 OR subscription_id = $3
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [payment.id || null, payment.externalReference || null, payment.subscription || null]
    );
    const storedPayment = result.rows[0];
    if (!storedPayment) {
      await client.query('ROLLBACK');
      return res.status(202).json({ received: true, matched: false });
    }

    if (!['RECEIVED', 'CONFIRMED'].includes(storedPayment.status)) {
      await client.query(
        'UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2',
        [payment.status || event.event.replace('PAYMENT_', ''), storedPayment.id]
      );
      if (storedPayment.plan === 'lifetime') {
        await client.query('UPDATE users SET has_lifetime_access = TRUE WHERE id = $1', [storedPayment.user_id]);
      } else {
        await client.query(
          `UPDATE users SET paid_until = GREATEST(COALESCE(paid_until, NOW()), NOW()) + INTERVAL '30 days'
            WHERE id = $1`,
          [storedPayment.user_id]
        );
      }
    }
    await client.query('COMMIT');
    return res.status(200).json({ received: true, matched: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Erro ao processar webhook Asaas:', error.message);
    return res.status(500).json({ error: 'Falha ao processar notificação.' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 404 e handler de erro genérico
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor.', details: err.message });
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
function listen() {
  app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(
    `🔑 Chaves configuradas — Gemini: ${pools.gemini.length} | Groq: ${pools.groq.length} | Mistral: ${pools.mistral.length} | OpenRouter: ${pools.openrouter.length} | Cloudflare: ${pools.cloudflare.length}`
  );
  });
}

if (process.env.DATABASE_URL) {
  initializeStore().then(listen).catch((error) => {
    console.error('Não foi possível inicializar o banco PostgreSQL:', error.message);
    process.exitCode = 1;
  });
} else {
  console.warn('DATABASE_URL não configurada; login, cota e pagamentos ficam indisponíveis.');
  listen();
}
