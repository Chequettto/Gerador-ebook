'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const { generateBlock, generateOutline, generateCoverImageWithGemini, pools } = require('./aiService');
const { generateCoverUrl } = require('./coverService');
const { buildPdf, buildEpub } = require('./bookBuildService');
const { PLANS, findOrCreateCustomer, createLifetimeCharge, createMonthlySubscription, getPaymentStatus } = require('./asaasService');

const app = express();
const PORT = process.env.PORT || 3000;

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
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', uptimeSeconds: process.uptime() });
});

// ---------------------------------------------------------------------------
// POST /api/generate-block
// Gera 1 bloco (~350-400 palavras) de um capítulo, passando pela esteira
// tripla sequencial (Gemini -> Groq -> Mistral). Dividido em blocos pequenos
// para nunca ultrapassar o timeout de 30s do Render.
// ---------------------------------------------------------------------------
app.post('/api/generate-block', async (req, res) => {
  const { bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext, bookDescription, blocksPerChapter, language, allChapterTitles } = req.body || {};

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
    });

    return res.json({
      success: true,
      bookTitle,
      chapterTitle,
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
app.post('/api/generate-outline', async (req, res) => {
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

// ---------------------------------------------------------------------------
// POST /api/generate-cover
// Tenta primeiro o Gemini (gemini-3.1-flash-image), que escreve título,
// subtítulo e autor de verdade na imagem. Se as chaves do Gemini falharem
// todas, cai para o Pollinations como reserva (esse não escreve texto).
// Body: { title, subtitle?, author?, niche, stylePreference? }
// ---------------------------------------------------------------------------
app.post('/api/generate-cover', async (req, res) => {
  const { title, subtitle, author, niche, stylePreference } = req.body || {};

  if (!title || !niche) {
    return res.status(400).json({
      error: 'Campos obrigatórios ausentes no body.',
      missingFields: [!title && 'title', !niche && 'niche'].filter(Boolean),
    });
  }

  try {
    const image = await generateCoverImageWithGemini({
      title,
      subtitle: subtitle || '',
      author: author || '',
      niche,
      stylePreference,
    });
    return res.json({
      success: true,
      mode: 'gemini',
      imageBase64: image.bytes.toString('base64'),
      mimeType: image.mimeType,
      title,
      niche,
    });
  } catch (geminiError) {
    console.error('Gemini falhou ao gerar a capa, tentando reserva (Pollinations):', geminiError.message);
    try {
      const cover = generateCoverUrl({ title, niche, stylePreference });
      return res.json({ success: true, mode: 'pollinations', ...cover });
    } catch (error) {
      console.error('Erro ao gerar capa (reserva também falhou):', error);
      return res.status(500).json({
        success: false,
        error: 'Falha ao gerar a capa (Gemini e a reserva falharam).',
        details: `Gemini: ${geminiError.message} | Reserva: ${error.message}`,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/build-book
// Monta o PDF e o EPUB finais a partir dos capítulos já gerados (texto puro).
// NÃO chama nenhuma IA aqui — só formata o que já foi gerado, então é rápido
// e nunca esbarra no limite de 30s do Render. Não exige login.
// Body esperado:
// {
//   "title": "...", "subtitle": "...", "author": "...",
//   "chapters": [ { "position": 1, "title": "...", "content": "..." }, ... ],
//   "coverBase64": "...", "coverMime": "image/png"   (preferido — vem direto do /api/generate-cover no modo Gemini)
//   "coverUrl": "https://..."                          (alternativa — baixa de uma URL, ex: modo Pollinations)
// }
// ---------------------------------------------------------------------------
app.post('/api/build-book', async (req, res) => {
  const { title, subtitle, author, chapters, coverUrl, coverBase64, coverMime: coverMimeIn } = req.body || {};

  if (!title || !author || !Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({
      error: 'Campos obrigatórios ausentes: title, author e chapters (lista não vazia).',
    });
  }

  try {
    let coverBytes = null;
    let coverMime = null;
    if (coverBase64) {
      // Capa já veio pronta em base64 (modo Gemini) — não precisa baixar nada.
      coverBytes = new Uint8Array(Buffer.from(coverBase64, 'base64'));
      coverMime = coverMimeIn || 'image/png';
    } else if (coverUrl) {
      try {
        const fetch = require('node-fetch');
        const imgRes = await fetch(coverUrl);
        if (imgRes.ok) {
          const buf = await imgRes.buffer();
          coverBytes = new Uint8Array(buf);
          coverMime = imgRes.headers.get('content-type') || 'image/png';
        }
      } catch (imgErr) {
        console.error('Não foi possível baixar a capa, seguindo sem ela:', imgErr.message);
      }
    }

    const buildInput = {
      title,
      subtitle: subtitle || null,
      author,
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
app.post('/api/create-payment', async (req, res) => {
  const { name, email, cpfCnpj, plan } = req.body || {};

  const missing = [];
  if (!name) missing.push('name');
  if (!email) missing.push('email');
  if (!cpfCnpj) missing.push('cpfCnpj');
  if (!plan) missing.push('plan');
  if (missing.length > 0) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.', missingFields: missing });
  }
  if (plan !== 'monthly' && plan !== 'lifetime') {
    return res.status(400).json({ error: 'plan deve ser "monthly" ou "lifetime".' });
  }

  try {
    const customerId = await findOrCreateCustomer({ name, email, cpfCnpj });
    const externalReference = `${email}-${Date.now()}`;
    const description = `Gerador de E-book — ${PLANS[plan].label}`;

    const result =
      plan === 'lifetime'
        ? await createLifetimeCharge({ customerId, description, externalReference })
        : await createMonthlySubscription({ customerId, description, externalReference });

    return res.json({ success: true, plan, ...result });
  } catch (error) {
    console.error('Erro ao criar cobrança Asaas:', error);
    return res.status(500).json({ success: false, error: 'Falha ao criar a cobrança.', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/payment-status/:id
// Consulta o status de um pagamento (PENDING, RECEIVED, CONFIRMED, OVERDUE...).
// ---------------------------------------------------------------------------
app.get('/api/payment-status/:id', async (req, res) => {
  try {
    const status = await getPaymentStatus(req.params.id);
    return res.json({ success: true, ...status });
  } catch (error) {
    console.error('Erro ao consultar pagamento:', error);
    return res.status(500).json({ success: false, error: 'Falha ao consultar o pagamento.', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/asaas-webhook
// Recebe as notificações automáticas do Asaas quando um pagamento muda de
// status (confirmado, atrasado, etc). Configure esta URL no painel do Asaas:
// Configurações -> Webhooks -> https://SEU-APP.onrender.com/api/asaas-webhook
// ---------------------------------------------------------------------------
app.post('/api/asaas-webhook', (req, res) => {
  const event = req.body || {};
  console.log('📩 Webhook Asaas recebido:', event.event, '-', event.payment && event.payment.id);
  // Aqui é onde, no futuro, se marcaria o pedido como pago no seu banco de dados.
  res.status(200).json({ received: true });
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
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(
    `🔑 Chaves configuradas — Gemini: ${pools.gemini.length} | Groq: ${pools.groq.length} | Mistral: ${pools.mistral.length} | OpenRouter: ${pools.openrouter.length} | Cloudflare: ${pools.cloudflare.length}`
  );
});
