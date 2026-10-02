'use strict';

const crypto = require('crypto');
const { getMemoryStore, getPool, hasDatabase } = require('./accountStore');

function readMemoryReservations() {
  return Array.from(getMemoryStore().reservations.values());
}

function memoryReservationFor(user, ipHash) {
  const list = readMemoryReservations().filter((reservation) => {
    if (user && reservation.user_id === user.id) return true;
    if (!user && reservation.ip_hash === ipHash && reservation.is_free) return true;
    return false;
  });
  return list.filter((reservation) => reservation.status === 'pending').sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
}

async function reserveEbook(user, ipHash) {
  if (!hasDatabase()) {
    if (!user) {
      if (!ipHash) throw Object.assign(new Error('Não foi possível identificar seu endereço de conexão.'), { status: 400 });
      const existing = readMemoryReservations().find((reservation) => reservation.ip_hash === ipHash && reservation.is_free && reservation.status === 'pending');
      if (existing) return { reservationId: existing.id, isFree: true, resumed: true };
      const reservation = {
        id: crypto.randomUUID(),
        user_id: null,
        ip_hash: ipHash,
        is_free: true,
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      getMemoryStore().reservations.set(reservation.id, reservation);
      return { reservationId: reservation.id, isFree: true, resumed: false };
    }

    const pending = memoryReservationFor(user, null);
    if (pending) return { reservationId: pending.id, isFree: pending.is_free, resumed: true };
    const reservation = {
      id: crypto.randomUUID(),
      user_id: user.id,
      ip_hash: null,
      is_free: !user.is_admin && !user.has_lifetime_access && !user.paid_until,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    getMemoryStore().reservations.set(reservation.id, reservation);
    return { reservationId: reservation.id, isFree: reservation.is_free, resumed: false };
  }

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (!user) {
      if (!ipHash) throw Object.assign(new Error('Não foi possível identificar seu endereço de conexão.'), { status: 400 });
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ipHash]);
      const registeredUser = await client.query(
        'SELECT id FROM users WHERE signup_ip_hash = $1 LIMIT 1',
        [ipHash]
      );
      if (registeredUser.rowCount) {
        throw Object.assign(new Error('Entre com seu e-mail para continuar usando sua conta.'), { status: 401 });
      }

      const existingGuest = await client.query(
        `SELECT id, status FROM ebook_reservations
          WHERE ip_hash = $1 AND is_free
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [ipHash]
      );
      if (existingGuest.rows[0]) {
        if (existingGuest.rows[0].status === 'pending') {
          await client.query('COMMIT');
          return { reservationId: existingGuest.rows[0].id, isFree: true, resumed: true };
        }
        throw Object.assign(new Error('O e-book gratuito deste endereço já foi usado. Informe seu e-mail para ver os planos.'), { status: 402 });
      }

      const reservationId = crypto.randomUUID();
      await client.query(
        'INSERT INTO ebook_reservations (id, ip_hash, is_free) VALUES ($1, $2, TRUE)',
        [reservationId, ipHash]
      );
      await client.query('COMMIT');
      return { reservationId, isFree: true, resumed: false };
    }

    const userResult = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    const current = userResult.rows[0];
    if (!current) throw Object.assign(new Error('Conta não encontrada.'), { status: 401 });

    const pending = await client.query(
      `SELECT id, is_free FROM ebook_reservations
        WHERE user_id = $1 AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
      [current.id]
    );
    if (pending.rows[0]) {
      await client.query('COMMIT');
      return { reservationId: pending.rows[0].id, isFree: pending.rows[0].is_free, resumed: true };
    }

    const hasPaidAccess = current.has_lifetime_access || (current.paid_until && new Date(current.paid_until) > new Date());
    if (!current.is_admin && !hasPaidAccess && current.free_ebook_used) {
      await client.query('ROLLBACK');
      throw Object.assign(new Error('Seu e-book grátis já foi usado. Escolha um plano para continuar.'), { status: 402 });
    }

    const isFree = !current.is_admin && !hasPaidAccess;
    if (isFree) await client.query('UPDATE users SET free_ebook_used = TRUE WHERE id = $1', [current.id]);
    const reservationId = crypto.randomUUID();
    await client.query(
      'INSERT INTO ebook_reservations (id, user_id, is_free) VALUES ($1, $2, $3)',
      [reservationId, current.id, isFree]
    );
    await client.query('COMMIT');
    return { reservationId, isFree, resumed: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function findReservation(userId, reservationId, ipHash) {
  if (!hasDatabase()) {
    if (!reservationId) return null;
    const reservation = getMemoryStore().reservations.get(reservationId);
    if (!reservation) return null;
    if (userId && reservation.user_id !== userId) return null;
    if (!userId && reservation.ip_hash && reservation.ip_hash !== ipHash) return null;
    return { id: reservation.id, is_free: reservation.is_free, status: reservation.status };
  }

  if (!reservationId) return null;
  const result = await getPool().query(
    `SELECT id, is_free, status FROM ebook_reservations
      WHERE id = $1 AND (
        ($2::BIGINT IS NOT NULL AND user_id = $2)
        OR (user_id IS NULL AND ($2::BIGINT IS NULL OR ip_hash = $3))
      )`,
    [reservationId, userId || null, ipHash || null]
  );
  return result.rows[0] || null;
}

async function completeReservation(userId, reservationId, ipHash) {
  if (!hasDatabase()) {
    const reservation = getMemoryStore().reservations.get(reservationId);
    if (!reservation || reservation.status !== 'pending') return false;
    if (userId && reservation.user_id !== userId) return false;
    if (!userId && reservation.ip_hash && reservation.ip_hash !== ipHash) return false;
    reservation.status = 'completed';
    reservation.completed_at = new Date().toISOString();
    return true;
  }

  const result = await getPool().query(
    `UPDATE ebook_reservations SET status = 'completed', completed_at = NOW()
      WHERE id = $1 AND status = 'pending' AND (
        ($2::BIGINT IS NOT NULL AND user_id = $2)
        OR (user_id IS NULL AND ($2::BIGINT IS NULL OR ip_hash = $3))
      )
      RETURNING id`,
    [reservationId, userId || null, ipHash || null]
  );
  return result.rowCount > 0;
}

module.exports = { completeReservation, findReservation, reserveEbook };
