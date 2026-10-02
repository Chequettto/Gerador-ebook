'use strict';

const { fetchJson } = require('../httpUtil');

async function search(query, options = {}) {
  const limit = Math.min(5, Math.max(1, Number(options.limit) || 3));
  const fields = 'items(id,volumeInfo(title,authors,publishedDate,categories,description,infoLink,language))';
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${limit}&printType=books&fields=${encodeURIComponent(fields)}`;
  const data = await fetchJson(url);

  return (data.items || []).flatMap((item) => {
    const volume = item.volumeInfo || {};
    if (!volume.title) return [];
    const authors = (volume.authors || []).slice(0, 2).join(', ');
    const categories = (volume.categories || []).slice(0, 3).join(', ');
    const description = String(volume.description || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const details = [
      authors && `Autores: ${authors}`,
      volume.publishedDate && `Publicado: ${volume.publishedDate}`,
      categories && `Categorias: ${categories}`,
      description && `Descrição curta: ${description}`,
    ].filter(Boolean).join('. ');

    return [{
      information: `"${volume.title}"${details ? `. ${details}` : ''}`,
      source: 'Google Books',
      url: volume.infoLink || `https://books.google.com/books?id=${encodeURIComponent(item.id || '')}`,
      topic: volume.title,
      date: volume.publishedDate || null,
      license: 'Metadados públicos; direitos do conteúdo devem ser conferidos na fonte',
    }];
  });
}

module.exports = { name: 'googlebooks', search };