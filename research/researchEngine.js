'use strict';

/**
 * researchEngine.js
 * ---------------------------------------------------------------------------
 * Orquestrador do Research Engine. Fluxo (igual ao especificado):
 *
 *   pergunta -> conectores (em paralelo) -> limpeza -> deduplicação ->
 *   pontuação de relevância -> seleção dentro do orçamento de tokens ->
 *   contexto enxuto para a IA
 *
 * Cada conector é independente: se um falhar, os outros continuam
 * normalmente (Promise.allSettled, nunca Promise.all). O resultado final
 * fica em cache (research/cache.js), então a mesma pergunta não dispara
 * pesquisa de novo enquanto o cache for válido.
 * ---------------------------------------------------------------------------
 */

const cache = require('./cache');
const { dedupe } = require('./dedupe');
const { scoreRelevance } = require('./relevance');

const connectors = [
  require('./connectors/wikipedia'),
  require('./connectors/wikidata'),
  require('./connectors/openalex'),
  require('./connectors/crossref'),
  require('./connectors/openlibrary'),
  require('./connectors/googlebooks'),
  require('./connectors/gutenberg'),
  require('./connectors/wikisource-pt'),
  require('./connectors/wikisource-global'),
  require('./connectors/internetarchive'),
  require('./connectors/europeana'), // pula sozinho se não tiver EUROPEANA_API_KEY
];

// Orçamento de tokens do contexto final enviado à IA (bem menor que enviar
// tudo bruto — essa é a economia real que o projeto pede para medir).
const DEFAULT_TOKEN_BUDGET = 900;
const MIN_ITEMS_TO_CONSIDER_SUFFICIENT = 2;

// Estimativa simples de tokens (não é exata, mas não precisa ser — é usada
// só para comparar "antes" e "depois", e para não estourar o orçamento).
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function formatContext(selected) {
  if (selected.length === 0) return '';
  const lines = selected.map((item) => `- ${item.information} [Fonte: ${item.source}]`);
  return (
    'INFORMAÇÕES PESQUISADAS (use como apoio factual, mas escreva com suas próprias palavras — não copie):\n' +
    lines.join('\n')
  );
}

function selectWithinBudget(items, tokenBudget) {
  const selected = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(item.information);
    if (used + cost > tokenBudget && selected.length > 0) break;
    selected.push(item);
    used += cost;
    if (used >= tokenBudget) break;
  }
  return selected;
}

/**
 * Pesquisa um tópico/capítulo em todas as fontes conectadas, limpa,
 * deduplica, pontua e devolve um contexto enxuto pronto para a IA.
 *
 * @param {Object} params
 * @param {string} params.topic - assunto geral do livro (ex: "finanças pessoais")
 * @param {string} params.chapterTitle - título do capítulo atual
 * @param {number} [params.tokenBudget] - limite de tokens do contexto final
 * @returns {Promise<{context: string, sources: Array, stats: Object}>}
 */
async function research({ topic, chapterTitle, tokenBudget }) {
  const query = [chapterTitle, topic].filter(Boolean).join(' — ');
  const cacheKey = ['research:v1', topic, chapterTitle];

  const cached = cache.get(cacheKey);
  if (cached) {
    return { ...cached, stats: { ...cached.stats, cacheHit: true } };
  }

  const budget = tokenBudget || DEFAULT_TOKEN_BUDGET;
  const sourceStats = {};

  const settled = await Promise.allSettled(connectors.map(async (connector) => {
    console.log(`[busca-global] Buscando em ${connector.name}...`);
    const items = await connector.search(query);
    console.log(`[busca-global] ${connector.name}: ${items.length} resultados.`);
    return items;
  }));

  let rawItems = [];
  for (let i = 0; i < connectors.length; i += 1) {
    const name = connectors[i].name;
    const result = settled[i];
    if (result.status === 'fulfilled') {
      sourceStats[name] = { found: result.value.length, error: null };
      rawItems.push(...result.value);
    } else {
      sourceStats[name] = { found: 0, error: result.reason ? result.reason.message : 'falhou' };
      console.warn(`[busca-global] ${name}: indisponível (${sourceStats[name].error}).`);
    }
  }

  // Limpeza básica: remove itens vazios ou curtos demais para serem úteis.
  rawItems = rawItems.filter((it) => it && it.information && it.information.trim().length >= 25);
  const foundCount = rawItems.length;

  const { items: dedupedItems, duplicateCount } = dedupe(rawItems);

  const scoredItems = scoreRelevance(dedupedItems, topic, chapterTitle).sort((a, b) => b.relevance - a.relevance);

  const selected = selectWithinBudget(scoredItems, budget);
  const context = formatContext(selected);

  const tokensBeforeRaw = estimateTokens(rawItems.map((i) => i.information).join(' '));
  const tokensAfter = estimateTokens(context);
  const savingsPercent = tokensBeforeRaw > 0 ? Math.round((1 - tokensAfter / tokensBeforeRaw) * 100) : 0;

  const sufficient = selected.length >= MIN_ITEMS_TO_CONSIDER_SUFFICIENT;

  const result = {
    context,
    sources: selected.map((it) => ({
      source: it.source,
      url: it.url,
      topic: it.topic,
      relevance: Math.round(it.relevance * 100) / 100,
      confirmedBy: it.confirmedBy || [it.source],
    })),
    stats: {
      query,
      sourcesQueried: connectors.length,
      sourceStats,
      resultsFound: foundCount,
      duplicatesRemoved: duplicateCount,
      selectedCount: selected.length,
      discardedCount: dedupedItems.length - selected.length,
      tokensBeforeRaw,
      tokensAfter,
      savingsPercent,
      sufficient,
      cacheHit: false,
    },
  };

  cache.set(cacheKey, result);

  console.log(
    `[research-engine] "${query}" -> ${foundCount} encontrados, ${duplicateCount} duplicados removidos, ` +
      `${selected.length} selecionados, ${tokensBeforeRaw}->${tokensAfter} tokens (${savingsPercent}% de economia).`
  );
  console.log('[busca-global] Esqueleto apoiado por acervos públicos modelado com sucesso.');

  return result;
}

function cacheStats() {
  return cache.stats();
}

module.exports = { research, cacheStats, connectors };
