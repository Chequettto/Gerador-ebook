'use strict';

const { fetchJson } = require('../httpUtil');

async function search(query, options = {}) {
  const limit = Math.min(5, Math.max(1, Number(options.limit) || 3));
  const params = new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), format: 'json' });
  const data = await fetchJson(`https://en.wikisource.org/w/api.php?${params.toString()}`);
  return (data.query && data.query.search || []).map((hit) => ({
    information: `Open text result: "${hit.title}". Search result from English Wikisource.`,
    source: 'Wikisource Global',
    url: `https://en.wikisource.org/wiki/${encodeURIComponent(String(hit.title || '').replace(/ /g, '_'))}`,
    topic: hit.title,
    date: null,
    license: 'Verify public-domain or open-license status on the source page',
  }));
}

module.exports = { name: 'wikisource-global', search };