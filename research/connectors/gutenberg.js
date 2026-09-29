'use strict';

const { fetchJson } = require('../httpUtil');

/**
 * Conector Project Gutenberg, via Gutendex (API pública gratuita que indexa
 * o acervo do Gutenberg). Traz metadados de livros de domínio público
 * relacionados ao tema — nunca copia o texto do livro, só metadados,
 * respeitando o objetivo de originalidade do gerador.
 */
async function search(query, options = {}) {
  const limit = options.limit || 3;
  const url = `https://gutendex.com/books?search=${encodeURIComponent(query)}`;

  const data = await fetchJson(url);
  const books = (data?.results || []).slice(0, limit);

  return books.map((b) => {
    const authors = (b.authors || []).map((a) => a.name).join(', ');
    return {
      information: `"${b.title}"${authors ? ` — ${authors}` : ''}. Obra de domínio público (${(b.subjects || []).slice(0, 3).join(', ') || 'tema geral'}).`,
      source: 'Project Gutenberg',
      url: `https://www.gutenberg.org/ebooks/${b.id}`,
      topic: b.title,
      date: null,
      license: 'Domínio público',
    };
  });
}

module.exports = { name: 'gutenberg', search };
