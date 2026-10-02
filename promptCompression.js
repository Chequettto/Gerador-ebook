'use strict';

const STOP_WORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'entre',
  'essa', 'esse', 'esta', 'este', 'mais', 'mas', 'na', 'nas', 'no', 'nos', 'ou', 'para', 'pela',
  'pelo', 'por', 'que', 'se', 'sem', 'sua', 'suas', 'seu', 'seus', 'um', 'uma', 'the', 'and', 'for', 'with',
]);

function normalizePromptText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/[ ]*\n[ ]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function keywordsFrom(anchors) {
  return normalizePromptText(anchors)
    .toLowerCase()
    .match(/[\p{L}\p{N}]{4,}/gu)
    ?.filter((word) => !STOP_WORDS.has(word)) || [];
}

function compressReferenceText(value, anchors, maxChars = 6000) {
  const text = normalizePromptText(value);
  if (text.length <= maxChars) return text;

  const keywords = [...new Set(keywordsFrom(anchors))];
  const sentences = text.match(/[^.!?\n]+[.!?]?/g) || [text];
  const ranked = sentences
    .map((sentence, index) => {
      const normalized = sentence.trim();
      const lower = normalized.toLowerCase();
      const score = keywords.reduce((total, keyword) => total + (lower.includes(keyword) ? 1 : 0), 0);
      return { index, score, text: normalized };
    })
    .filter((sentence) => sentence.text);

  // Mantém sentenças relacionadas ao capítulo; no desempate, preserva a ordem da fonte.
  const selected = [];
  let size = 0;
  for (const sentence of ranked.sort((left, right) => right.score - left.score || left.index - right.index)) {
    const nextSize = size + sentence.text.length + 1;
    if (nextSize > maxChars) continue;
    selected.push(sentence);
    size = nextSize;
  }

  if (!selected.length) return text.slice(0, maxChars);
  return selected.sort((left, right) => left.index - right.index).map((sentence) => sentence.text).join(' ');
}

function summarizeBookState(chapters, maxChars = 900) {
  const lines = [];
  for (const chapter of chapters || []) {
    if (!chapter || !chapter.content) continue;
    const sentences = normalizePromptText(chapter.content).match(/[^.!?]+[.!?]?/g) || [];
    const first = sentences[0] && sentences[0].trim();
    const last = sentences.length > 1 && sentences[sentences.length - 1].trim();
    const points = [first, last && last !== first ? last : null].filter(Boolean).join(' ');
    lines.push(`${chapter.title}: ${points}`);
  }
  const summary = lines.join('\n');
  return summary.length <= maxChars ? summary : `${summary.slice(0, maxChars - 3).trimEnd()}...`;
}

module.exports = { compressReferenceText, normalizePromptText, summarizeBookState };