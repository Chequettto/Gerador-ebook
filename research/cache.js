'use strict';

/**
 * cache.js
 * ---------------------------------------------------------------------------
 * Cache do Research Engine: evita pesquisar a mesma coisa de novo.
 *
 * Guarda em memória (rápido, sempre funciona) E também tenta salvar num
 * arquivo em disco, para sobreviver a reinícios do MESMO processo.
 *
 * AVISO HONESTO: no plano grátis do Render, o disco é apagado sempre que o
 * serviço reinicia de verdade (novo deploy, ou "acordar" depois de dormir
 * por inatividade). Ou seja, esse cache em arquivo ajuda enquanto o
 * servidor está rodando, mas NÃO é permanente entre reinícios completos.
 * Para cache realmente permanente entre reinícios, seria preciso guardar
 * num banco de dados externo (ex: o Supabase que o projeto Lovable já usa)
 * — isso não foi implementado aqui, para não mudar a arquitetura atual.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'research-cache.json');
const TTL_MS = (Number(process.env.RESEARCH_CACHE_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

const memory = new Map();
let loadedFromDisk = false;

function loadFromDisk() {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [key, entry] of Object.entries(parsed)) {
        memory.set(key, entry);
      }
    }
  } catch (e) {
    // Cache corrompido ou disco indisponível — segue só com a memória.
    console.warn('[research-cache] Não foi possível carregar o cache do disco:', e.message);
  }
}

let saveTimer = null;
function saveToDiskDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      const obj = Object.fromEntries(memory.entries());
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
    } catch (e) {
      console.warn('[research-cache] Não foi possível salvar o cache no disco:', e.message);
    }
  }, 500);
}

function makeKey(parts) {
  const raw = Array.isArray(parts) ? parts.join('||') : String(parts);
  return crypto.createHash('sha1').update(raw.toLowerCase().trim()).digest('hex');
}

function get(keyParts) {
  loadFromDisk();
  const key = makeKey(keyParts);
  const entry = memory.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > TTL_MS) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function set(keyParts, value) {
  loadFromDisk();
  const key = makeKey(keyParts);
  memory.set(key, { value, savedAt: Date.now() });
  saveToDiskDebounced();
}

function stats() {
  loadFromDisk();
  return { totalEntries: memory.size, ttlDays: TTL_MS / (24 * 60 * 60 * 1000) };
}

module.exports = { get, set, stats, makeKey };
