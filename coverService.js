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

module.exports = {
  generateCoverUrl,
};
