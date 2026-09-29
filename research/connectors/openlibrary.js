'use strict';

const { fetchJson } = require('../httpUtil');

/**
 * Conector Open Library. API pública, sem chave. Traz livros relacionados
 * ao tema — útil para contexto geral e referências bibliográficas, não
 * para copiar conteúdo (nunca traz o texto do livro, só metadados).
 */
async function search(query, options = {}) {
  const limit = options.limit || 3;
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}&fields=title,author_name,first_publish_year,subject,key`;

  const data = await fetchJson(url);
  const docs = data?.docs || [];

  return docs
    .filter((d) => d.title)
    .map((d) => {
      const authors = (d.author_name || []).slice(0, 2).join(', ');
      const subjects = (d.subject || []).slice(0, 4).join(', ');
      return {
        information: `"${d.title}"${authors ? ` — ${authors}` : ''}${d.first_publish_year ? ` (${d.first_publish_year})` : ''}.${subjects ? ` Temas: ${subjects}.` : ''}`,
        source: 'Open Library',
        url: d.key ? `https://openlibrary.org${d.key}` : null,
        topic: d.title,
        date: d.first_publish_year ? String(d.first_publish_year) : null,
        license: 'Metadados abertos (Open Library)',
      };
    });
}

module.exports = { name: 'openlibrary', search };
