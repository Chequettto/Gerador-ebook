'use strict';

const { fetchJson } = require('../httpUtil');

/**
 * Conector Internet Archive. API pública de busca, sem chave.
 */
async function search(query, options = {}) {
  const limit = options.limit || 3;
  const url =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&` +
    `fl[]=identifier&fl[]=title&fl[]=description&fl[]=year&rows=${limit}&output=json`;

  const data = await fetchJson(url);
  const docs = data?.response?.docs || [];

  return docs
    .filter((d) => d.title)
    .map((d) => ({
      information: `"${d.title}"${d.description ? `: ${String(d.description).slice(0, 300)}` : ''}`,
      source: 'Internet Archive',
      url: `https://archive.org/details/${d.identifier}`,
      topic: d.title,
      date: d.year ? String(d.year) : null,
      license: 'Varia por item (ver página do item)',
    }));
}

module.exports = { name: 'internetarchive', search };
