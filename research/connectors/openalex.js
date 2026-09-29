'use strict';

const { fetchJson } = require('../httpUtil');

/**
 * Conector OpenAlex. API pública, sem chave (recomenda enviar um contato
 * no header "mailto" para acesso mais estável — usamos um genérico).
 * Traz artigos acadêmicos e seus resumos, bons para dados e estudos.
 */
async function search(query, options = {}) {
  const limit = options.limit || 3;
  const url =
    `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${limit}&` +
    `select=title,abstract_inverted_index,publication_year,doi,primary_location`;

  const data = await fetchJson(url);
  const results = data?.results || [];

  return results
    .map((w) => {
      const abstract = invertedIndexToText(w.abstract_inverted_index);
      if (!abstract) return null;
      return {
        information: `${w.title}. ${abstract}`.slice(0, 1200),
        source: 'OpenAlex',
        url: w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : (w.primary_location?.landing_page_url || null),
        topic: w.title,
        date: w.publication_year ? String(w.publication_year) : null,
        license: 'Metadados abertos (OpenAlex)',
      };
    })
    .filter(Boolean);
}

// OpenAlex devolve o resumo como um "índice invertido" (palavra -> posições),
// por questões de direitos autorais. Precisa reconstruir o texto a partir dele.
function invertedIndexToText(invertedIndex) {
  if (!invertedIndex) return null;
  const positions = [];
  for (const [word, idxs] of Object.entries(invertedIndex)) {
    for (const idx of idxs) positions[idx] = word;
  }
  const text = positions.filter(Boolean).join(' ').trim();
  return text.length > 20 ? text : null;
}

module.exports = { name: 'openalex', search };
