'use strict';

const crypto = require('crypto');

/**
 * dedupe.js
 * ---------------------------------------------------------------------------
 * Remove informações repetidas entre fontes diferentes. Duas camadas:
 * 1) Hash exato — mesmo texto, ignorando maiúsculas/espaços.
 * 2) Similaridade de palavras — textos MUITO parecidos (ex: mesmo fato,
 *    escrito quase igual em duas fontes) também contam como duplicata.
 * Quando duas informações são consideradas duplicatas, mantém a primeira e
 * registra a segunda fonte como "também confirmado por".
 * ---------------------------------------------------------------------------
 */

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contentHash(text) {
  return crypto.createHash('sha1').update(normalize(text)).digest('hex');
}

function wordSet(text) {
  return new Set(normalize(text).split(' ').filter((w) => w.length > 3));
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SIMILARITY_THRESHOLD = 0.72;

function dedupe(items) {
  const kept = [];
  let duplicateCount = 0;

  for (const item of items) {
    const hash = contentHash(item.information);
    const words = wordSet(item.information);

    let matchedExisting = null;
    for (const existing of kept) {
      if (existing._hash === hash) {
        matchedExisting = existing;
        break;
      }
      const sim = jaccardSimilarity(words, existing._words);
      if (sim >= SIMILARITY_THRESHOLD) {
        matchedExisting = existing;
        break;
      }
    }

    if (matchedExisting) {
      duplicateCount += 1;
      if (!matchedExisting.confirmedBy) matchedExisting.confirmedBy = [matchedExisting.source];
      if (!matchedExisting.confirmedBy.includes(item.source)) {
        matchedExisting.confirmedBy.push(item.source);
      }
    } else {
      kept.push({ ...item, _hash: hash, _words: words });
    }
  }

  // Remove os campos internos antes de devolver
  const clean = kept.map(({ _hash, _words, ...rest }) => rest);
  return { items: clean, duplicateCount };
}

module.exports = { dedupe, contentHash, normalize };
