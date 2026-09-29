'use strict';

const { normalize } = require('./dedupe');

/**
 * relevance.js
 * ---------------------------------------------------------------------------
 * Dá uma nota de 0 a 1 para cada informação encontrada, considerando:
 * - quantas palavras do assunto/capítulo aparecem nela;
 * - qualidade da fonte (algumas são mais confiáveis para fatos que outras);
 * - se foi confirmada por mais de uma fonte (dedupe.js já registra isso);
 * - atualidade, quando a informação tem data.
 * ---------------------------------------------------------------------------
 */

// Confiança relativa de cada fonte (0 a 1) — usada só como um "empurrãozinho"
// na nota final, não decide sozinha.
const SOURCE_TRUST = {
  wikidata: 0.9,
  crossref: 0.9,
  openalex: 0.88,
  wikipedia: 0.82,
  openlibrary: 0.75,
  gutenberg: 0.7,
  internetarchive: 0.68,
  europeana: 0.7,
};

function sourceTrust(sourceName) {
  const key = String(sourceName || '').toLowerCase().replace(/\s+/g, '');
  return SOURCE_TRUST[key] ?? 0.6;
}

function scoreRelevance(items, query, chapterTitle) {
  const queryWords = new Set(normalize(`${query} ${chapterTitle || ''}`).split(' ').filter((w) => w.length > 3));

  return items.map((item) => {
    const infoWords = normalize(item.information).split(' ').filter((w) => w.length > 3);
    let overlap = 0;
    for (const w of infoWords) {
      if (queryWords.has(w)) overlap += 1;
    }
    const overlapScore = infoWords.length > 0 ? Math.min(1, overlap / Math.min(6, queryWords.size || 1)) : 0;

    const trustScore = sourceTrust(item.source);

    const confirmedBonus = item.confirmedBy && item.confirmedBy.length > 1 ? 0.15 : 0;

    let recencyScore = 0.5; // neutro quando não há data
    if (item.date) {
      const year = parseInt(item.date, 10);
      if (!Number.isNaN(year)) {
        const age = new Date().getFullYear() - year;
        recencyScore = age <= 5 ? 1 : age <= 15 ? 0.7 : age <= 40 ? 0.5 : 0.3;
      }
    }

    const relevance =
      overlapScore * 0.55 + trustScore * 0.2 + confirmedBonus + recencyScore * 0.1 + 0.0; // resto é folga

    return { ...item, relevance: Math.max(0, Math.min(1, relevance)) };
  });
}

module.exports = { scoreRelevance, sourceTrust };
