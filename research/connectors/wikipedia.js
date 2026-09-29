'use strict';

const { fetchJson } = require('../httpUtil');

/**
 * Conector Wikipedia. API pública, sem chave. Busca páginas relevantes e
 * traz o resumo (extract) de cada uma.
 */
async function search(query, options = {}) {
  const lang = options.lang || 'pt';
  const limit = options.limit || 4;

  const searchUrl =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=` +
    `${encodeURIComponent(query)}&format=json&srlimit=${limit}&origin=*`;

  const searchData = await fetchJson(searchUrl);
  const hits = (searchData?.query?.search || []).slice(0, limit);
  if (hits.length === 0) return [];

  const titles = hits.map((h) => h.title).join('|');
  const summaryUrl =
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&` +
    `titles=${encodeURIComponent(titles)}&format=json&origin=*`;

  const summaryData = await fetchJson(summaryUrl);
  const pages = summaryData?.query?.pages || {};

  return Object.values(pages)
    .filter((p) => p.extract && p.extract.trim().length > 30)
    .map((p) => ({
      information: p.extract.trim(),
      source: 'Wikipedia',
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
      topic: p.title,
      date: null,
      license: 'CC BY-SA 4.0',
    }));
}

module.exports = { name: 'wikipedia', search };
