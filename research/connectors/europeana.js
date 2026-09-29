'use strict';

const { fetchJson } = require('../httpUtil');

/**
 * Conector Europeana. Exige uma chave de API gratuita (EUROPEANA_API_KEY
 * no Render — grátis em https://apikey.europeana.eu/). Se a chave não
 * estiver configurada, este conector simplesmente não retorna nada (o
 * Research Engine continua normalmente com as outras fontes).
 */
async function search(query, options = {}) {
  const apiKey = process.env.EUROPEANA_API_KEY;
  if (!apiKey) return [];

  const limit = options.limit || 3;
  const url =
    `https://api.europeana.eu/record/v2/search.json?wskey=${apiKey}&query=${encodeURIComponent(query)}&rows=${limit}`;

  const data = await fetchJson(url);
  const items = data?.items || [];

  return items
    .filter((it) => it.title && it.title[0])
    .map((it) => ({
      information: `${it.title[0]}${it.dataProvider ? ` (acervo: ${it.dataProvider[0]})` : ''}`,
      source: 'Europeana',
      url: it.guid || null,
      topic: it.title[0],
      date: it.year ? String(it.year[0]) : null,
      license: it.rights ? it.rights[0] : 'Ver página do item',
    }));
}

module.exports = { name: 'europeana', search };
