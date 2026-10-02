'use strict';

const { fetchJson } = require('../httpUtil');

async function search(query, options = {}) {
  const limit = Math.min(5, Math.max(1, Number(options.limit) || 3));
  const params = new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), format: 'json' });
  const data = await fetchJson(`https://pt.wikisource.org/w/api.php?${params.toString()}`);
  return (data.query && data.query.search || []).map((hit) => ({
    information: `Texto em domínio público ou com licença aberta: "${hit.title}". Resultado de pesquisa do Wikisource em português.`,
    source: 'Wikisource PT',
    url: `https://pt.wikisource.org/wiki/${encodeURIComponent(String(hit.title || '').replace(/ /g, '_'))}`,
    topic: hit.title,
    date: null,
    license: 'Verificar a situação de direitos na página da obra',
  }));
}

module.exports = { name: 'wikisource-pt', search };