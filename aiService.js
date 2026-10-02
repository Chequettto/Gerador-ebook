'use strict';

/**
 * aiService.js
 * ---------------------------------------------------------------------------
 * A estrutura, pesquisa, rascunho e capa são preparados localmente ou com
 * fontes públicas antes da geração textual. Cada bloco recebe duas chamadas:
 * Arquiteto Denso e Refino + Humanização. Provedores ficam em
 * aiConfig.js; chaves nunca são exibidas nos logs.
 * ---------------------------------------------------------------------------
 */

const fetch = require('node-fetch');
const { classifyChapterComplexity, models, pools, providerOrderFor } = require('./aiConfig');
const { compressReferenceText, normalizePromptText } = require('./promptCompression');
const { buildLocalDraft, buildLocalOutline, findLocalReferences } = require('./localBookService');

const REQUEST_TIMEOUT_MS = 15_000; // timeout individual por chamada (AbortController)
const TECHNICAL_PAUSE_MS = 10_000; // pausa técnica quando todas as chaves falham numa rodada
const MAX_GLOBAL_ROUNDS = 3; // rodadas completas por todas as chaves antes de desistir deste bloco

// -----------------------------------------------------------------------
// Clichês removidos no único polimento textual de cada bloco.
// -----------------------------------------------------------------------
const AI_CLICHES = [
  'no mundo moderno',
  'é crucial ressaltar',
  'em suma',
  'além disso',
  'mergulhar fundo',
  'portanto',
  'é importante notar',
  'em um mundo cada vez mais',
  'no cenário atual',
  'vale ressaltar',
  'em última análise',
  'dito isso',
];

const STATIC_PROMPTS = {
  architect: [
    'Você é um autor especialista. Desenvolva um rascunho denso e útil a partir do esqueleto local e das referências fornecidas.',
    'Respeite o capítulo, o público e o tom. Evite repetição, afirmações sem apoio e estatísticas inventadas.',
    'Use referências com suas próprias palavras. Preserve continuidade e entregue somente o texto do bloco.',
  ].join('\n'),
  outline: [
    'Você é um editor-chefe que organiza e-books em uma progressão didática clara.',
    'Use o nicho, o título e o público fornecidos. Responda apenas com JSON válido, sem markdown nem texto adicional.',
    'Não invente estatísticas ou promessas de resultado.',
  ].join('\n'),
  polish: [
    'Você é um editor executivo. Reescreva o texto recebido com fluidez natural, clareza e ritmo humano.',
    'Preserve fatos, exemplos e recomendações; não invente conteúdo, não aumente o escopo e não resuma.',
    `Evite clichês como: ${AI_CLICHES.join(', ')}.`,
    'Entregue apenas o texto final, sem título, markdown ou explicações.',
  ].join('\n'),
};

// Cursor de rotação independente por provedor, para distribuir carga entre chamadas
const rotationCursor = Object.fromEntries(Object.keys(pools).map((provider) => [provider, 0]));

function nextStartIndex(provider) {
  const pool = pools[provider];
  if (!pool || pool.length === 0) return 0;
  const idx = rotationCursor[provider] % pool.length;
  rotationCursor[provider] = (rotationCursor[provider] + 1) % pool.length;
  return idx;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(stage, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${stage}] ${message}`);
}

function preparePrompt(prompt) {
  if (typeof prompt === 'string') return { system: '', user: normalizePromptText(prompt) };
  return {
    system: normalizePromptText(prompt && prompt.system),
    user: normalizePromptText(prompt && prompt.user),
  };
}

function chatMessages(prompt) {
  const messages = [];
  if (prompt.system) messages.push({ role: 'system', content: prompt.system });
  messages.push({ role: 'user', content: prompt.user });
  return messages;
}

// -----------------------------------------------------------------------
// Chamadores HTTP de cada provedor (uma tentativa, uma chave, com timeout)
// -----------------------------------------------------------------------

async function callGeminiOnce(apiKey, prompt, model = models.gemini.standard) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        ...(prompt.system ? { systemInstruction: { parts: [{ text: prompt.system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: {
          temperature: 0.9,
          topP: 0.95,
          maxOutputTokens: 2048,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const err = new Error(`Gemini HTTP ${response.status}: ${errText.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n');
    if (!text || !text.trim()) {
      throw new Error('Gemini retornou resposta vazia.');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function callGroqOnce(apiKey, prompt, model = models.groq.standard) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.85,
        max_tokens: 2048,
        messages: chatMessages(prompt),
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const err = new Error(`Groq HTTP ${response.status}: ${errText.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new Error('Groq retornou resposta vazia.');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// Espaçamento mínimo entre pedidos à MESMA chave do Mistral, para nunca
// estourar o limite de "pedidos por segundo" documentado (é por conta, então
// só precisa esperar quando repetir a MESMA chave, não entre chaves diferentes).
const MISTRAL_MIN_INTERVAL_MS = 1100;
const lastMistralCallAt = new Map();

async function respectMistralPacing(apiKey) {
  const last = lastMistralCallAt.get(apiKey) || 0;
  const wait = MISTRAL_MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastMistralCallAt.set(apiKey, Date.now());
}

async function callMistralOnce(apiKey, prompt, model = models.mistral.standard) {
  await respectMistralPacing(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.8,
        max_tokens: 2048,
        messages: chatMessages(prompt),
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const err = new Error(`Mistral HTTP ${response.status}: ${errText.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new Error('Mistral retornou resposta vazia.');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------
// OpenRouter (reserva gratuita, formato compatível com OpenAI).
// Limite grátis documentado: ~20 pedidos/minuto e 50/dia por conta, então
// espaçamos os pedidos da mesma chave. A lista de modelos grátis muda com
// frequência: se o modelo abaixo sumir, troque OPENROUTER_MODEL no Render.
// -----------------------------------------------------------------------
const OPENROUTER_MIN_INTERVAL_MS = 3100;
const lastOpenRouterCallAt = new Map();

async function callOpenRouterOnce(apiKey, prompt, model = models.openrouter.standard) {
  const last = lastOpenRouterCallAt.get(apiKey) || 0;
  const wait = OPENROUTER_MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastOpenRouterCallAt.set(apiKey, Date.now());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.8,
        max_tokens: 2048,
        messages: chatMessages(prompt),
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const err = new Error(`OpenRouter HTTP ${response.status}: ${errText.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new Error('OpenRouter retornou resposta vazia.');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------
// Cloudflare Workers AI (reserva gratuita: 10.000 "neurons" por dia).
// Precisa de CLOUDFLARE_ACCOUNT_ID (não secreto) + token em CLOUDFLARE_KEY_1.
// -----------------------------------------------------------------------
async function callCloudflareOnce(apiToken, prompt, model = models.cloudflare.standard) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID não configurado.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        messages: chatMessages(prompt),
        max_tokens: 2048,
        temperature: 0.8,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const err = new Error(`Cloudflare HTTP ${response.status}: ${errText.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data?.result?.response;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Cloudflare retornou resposta vazia ou em formato inesperado.');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function generateCoverImageWithGemini({ title, subtitle, author, niche, stylePreference }) {
  const pool = pools.gemini;
  if (!pool || pool.length === 0) throw new Error('Nenhuma chave Gemini disponível para a capa.');
  const prompt = `Crie uma capa editorial profissional para um e-book sobre "${niche}". Inclua exatamente o título "${title}"${subtitle ? `, o subtítulo "${subtitle}"` : ''} e o autor "${author || 'Autor'}" como texto legível na imagem. Estilo: ${stylePreference || 'editorial moderno'}, formato retrato 2:3.`;
  let lastError = null;
  const startIndex = nextStartIndex('gemini');

  for (let offset = 0; offset < pool.length; offset += 1) {
    const keyIndex = (startIndex + offset) % pool.length;
    const apiKey = pool[keyIndex];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      log('CAPA - Gemini', `Tentando chave #${keyIndex + 1}/${pool.length}`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${models.gemini.image}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      });
      if (!response.ok) {
        const details = await response.text().catch(() => '');
        throw new Error(`Gemini Image HTTP ${response.status}: ${details.slice(0, 250)}`);
      }
      const data = await response.json();
      const image = data?.candidates?.[0]?.content?.parts?.find((part) => part.inlineData && part.inlineData.data);
      if (!image) throw new Error('Gemini não retornou dados de imagem.');
      log('CAPA - Gemini', `Imagem pronta com a chave #${keyIndex + 1}.`);
      return {
        bytes: Buffer.from(image.inlineData.data, 'base64'),
        mimeType: image.inlineData.mimeType || 'image/png',
      };
    } catch (error) {
      lastError = error;
      log('CAPA - Gemini', `Falha na chave #${keyIndex + 1}: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Todas as chaves Gemini falharam para a capa. ${lastError ? lastError.message : ''}`);
}

const CALLERS = {
  openrouter: callOpenRouterOnce,
  cloudflare: callCloudflareOnce,
  gemini: callGeminiOnce,
  groq: callGroqOnce,
  mistral: callMistralOnce,
};

// -----------------------------------------------------------------------
// Motor de resiliência TOTAL: intercala 1 chave de cada provedor por vez
// (Gemini, depois Groq, depois Mistral, depois OpenRouter, depois
// Cloudflare, e volta pro Gemini de novo) em vez de esgotar um provedor
// inteiro antes de tentar o próximo. Assim, se uma IA estiver com
// problema, o sistema já tenta outra rapidinho. Só se todas as chaves
// falharem na mesma rodada é que o sistema faz uma pausa técnica de 10s e
// tenta tudo de novo. Depois de MAX_GLOBAL_ROUNDS rodadas sem sucesso,
// desiste deste bloco de forma controlada (nunca trava para sempre).
// -----------------------------------------------------------------------
// Monta uma fila intercalada: 1 chave de cada provedor por vez, dando a
// volta — em vez de esgotar todas as chaves de um provedor antes de tentar
// o próximo. Assim, se uma IA estiver com problema, o sistema já tenta
// outra rapidinho, sem "insistir" nas 6+ chaves da mesma primeiro.
function buildInterleavedQueue(providerOrder) {
  const providerPools = providerOrder
    .map((provider) => {
      const pool = pools[provider];
      if (!pool || pool.length === 0) return null;
      const startIndex = nextStartIndex(provider);
      return { provider, pool, startIndex };
    })
    .filter(Boolean);

  const maxLen = providerPools.reduce((max, p) => Math.max(max, p.pool.length), 0);
  const queue = [];
  for (let offset = 0; offset < maxLen; offset += 1) {
    for (const { provider, pool, startIndex } of providerPools) {
      if (offset < pool.length) {
        const keyIndex = (startIndex + offset) % pool.length;
        queue.push({ provider, keyIndex, poolSize: pool.length, apiKey: pool[keyIndex] });
      }
    }
  }
  return queue;
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

async function callWithFullResilience(providerOrder, promptInput, roleLabel, complexity = 'standard') {
  const originalPrompt = typeof promptInput === 'string'
    ? { system: '', user: promptInput }
    : { system: promptInput.system || '', user: promptInput.user || '' };
  const prompt = {
    system: normalizePromptText(originalPrompt.system).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''),
    user: normalizePromptText(originalPrompt.user).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''),
  };
  const beforeTokens = estimateTokens(originalPrompt.system + originalPrompt.user);
  const afterTokens = estimateTokens(prompt.system + prompt.user);
  log(roleLabel, `Prompt normalizado: estimativa ${beforeTokens} -> ${afterTokens} tokens; economia ${Math.max(0, beforeTokens - afterTokens)} (aproximada).`);
  let lastError = null;
  const firstErrorPerProvider = {};
  const totalKeys = providerOrder.reduce((sum, p) => sum + ((pools[p] && pools[p].length) || 0), 0);
  if (totalKeys === 0) {
    throw new Error('Nenhuma chave de IA configurada. O fallback local continuará a geração.');
  }

  for (let round = 1; round <= MAX_GLOBAL_ROUNDS; round += 1) {
    const queue = buildInterleavedQueue(providerOrder);

    for (const { provider, keyIndex, poolSize, apiKey } of queue) {
      const caller = CALLERS[provider];
      try {
        log(roleLabel, `Tentando ${provider} chave #${keyIndex + 1}/${poolSize} (rodada ${round}/${MAX_GLOBAL_ROUNDS})`);
        const model = models[provider][complexity] || models[provider].standard;
        const result = await caller(apiKey, prompt, model);
        log(roleLabel, `Sucesso com ${provider} chave #${keyIndex + 1} na rodada ${round}.`);
        return result;
      } catch (error) {
        lastError = error;
        if (!firstErrorPerProvider[provider]) firstErrorPerProvider[provider] = error.message;
        log(roleLabel, `Falha em ${provider} chave #${keyIndex + 1}: ${error.message}. Intercalando para o próximo provedor.`);
      }
    }

    if (round >= MAX_GLOBAL_ROUNDS) break;

    // Todas as chaves configuradas falharam nesta rodada.
    log(
      roleLabel,
      `As ${totalKeys} chaves falharam na rodada ${round} (último erro: ${
        lastError ? lastError.message : 'desconhecido'
      }). Pausa técnica de ${TECHNICAL_PAUSE_MS / 1000}s antes de tentar novamente.`
    );
    await sleep(TECHNICAL_PAUSE_MS);
  }

  // Esgotou as rodadas com as chaves configuradas: desiste deste bloco de
  // forma controlada, mostrando o erro real de CADA provedor (não só o
  // último), para dar diagnóstico de verdade em vez de mensagem genérica.
  if (totalKeys === 0) {
    throw new Error('Nenhuma chave de IA configurada. Cadastre as chaves em Environment no Render (GEMINI_KEY_1, GROQ_KEY_1, MISTRAL_KEY_1...).');
  }

  const providerDetails = Object.entries(firstErrorPerProvider)
    .map(([provider, msg]) => `${provider.toUpperCase()}: ${msg}`)
    .join(' | ');

  const finalError = new Error(
    `As ${totalKeys} chaves configuradas falharam na etapa "${roleLabel}". Detalhe por provedor -> ${providerDetails || 'sem detalhes'}`
  );
  finalError.retryable = true;
  throw finalError;
}

// -----------------------------------------------------------------------
// Construtores de prompt dinâmicos por etapa, adaptados a niche/tone/audience
// -----------------------------------------------------------------------

function buildArchitectPrompt(params, localDraft) {
  const { bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext, bookDescription, blocksPerChapter, language, allChapterTitles, researchContext, bookStateSummary } = params;
  const references = compressReferenceText(researchContext, `${niche} ${chapterTitle}`, 3600);
  const recent = compressReferenceText(recentContext, chapterTitle, 900);
  const bookState = compressReferenceText(bookStateSummary, `${bookTitle} ${chapterTitle}`, 900);
  const otherChapters = Array.isArray(allChapterTitles) ? allChapterTitles.filter((title) => title !== chapterTitle) : [];
  return {
    system: STATIC_PROMPTS.architect,
    user: `LIVRO: "${bookTitle}" (${language || 'português do Brasil'})\nNICHO: ${niche}\nPÚBLICO: ${targetAudience}\nTOM: ${tone}\n${bookDescription ? `DESCRIÇÃO: ${bookDescription}\n` : ''}CAPÍTULO: "${chapterTitle}"\nBLOCO: ${blockNumber} de ${blocksPerChapter || 6}.\n${otherChapters.length ? `OUTROS CAPÍTULOS: ${otherChapters.join(' | ')}\n` : ''}${bookState ? `RESUMO DOS CAPÍTULOS ANTERIORES:\n${bookState}\n` : ''}${references ? `MICRO-FRAGMENTOS DE PESQUISA:\n${references}\n` : ''}CONTEXTO RECENTE DO CAPÍTULO:\n${recent || '(nenhum)'}\n\nESQUELETO E RASCUNHO LOCAL:\n${localDraft}\n\nDesenvolva este bloco em cerca de 300 palavras, com profundidade, exemplos e aplicação prática. Não repita outros capítulos. Escreva somente o texto corrido, sem título ou número do bloco.`,
  };
}

function buildRefineAndHumanizePrompt({ bookTitle, chapterTitle, niche, targetAudience, tone, draftText }) {
  return {
    system: STATIC_PROMPTS.polish,
    user: `LIVRO: "${bookTitle}"\nCAPÍTULO: "${chapterTitle}"\nNICHO: ${niche}\nPÚBLICO: ${targetAudience}\nTOM: ${tone}\n\nTEXTO PARA REVISAR:\n${normalizePromptText(draftText)}\n\nRevise a cadência e a fluidez sem retirar informação, exemplos ou ideias do texto.`,
  };
}

// -----------------------------------------------------------------------
// Orquestrador: esqueleto local, Arquiteto Denso e polimento final.
// -----------------------------------------------------------------------
async function generateBlock(params) {
  const { bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext, bookDescription, researchContext, bookStateSummary, bookStateSourceChars } = params;
  const localDraft = buildLocalDraft(params);
  const architectPrompt = buildArchitectPrompt(params, localDraft);
  log('FASE LOCAL', `Esqueleto local do bloco ${blockNumber} pronto antes das chamadas de IA.`);
  const rawHistoryTokens = estimateTokens(bookStateSourceChars || 0);
  const summaryTokens = estimateTokens(bookStateSummary || '');
  log('ECONOMIA DE CONTEXTO', `Histórico bruto estimado ${rawHistoryTokens} tokens; resumo enviado ${summaryTokens}; economia aproximada ${Math.max(0, rawHistoryTokens - summaryTokens)} tokens.`);
  const complexity = classifyChapterComplexity(params);
  let denseDraft = localDraft;
  try {
    denseDraft = await callWithFullResilience(
      providerOrderFor('chapter-draft', 'standard'),
      architectPrompt,
      'ETAPA 1 - Arquiteto Denso',
      'standard'
    );
  } catch (error) {
    log('FALLBACK LOCAL', `Arquiteto indisponível; usando rascunho local para manter o bloco: ${error.message}`);
  }

  let finalText = denseDraft;
  try {
    const refineAndHumanizePrompt = buildRefineAndHumanizePrompt({
      bookTitle,
      chapterTitle,
      niche,
      targetAudience,
      tone,
      draftText: denseDraft,
    });
    finalText = await callWithFullResilience(
      providerOrderFor('chapter-refine', complexity),
      refineAndHumanizePrompt,
      `ETAPA 2 - Refino + Humanização (${complexity})`,
      complexity
    );
  } catch (error) {
    log('FALLBACK LOCAL', `Refinador indisponível; mantendo o texto já preparado para não interromper o bloco: ${error.message}`);
  }

  return {
    blockNumber,
    text: finalText,
    wordCount: finalText.split(/\s+/).filter(Boolean).length,
  };
}

// -----------------------------------------------------------------------
// Fase 0: estrutura completa local, antes de qualquer chamada de IA.
// -----------------------------------------------------------------------
async function generateOutline({ bookTitle, niche, targetAudience, tone, numChapters, language }) {
  return buildLocalOutline({ bookTitle, niche, targetAudience, tone, numChapters, language });
}

async function refineOutline({ bookTitle, niche, targetAudience, tone, numChapters, language, chapters, researchContext }) {
  const fallback = { chapters };
  const prompt = {
    system: STATIC_PROMPTS.outline,
    user: `Título: ${bookTitle}\nNicho: ${niche}\nPúblico: ${targetAudience}\nTom: ${tone}\nIdioma: ${language || 'português do Brasil'}\nReferências pesquisadas antes desta chamada:\n${compressReferenceText(researchContext, `${niche} ${bookTitle}`, 1000)}\n\nEsqueleto local inicial:\n${chapters.map((chapter, index) => `${index + 1}. ${chapter}`).join('\n')}\n\nMelhore o subtítulo, a descrição (duas ou três frases) e os títulos, mantendo exatamente ${numChapters} capítulos em progressão lógica. Responda neste formato JSON: {"subtitle":"...","description":"...","chapters":["..."]}.`,
  };

  try {
    const raw = await callWithFullResilience(
      providerOrderFor('outline', 'standard'),
      prompt,
      'ESBOÇO - Sumário',
      'standard'
    );
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }
    if (!parsed || !Array.isArray(parsed.chapters) || parsed.chapters.length !== numChapters || parsed.chapters.some((title) => typeof title !== 'string' || !title.trim())) {
      throw new Error('A resposta do sumário não contém o número esperado de capítulos.');
    }

    const chapters = parsed.chapters.map((title) => title.trim());
    const localContextByChapter = Object.fromEntries(chapters.map((chapterTitle) => [
      chapterTitle,
      findLocalReferences(__dirname, `${bookTitle} ${niche} ${targetAudience}`, chapterTitle).context,
    ]));
    return {
      subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      chapters,
      localContextByChapter,
    };
  } catch (error) {
    log('ESBOÇO - Sumário', `Usando esqueleto local após falha ou JSON inválido: ${error.message}`);
    return fallback;
  }
}

module.exports = {
  generateBlock,
  generateOutline,
  refineOutline,
  generateCoverImageWithGemini,
  callWithFullResilience,
  pools,
};
