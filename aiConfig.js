'use strict';

const MAX_KEYS_PER_PROVIDER = 100;

function buildPool(prefix, singleKeyName) {
  const keys = [];
  if (singleKeyName && process.env[singleKeyName]) keys.push(process.env[singleKeyName].trim());
  for (let index = 1; index <= MAX_KEYS_PER_PROVIDER; index += 1) {
    const value = process.env[`${prefix}_${index}`];
    if (value && value.trim()) keys.push(value.trim());
  }
  return [...new Set(keys)];
}

const pools = {
  gemini: buildPool('GEMINI_KEY'),
  groq: buildPool('GROQ_KEY'),
  mistral: buildPool('MISTRAL_KEY'),
  openrouter: buildPool('OPENROUTER_KEY'),
  cloudflare: process.env.CLOUDFLARE_ACCOUNT_ID ? buildPool('CLOUDFLARE_KEY') : [],
};

const models = {
  gemini: {
    standard: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    complex: process.env.GEMINI_COMPLEX_MODEL || process.env.GEMINI_MODEL || 'gemini-flash-latest',
    image: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
  },
  groq: {
    standard: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    complex: process.env.GROQ_COMPLEX_MODEL || process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  },
  mistral: {
    standard: process.env.MISTRAL_MODEL || 'mistral-small-latest',
    complex: process.env.MISTRAL_COMPLEX_MODEL || process.env.MISTRAL_MODEL || 'mistral-small-latest',
  },
  openrouter: {
    standard: process.env.OPENROUTER_MODEL || 'openrouter/free',
    complex: process.env.OPENROUTER_COMPLEX_MODEL || process.env.OPENROUTER_MODEL || 'openrouter/free',
  },
  cloudflare: {
    standard: process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    complex: process.env.CLOUDFLARE_COMPLEX_MODEL || process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  },
};

const ECONOMICAL_ROUTE = ['cloudflare', 'gemini', 'groq', 'mistral', 'openrouter'];
const COMPLEX_ROUTE = ['mistral', 'gemini', 'groq', 'openrouter', 'cloudflare'];

function classifyChapterComplexity({ niche, targetAudience, tone, bookDescription }) {
  const domain = [niche, bookDescription].filter(Boolean).join(' ').toLowerCase();
  const audience = String(targetAudience || '').toLowerCase();
  const style = [tone, bookDescription].filter(Boolean).join(' ').toLowerCase();
  const technicalDomain = /\b(médic[oa]|clínic[oa]|jurídic[oa]|tributári[oa]|engenharia|cibersegurança|medical|legal|financial|investimentos?)\b/.test(domain);
  const expertAudience = /\b(avançad[oa]s?|especializad[oa]s?|científic[oa]s?|acadêmic[oa]s?|profissionais da área|especialistas)\b/.test(audience);
  const analyticalStyle = /\b(técnic[oa]s?|acadêmic[oa]s?|analític[oa]s?|científic[oa]s?|regulamentação|diagnóstico|modelagem)\b/.test(style);
  return (technicalDomain && (expertAudience || analyticalStyle)) || (expertAudience && analyticalStyle)
    ? 'complex'
    : 'standard';
}

function providerOrderFor(task, complexity = 'standard') {
  if (task === 'chapter-refine' && complexity === 'complex') {
    return [...COMPLEX_ROUTE];
  }
  return [...ECONOMICAL_ROUTE];
}

module.exports = {
  MAX_KEYS_PER_PROVIDER,
  classifyChapterComplexity,
  models,
  pools,
  providerOrderFor,
};