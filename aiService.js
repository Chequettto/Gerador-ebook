'use strict';

/**
 * aiService.js
 * ---------------------------------------------------------------------------
 * Esteira DUPLA sequencial para geração de blocos de e-book (reduzida de 3
 * para 2 chamadas de IA por bloco, para render ~33% mais textos por dia
 * dentro das cotas grátis):
 *
 *   ETAPA 1 -> "O Arquiteto Denso"                    (preferência: Gemini, depois Groq, depois Mistral)
 *   ETAPA 2 -> "Refino de Cadência + Humanização"      (preferência: Groq, depois Mistral, depois Gemini)
 *
 * As 18 chaves (6 Gemini + 6 Groq + 6 Mistral, de 18 contas diferentes) são
 * UM ÚNICO ANEL de resiliência: se as 6 chaves do provedor preferido de uma
 * etapa falharem (cota esgotada, 429, 500, timeout), o sistema passa a usar
 * as chaves dos outros dois provedores para realizar aquele mesmo trabalho.
 * Só se as 18 chaves falharem na mesma rodada é que o serviço faz uma PAUSA
 * TÉCNICA de 10s e tenta tudo de novo, por até 3 rodadas — depois disso,
 * desiste do bloco de forma controlada (avisando "tente mais tarde") em vez
 * de travar para sempre.
 * ---------------------------------------------------------------------------
 */

const fetch = require('node-fetch');

const REQUEST_TIMEOUT_MS = 15_000; // timeout individual por chamada (AbortController)
const TECHNICAL_PAUSE_MS = 10_000; // pausa técnica quando as 18 chaves falham numa rodada
const MAX_GLOBAL_ROUNDS = 3; // rodadas completas pelas 18 chaves antes de desistir deste bloco

// -----------------------------------------------------------------------
// Clichês de IA a eliminar na Etapa 3 (usados no prompt do Humanizador)
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

// -----------------------------------------------------------------------
// Pools de chaves (18 no total, 6 por provedor)
// -----------------------------------------------------------------------
// Quantas chaves cada provedor pode ter, no máximo (ex: GEMINI_KEY_1..40).
// Gemini e Groq normalmente usam poucas (6), mas o Mistral pode ter muitas
// mais (ex: 31 contas), então o limite é generoso para os três.
const MAX_KEYS_PER_PROVIDER = 40;

function buildPool(prefix) {
  const keys = [];
  for (let i = 1; i <= MAX_KEYS_PER_PROVIDER; i += 1) {
    const value = process.env[`${prefix}_${i}`];
    if (value && value.trim().length > 0) {
      keys.push(value.trim());
    }
  }
  return keys;
}

const pools = {
  gemini: buildPool('GEMINI_KEY'),
  groq: buildPool('GROQ_KEY'),
  mistral: buildPool('MISTRAL_KEY'),
};

// Cursor de rotação independente por provedor, para distribuir carga entre chamadas
const rotationCursor = { gemini: 0, groq: 0, mistral: 0 };

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

// -----------------------------------------------------------------------
// Chamadores HTTP de cada provedor (uma tentativa, uma chave, com timeout)
// -----------------------------------------------------------------------

async function callGeminiOnce(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
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

async function callGroqOnce(apiKey, prompt) {
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
        model: 'openai/gpt-oss-120b',
        temperature: 0.85,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
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

async function callMistralOnce(apiKey, prompt) {
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
        model: 'mistral-small-latest',
        temperature: 0.8,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
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

const CALLERS = {
  gemini: callGeminiOnce,
  groq: callGroqOnce,
  mistral: callMistralOnce,
};

// -----------------------------------------------------------------------
// Motor de resiliência TOTAL: para cada etapa, tenta primeiro o provedor
// preferido (percorrendo suas 6 chaves) e, se todas falharem, passa para o
// PRÓXIMO PROVEDOR (as outras 6 chaves), e depois o terceiro — usando as
// 18 chaves como um único anel, não 3 anéis isolados. Só se as 18 chaves
// falharem na mesma rodada é que o sistema faz uma pausa técnica de 10s e
// tenta tudo de novo. Depois de MAX_GLOBAL_ROUNDS rodadas sem sucesso,
// desiste deste bloco de forma controlada (nunca trava para sempre).
// -----------------------------------------------------------------------
async function callWithFullResilience(providerOrder, prompt, roleLabel) {
  let lastError = null;
  const firstErrorPerProvider = {};

  for (let round = 1; round <= MAX_GLOBAL_ROUNDS; round += 1) {
    for (const provider of providerOrder) {
      const pool = pools[provider];
      const caller = CALLERS[provider];
      if (!pool || pool.length === 0) {
        if (!firstErrorPerProvider[provider]) firstErrorPerProvider[provider] = 'nenhuma chave configurada';
        continue; // provedor sem chaves configuradas, pula
      }

      const startIndex = nextStartIndex(provider);
      for (let offset = 0; offset < pool.length; offset += 1) {
        const keyIndex = (startIndex + offset) % pool.length;
        const apiKey = pool[keyIndex];
        try {
          log(roleLabel, `Tentando ${provider} chave #${keyIndex + 1}/${pool.length} (rodada ${round}/${MAX_GLOBAL_ROUNDS})`);
          const result = await caller(apiKey, prompt);
          log(roleLabel, `Sucesso com ${provider} chave #${keyIndex + 1} na rodada ${round}.`);
          return result;
        } catch (error) {
          lastError = error;
          if (!firstErrorPerProvider[provider]) firstErrorPerProvider[provider] = error.message;
          log(roleLabel, `Falha em ${provider} chave #${keyIndex + 1}: ${error.message}.`);
        }
      }
      log(roleLabel, `Todas as chaves de ${provider} falharam. Passando para o próximo provedor disponível.`);
    }

    if (round >= MAX_GLOBAL_ROUNDS) break;

    // As 18 chaves falharam nesta rodada.
    log(
      roleLabel,
      `As 18 chaves falharam na rodada ${round} (último erro: ${
        lastError ? lastError.message : 'desconhecido'
      }). Pausa técnica de ${TECHNICAL_PAUSE_MS / 1000}s antes de tentar novamente.`
    );
    await sleep(TECHNICAL_PAUSE_MS);
  }

  // Esgotou as rodadas com as 18 chaves: desiste deste bloco de forma controlada,
  // mostrando o erro real de CADA provedor (não só o último), para dar
  // diagnóstico de verdade em vez de uma mensagem genérica de "sem cota".
  const providerDetails = Object.entries(firstErrorPerProvider)
    .map(([provider, msg]) => `${provider.toUpperCase()}: ${msg}`)
    .join(' | ');

  const finalError = new Error(
    `As 18 chaves falharam na etapa "${roleLabel}". Detalhe por provedor -> ${providerDetails || 'sem detalhes'}`
  );
  finalError.retryable = true;
  throw finalError;
}

// -----------------------------------------------------------------------
// Construtores de prompt dinâmicos por etapa, adaptados a niche/tone/audience
// -----------------------------------------------------------------------

function buildArchitectPrompt({ bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext, bookDescription, blocksPerChapter, language, allChapterTitles }) {
  const lang = language || 'português do Brasil';
  const otherChapters = Array.isArray(allChapterTitles)
    ? allChapterTitles.filter((t) => t !== chapterTitle)
    : [];
  return `Você é um autor especialista em "${niche}", escrevendo um e-book profissional chamado "${bookTitle}", em ${lang}.
${bookDescription ? `\nSOBRE O LIVRO: ${bookDescription}\n` : ''}
CAPÍTULO ATUAL: "${chapterTitle}"
BLOCO: ${blockNumber} de ${blocksPerChapter || 6} (aproximadamente 300 palavras neste bloco)
PÚBLICO-ALVO: ${targetAudience}
TOM DESEJADO: ${tone}
${otherChapters.length > 0 ? `\nOUTROS CAPÍTULOS DO MESMO LIVRO (não repita o conteúdo específico deles aqui — cada capítulo deve trazer algo NOVO):\n${otherChapters.map((t) => `- ${t}`).join('\n')}\n` : ''}
CONTEXTO RECENTE (o que já foi escrito nos blocos anteriores deste capítulo, para dar continuidade sem repetir):
"""
${recentContext || '(Este é o primeiro bloco do capítulo — não há contexto anterior.)'}
"""

TAREFA:
Escreva o conteúdo bruto e denso deste bloco, com profundidade real de conteúdo (não superficial), trazendo exemplos, raciocínios e informação de valor prático sobre "${niche}" para o público "${targetAudience}". Foque SÓ no que é específico do capítulo atual — não repita estratégias, exemplos ou personagens fictícios que já caberiam melhor em outro capítulo da lista acima. Se usar um exemplo com nome de pessoa, varie o nome a cada capítulo (não reutilize sempre os mesmos nomes). Mantenha continuidade natural com o contexto anterior, sem repetir o que já foi dito. Não use marcação markdown (sem **, #, _) — escreva em texto puro. Não escreva título do capítulo nem numeração de bloco — apenas o texto corrido. Extensão alvo: cerca de 300 palavras.`;
}

function buildRefineAndHumanizePrompt({ bookTitle, chapterTitle, niche, targetAudience, tone, draftText }) {
  return `Você é um editor executivo especialista em ritmo narrativo E em dar voz humana e autêntica a textos, removendo qualquer traço de escrita robótica de IA. Recebeu um rascunho denso para o e-book "${bookTitle}", capítulo "${chapterTitle}" (nicho: ${niche}; público: ${targetAudience}; tom: ${tone}).

RASCUNHO BRUTO:
"""
${draftText}
"""

TAREFA (faça as duas coisas no mesmo texto, numa única reescrita):
1. REESTRUTURE a métrica, o ritmo e a fluidez narrativa: alterne frases curtas e diretas com frases explicativas mais longas, criando uma cadência de leitura natural e envolvente, como um autor humano experiente escreveria.
2. ELIMINE COMPLETAMENTE clichês típicos de IA, incluindo (mas não se limitando a): ${AI_CLICHES.map((c) => `"${c}"`).join(', ')}. Substitua por transições e conectores naturais, variados, próprios de um autor humano especialista escrevendo no tom "${tone}".

Preserve 100% do conteúdo, exemplos e ideias do rascunho original — não corte informação. Não adicione título, comentários ou explicações sobre o que você fez — devolva apenas o texto final, pronto para publicação.`;
}

// -----------------------------------------------------------------------
// Orquestrador principal: roda 2 etapas em sequência para 1 bloco
// (rascunho denso -> refino de cadência + humanização juntos, numa só
// chamada, para render bem mais textos por dia nas cotas grátis).
// -----------------------------------------------------------------------
async function generateBlock(params) {
  const { bookTitle, chapterTitle, blockNumber, niche, targetAudience, tone, recentContext, bookDescription, blocksPerChapter, language, allChapterTitles } = params;

  // ETAPA 1 — "O Arquiteto Denso" (rascunho bruto e denso)
  const architectPrompt = buildArchitectPrompt({
    bookTitle,
    chapterTitle,
    blockNumber,
    niche,
    targetAudience,
    tone,
    recentContext,
    bookDescription,
    blocksPerChapter,
    language,
    allChapterTitles,
  });
  const draftText = await callWithFullResilience(
    ['gemini', 'groq', 'mistral'],
    architectPrompt,
    'ETAPA 1 - Arquiteto Denso'
  );

  // ETAPA 2 — "Refino de Cadência + Humanização Executiva" (uma só chamada)
  const refineAndHumanizePrompt = buildRefineAndHumanizePrompt({
    bookTitle,
    chapterTitle,
    niche,
    targetAudience,
    tone,
    draftText,
  });
  const finalText = await callWithFullResilience(
    ['groq', 'mistral', 'gemini'],
    refineAndHumanizePrompt,
    'ETAPA 2 - Refino + Humanização'
  );

  return {
    blockNumber,
    text: finalText,
    wordCount: finalText.split(/\s+/).filter(Boolean).length,
  };
}

// -----------------------------------------------------------------------
// Esboço automático: a IA decide subtítulo + títulos dos capítulos,
// para a pessoa não precisar digitar nada disso.
// -----------------------------------------------------------------------
async function generateOutline({ bookTitle, niche, targetAudience, tone, numChapters, language }) {
  const lang = language || 'português do Brasil';
  const prompt = `Você é um editor-chefe especialista em "${niche}". Vai planejar a estrutura de um e-book chamado "${bookTitle}", escrito em ${lang}, para o público "${targetAudience}", com tom "${tone}".

TAREFA: Responda APENAS com um JSON válido (sem markdown, sem \`\`\`, sem texto antes ou depois), no formato exato:
{
  "subtitle": "um subtítulo curto e atrativo para o livro",
  "description": "um resumo de 2 a 3 frases sobre do que trata o livro e o que o leitor vai aprender",
  "chapters": ["Título do Capítulo 1", "Título do Capítulo 2", ...]
}

A lista "chapters" deve ter EXATAMENTE ${numChapters} títulos, em ordem lógica de progressão (do básico ao avançado, ou de um problema até a solução completa), específicos para o nicho "${niche}" — nunca genéricos como "Capítulo 1", "Introdução" sozinha, etc.`;

  const raw = await callWithFullResilience(['gemini', 'groq', 'mistral'], prompt, 'ESBOÇO - Sumário Automático');

  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (e2) {
        parsed = null;
      }
    }
  }

  // Anti-falha: se mesmo assim não vier um JSON válido com capítulos, gera um
  // esboço simples localmente (sem IA), para o livro inteiro nunca travar só
  // por causa desta etapa de sumário.
  if (!parsed || !Array.isArray(parsed.chapters) || parsed.chapters.length === 0) {
    log('ESBOÇO - Sumário Automático', 'Resposta da IA não veio em JSON válido. Usando esboço de reserva gerado localmente.');
    const fallbackChapters = [];
    for (let i = 1; i <= numChapters; i += 1) {
      fallbackChapters.push(`Capítulo ${i}: ${niche} — parte ${i}`);
    }
    return {
      subtitle: `Um guia prático sobre ${niche}`,
      description: `Um e-book sobre ${niche}, escrito para ${targetAudience}.`,
      chapters: fallbackChapters,
    };
  }

  return {
    subtitle: parsed.subtitle || '',
    description: parsed.description || '',
    chapters: parsed.chapters.slice(0, numChapters),
  };
}

module.exports = {
  generateBlock,
  generateOutline,
  callWithFullResilience,
  pools,
};
