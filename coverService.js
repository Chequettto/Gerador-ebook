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
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_TIMEOUT_MS = 7000;
const MAX_COVER_IMAGE_BYTES = 8 * 1024 * 1024;
const { Resvg } = require('@resvg/resvg-js');

const VISUAL_SEARCHES = [
  { pattern: /finan|d[ií]vida|invest|poupan|or[cç]amento/i, searches: ['piggy bank savings', 'personal finance'] },
  { pattern: /sa[uú]de|bem-estar|fitness/i, searches: ['healthy lifestyle nature', 'wellness health'] },
  { pattern: /culin|cozinha|receita/i, searches: ['food cooking ingredients', 'culinary dish'] },
  { pattern: /tecnolog|programa[cç][aã]o|software/i, searches: ['technology computer', 'electronics circuit'] },
  { pattern: /produtividade|organiza[cç][aã]o/i, searches: ['organized desk workspace', 'office workspace'] },
];

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

function wrapCoverText(value, maxLength, maxLines) {
  const lines = wrapTitle(value, maxLength);
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  visible[maxLines - 1] = `${visible[maxLines - 1].replace(/[.,;:]$/, '')}...`;
  return visible;
}

function hasFreeImageLicense(metadata = {}) {
  const license = String(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || '');
  return /public\s*domain|cc0|cc-zero|creative commons zero/i.test(license);
}

function composeCoverSvg({ image, title, subtitle, author, niche }) {
  const titleSize = String(title || '').length > 48 ? 58 : String(title || '').length > 27 ? 68 : 78;
  const titleLineLength = titleSize >= 78 ? 13 : titleSize >= 68 ? 16 : 20;
  const titleLines = wrapCoverText(title, titleLineLength, 3);
  const titleMarkup = titleLines.map((line, index) =>
    `<text x="76" y="${690 + index * (titleSize + 12)}" font-family="DejaVu Serif" font-size="${titleSize}" font-weight="700" fill="#fffdf7">${escapeXml(line)}</text>`
  ).join('\n');
  const subtitleLines = wrapCoverText(subtitle || '', 48, 2);
  const subtitleMarkup = subtitleLines.map((line, index) =>
    `<text x="80" y="${930 + index * 38}" font-family="DejaVu Sans" font-size="26" font-weight="400" fill="#e1e9eb">${escapeXml(line)}</text>`
  ).join('\n');
  const safeNiche = wrapCoverText(niche, 36, 1)[0] || 'E-book';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_WIDTH}" height="${COVER_HEIGHT}" viewBox="0 0 ${COVER_WIDTH} ${COVER_HEIGHT}">
  <defs>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#101b28" stop-opacity=".18"/><stop offset=".4" stop-color="#101b28" stop-opacity=".25"/><stop offset=".72" stop-color="#101b28" stop-opacity=".92"/><stop offset="1" stop-color="#101b28"/></linearGradient>
  </defs>
  <image href="data:${image.mime};base64,${image.bytes.toString('base64')}" width="${COVER_WIDTH}" height="${COVER_HEIGHT}" preserveAspectRatio="xMidYMid slice"/>
  <rect width="${COVER_WIDTH}" height="${COVER_HEIGHT}" fill="url(#shade)"/>
  <path d="M0 0H800V22H0Z" fill="#d5ec83"/>
  <rect x="72" y="78" width="590" height="58" rx="5" fill="#101b28" fill-opacity=".64"/>
  <text x="94" y="116" font-family="DejaVu Sans" font-size="22" font-weight="700" letter-spacing="1.4" fill="#f8fafc">${escapeXml(safeNiche.toUpperCase())}</text>
  <path d="M78 600H194" stroke="#d5ec83" stroke-width="7"/>
  ${titleMarkup}
  ${subtitleMarkup}
  ${author ? `<text x="80" y="1110" font-family="DejaVu Sans" font-size="25" font-weight="700" fill="#d5ec83">${escapeXml(author)}</text>` : ''}
</svg>`;
}

async function requestCommonsJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMONS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'EbookCoverBuilder/1.0 (public-domain cover art)', Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Wikimedia Commons HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function downloadCommonsImage(url, expectedMime) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMONS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Download da imagem HTTP ${response.status}`);
    const mime = String(response.headers.get('content-type') || expectedMime).split(';')[0].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new Error('O resultado do Commons não é uma imagem bitmap compatível.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_COVER_IMAGE_BYTES) throw new Error('O tamanho da imagem do Commons está fora do limite.');
    return { bytes, mime };
  } finally {
    clearTimeout(timer);
  }
}

async function generateCommonsCover({ title, subtitle, author, niche }) {
  const visualSearch = VISUAL_SEARCHES.find(({ pattern }) => pattern.test(niche || ''));
  const searches = [...new Set([
    ...(visualSearch ? [visualSearch.searches[0]] : []),
    `${niche} ${title}`,
    niche,
  ].filter(Boolean))].slice(0, 2);
  let selected = null;
  for (const search of searches) {
    const url = new URL(COMMONS_API);
    url.search = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: search,
      gsrnamespace: '6',
      gsrlimit: '20',
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|mime',
      iiurlwidth: '1400',
      format: 'json',
    });
    const data = await requestCommonsJson(url);
    const candidates = Object.values(data.query?.pages || {})
      .map((page) => ({ page, image: page.imageinfo?.[0] }))
      .filter(({ image }) => image && image.thumburl && ['image/jpeg', 'image/png', 'image/webp'].includes(image.mime) && hasFreeImageLicense(image.extmetadata));
    if (candidates.length) {
      selected = candidates[0];
      break;
    }
  }
  if (!selected) throw new Error('O Wikimedia Commons não encontrou imagem bitmap em domínio público ou CC0 para este tema.');

  const image = await downloadCommonsImage(selected.image.thumburl, selected.image.mime);
  const svg = composeCoverSvg({ image, title, subtitle, author, niche });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: COVER_WIDTH } }).render().asPng();
  const pageTitle = selected.page.title.replace(/^File:/, '').replace(/ /g, '_');
  return {
    bytes: png,
    mimeType: 'image/png',
    source: 'Wikimedia Commons',
    sourceTitle: selected.page.title.replace(/^File:/, ''),
    sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(pageTitle)}`,
    license: selected.image.extmetadata.LicenseShortName?.value || 'Public domain / CC0',
  };
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
  ${author ? `<text x="80" y="1090" class="author">${escapeXml(author)}</text>` : ''}
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
  generateCommonsCover,
  generateLocalCoverSvg,
};
