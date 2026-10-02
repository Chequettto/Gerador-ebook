'use strict';

/**
 * httpUtil.js
 * ---------------------------------------------------------------------------
 * Função HTTP compartilhada por todos os conectores do Research Engine:
 * timeout, User-Agent (várias APIs públicas exigem), e tratamento de erro
 * padronizado. Nenhum conector deve usar fetch() direto — todos passam por
 * aqui, para que timeouts e erros se comportem igual em todas as fontes.
 * ---------------------------------------------------------------------------
 */

const fetch = globalThis.fetch;
if (typeof fetch !== 'function') {
  throw new Error('O Research Engine exige o fetch nativo do Node.js 18 ou superior.');
}

const DEFAULT_TIMEOUT_MS = 8000;
const USER_AGENT = 'GeradorEbookResearchEngine/1.0 (uso educacional; contato via operador do sistema)';

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} em ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchJson, USER_AGENT, DEFAULT_TIMEOUT_MS };
