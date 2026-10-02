'use strict';

/**
 * coverService.js
 * ---------------------------------------------------------------------------
 * Gera URLs de capas de e-book via Pollinations.ai (modelo FLUX), no formato
 * 800x1200 (proporção 2:3, padrão de e-book), com seed aleatória e regras
 * rígidas contra texto/tipografia na imagem.
 * ---------------------------------------------------------------------------
 */

const COVER_WIDTH = 800;
const COVER_HEIGHT = 1200;

// Regras rígidas anti-texto exigidas na especificação
const NO_TEXT_RULES =
  'no text, no words, no letters, no typography, clean background art, 8k resolution, photorealistic studio lighting';

// Vocabulário visual por nicho, para enriquecer o prompt em inglês
const NICHE_VISUAL_HINTS = {
  financas: 'modern minimalist finance concept, gold and dark navy tones, growth charts as abstract art, coins and light trails',
  'finanças': 'modern minimalist finance concept, gold and dark navy tones, growth charts as abstract art, coins and light trails',
  saude: 'wellness and healthy lifestyle concept, soft natural light, greenery, fresh and clean aesthetic',
  'saúde': 'wellness and healthy lifestyle concept, soft natural light, greenery, fresh and clean aesthetic',
  produtividade: 'organized minimalist workspace concept, clean desk, soft morning light, focus and clarity mood',
  marketing: 'bold modern digital marketing concept, gradient colors, abstract growth arrows, dynamic composition',
  espiritualidade: 'serene spiritual concept, soft golden light, calm atmosphere, ethereal and peaceful mood',
  tecnologia: 'futuristic technology concept, sleek abstract circuitry, blue and purple neon glow, high-tech atmosphere',
  culinaria: 'elegant culinary concept, rustic wooden textures, warm ambient light, appetizing food styling',
  'culinária': 'elegant culinary concept, rustic wooden textures, warm ambient light, appetizing food styling',
  relacionamentos: 'warm emotional concept, soft romantic lighting, intertwined abstract shapes symbolizing connection',
  default: 'sophisticated abstract concept art, elegant color palette, professional studio composition',
};

function pickVisualHint(niche) {
  if (!niche) return NICHE_VISUAL_HINTS.default;
  const key = niche.trim().toLowerCase();
  return NICHE_VISUAL_HINTS[key] || NICHE_VISUAL_HINTS.default;
}

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000);
}

/**
 * Monta o prompt visual em inglês adaptado ao nicho e à preferência de estilo,
 * e retorna a URL direta do Pollinations.ai (modelo FLUX).
 */
function generateCoverUrl({ title, niche, stylePreference }) {
  if (!title || !niche) {
    throw new Error('Os campos "title" e "niche" são obrigatórios para gerar a capa.');
  }

  const visualHint = pickVisualHint(niche);
  const styleClause = stylePreference && stylePreference.trim() ? `, ${stylePreference.trim()} style` : '';

  const promptParts = [
    `professional ebook cover art for a book about "${niche}"`,
    visualHint,
    styleClause.replace(/^, /, ''),
    'editorial cover composition, striking visual focal point, premium bestseller aesthetic',
    NO_TEXT_RULES,
  ].filter(Boolean);

  const prompt = promptParts.join(', ');
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = randomSeed();

  const url =
    `https://image.pollinations.ai/prompt/${encodedPrompt}` +
    `?width=${COVER_WIDTH}&height=${COVER_HEIGHT}&model=flux&seed=${seed}&nologo=true`;

  return {
    url,
    prompt,
    seed,
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    title,
    niche,
  };
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapTitle(value, maxLength = 20) {
  const lines = [];
  let line = '';
  for (const word of String(value || '').split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxLength && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

function generateLocalCoverSvg({ title, subtitle, author, niche }) {
  const titleLines = wrapTitle(title, String(title || '').length > 44 ? 24 : 19);
  const titleFontSize = String(title || '').length > 44 ? 54 : 68;
  const titleY = 420;
  const titleMarkup = titleLines.map((line, index) =>
    `<text x="78" y="${titleY + index * (titleFontSize + 10)}" class="title">${escapeXml(line)}</text>`
  ).join('\n');
  const subtitleY = titleY + titleLines.length * (titleFontSize + 10) + 48;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200" role="img" aria-label="Capa do e-book ${escapeXml(title)}">
  <rect width="800" height="1200" fill="#173b37"/>
  <path d="M0 0H800V250C590 355 365 340 0 475Z" fill="#22534b"/>
  <circle cx="675" cy="248" r="118" fill="#d5ec83" opacity="0.92"/>
  <circle cx="675" cy="248" r="72" fill="#173b37" opacity="0.22"/>
  <path d="M0 920C205 835 490 890 800 770V1200H0Z" fill="#c9573e"/>
  <path d="M0 1000C230 910 510 975 800 860" fill="none" stroke="#f1dfbd" stroke-width="3" opacity="0.75"/>
  <text x="80" y="116" class="kicker">GUIA PRÁTICO</text>
  <text x="80" y="185" class="niche">${escapeXml(niche)}</text>
  <path d="M80 300H225" stroke="#d5ec83" stroke-width="7"/>
  ${titleMarkup}
  ${subtitle ? `<text x="80" y="${Math.min(subtitleY, 830)}" class="subtitle">${escapeXml(subtitle)}</text>` : ''}
  <text x="80" y="1090" class="author">${escapeXml(author || 'Autor')}</text>
  <style>
    .kicker{font:700 20px sans-serif;letter-spacing:2px;fill:#d5ec83}
    .niche{font:400 24px sans-serif;fill:#d9e3da}
    .title{font:600 ${titleFontSize}px Georgia,serif;fill:#fffaf0}
    .subtitle{font:400 25px sans-serif;fill:#173b37}
    .author{font:600 25px sans-serif;fill:#fffaf0}
  </style>
</svg>`;
  return Buffer.from(svg, 'utf8');
}

module.exports = {
  generateCoverUrl,
  generateLocalCoverSvg,
};
