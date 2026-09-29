'use strict';

const { fetchJson } = require('../httpUtil');

/**
 * Conector Wikidata. API pública, sem chave. Traz entidades e suas
 * descrições curtas — bom para fatos objetivos e definições.
 */
async function search(query, options = {}) {
  const lang = options.lang || 'pt';
  const limit = options.limit || 4;

  const url =
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&` +
    `language=${lang}&format=json&limit=${limit}&origin=*`;

  const data = await fetchJson(url);
  const hits = data?.search || [];

  return hits
    .filter((h) => h.description)
    .map((h) => ({
      information: `${h.label}: ${h.description}`,
      source: 'Wikidata',
      url: h.concepturi || `https://www.wikidata.org/wiki/${h.id}`,
      topic: h.label,
      date: null,
      license: 'CC0 (domínio público)',
    }));
}

module.exports = { name: 'wikidata', search };
