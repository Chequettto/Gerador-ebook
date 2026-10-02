'use strict';

const { Pool } = require('pg');

const memoryStore = {
  users: new Map(),
  emailCodes: new Map(),
  sessions: new Map(),
  reservations: new Map(),
  coverAssets: new Map(),
};

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      statement_timeout: 10000,
    })
  : null;

function hasDatabase() {
  return Boolean(pool);
}

function databaseUnavailableError(error) {
  const seen = new Set();
  function walk(node) {
    if (!node || seen.has(node)) return '';
    seen.add(node);

    const message = String(node && node.message ? node.message : node || '');
    if (/DATABASE_URL|ECONNREFUSED|ENOTFOUND|connection.*failed|timeout|pg_|Client has already been ended|connect/i.test(message)) {
      return message;
    }

    if (Array.isArray(node.errors)) {
      for (const item of node.errors) {
        const found = walk(item);
        if (found) return found;
      }
    }

    if (node.cause) {
      const found = walk(node.cause);
      if (found) return found;
    }

    if (node.parent) {
      const found = walk(node.parent);
      if (found) return found;
    }

    return '';
  }

  return Boolean(walk(error));
}

function getMemoryStore() {
  return memoryStore;
}

function getPool() {
  if (!pool) throw new Error('DATABASE_URL não configurada.');
  return pool;
}

async function initializeStore() {
  if (!pool) {
    console.warn('[store] DATABASE_URL não configurada; usando fallback em memória para geração local.');
    return;
  }
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      signup_ip_hash TEXT,
      free_ebook_used BOOLEAN NOT NULL DEFAULT FALSE,
      has_lifetime_access BOOLEAN NOT NULL DEFAULT FALSE,
      paid_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ip_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_signup_ip_hash_unique
      ON users(signup_ip_hash) WHERE signup_ip_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ebook_reservations (
      id UUID PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      ip_hash TEXT,
      is_free BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    ALTER TABLE ebook_reservations ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE ebook_reservations ADD COLUMN IF NOT EXISTS ip_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS ebook_reservations_guest_ip_unique
      ON ebook_reservations(ip_hash) WHERE ip_hash IS NOT NULL AND is_free;
    CREATE INDEX IF NOT EXISTS ebook_reservations_user_status_idx
      ON ebook_reservations(user_id, status);
    CREATE TABLE IF NOT EXISTS ebook_cover_assets (
      id BIGSERIAL PRIMARY KEY,
      source_url TEXT NOT NULL UNIQUE,
      source_title TEXT NOT NULL,
      image_mime TEXT NOT NULL,
      image_bytes BYTEA NOT NULL,
      license TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ebook_cover_assets_rotation_idx
      ON ebook_cover_assets(category, usage_count, last_used_at);
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      ip_hash TEXT,
      external_reference TEXT NOT NULL UNIQUE,
      asaas_payment_id TEXT UNIQUE,
      payment_link_id TEXT UNIQUE,
      checkout_url TEXT,
      subscription_id TEXT,
      plan TEXT NOT NULL,
      coupon_code TEXT,
      amount NUMERIC(10, 2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS ip_hash TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_link_id TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_url TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_link_id_unique
      ON payments(payment_link_id) WHERE payment_link_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ip_entitlements (
      ip_hash TEXT PRIMARY KEY,
      has_lifetime_access BOOLEAN NOT NULL DEFAULT FALSE,
      paid_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS asaas_payment_events (
      asaas_payment_id TEXT PRIMARY KEY,
      payment_link_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

module.exports = { databaseUnavailableError, getPool, getMemoryStore, hasDatabase, initializeStore };
