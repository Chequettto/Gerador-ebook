'use strict';

const { fetchJson } = require('../httpUtil');

/**
 * Conector Crossref. API pública, sem chave. Traz metadados de artigos
 * científicos (título, autores, ano) — bom para referências e citações.
 * Não traz o texto completo, só metadados confiáveis.
 */
async function search(query, options = {}) {
  const limit = options.limit || 3;
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}`;

  const data = await fetchJson(url);
  const items = data?.message?.items || [];

  return items
    .filter((it) => it.title && it.title[0])
    .map((it) => {
      const authors = (it.author || [])
        .slice(0, 3)
        .map((a) => `${a.given || ''} ${a.family || ''}`.trim())
        .filter(Boolean)
        .join(', ');
      const year = it['published-print']?.['date-parts']?.[0]?.[0] || it['published-online']?.['date-parts']?.[0]?.[0];
      return {
        information: `${it.title[0]}${authors ? ` (${authors}${year ? `, ${year}` : ''})` : ''}.`,
        source: 'Crossref',
        url: it.URL || (it.DOI ? `https://doi.org/${it.DOI}` : null),
        topic: it.title[0],
        date: year ? String(year) : null,
        license: 'Metadados abertos (Crossref)',
      };
    });
}

module.exports = { name: 'crossref', search };
