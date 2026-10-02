'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { getPool } = require('./accountStore');

const SESSION_COOKIE = 'ebook_session';
const SESSION_TTL_DAYS = 30;
const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 60;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function authSecret() {
  if (process.env.AUTH_SESSION_SECRET) return process.env.AUTH_SESSION_SECRET;

  if (process.env.NODE_ENV === 'production' || process.env.RENDER_SERVICE_ID) {
    throw new Error('AUTH_SESSION_SECRET não configurada.');
  }

  const secretPath = path.join(__dirname, '.local-auth-secret');
  try {
    return fs.readFileSync(secretPath, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const localSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretPath, `${localSecret}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return localSecret;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
}

function digest(value) {
  return crypto.createHmac('sha256', authSecret()).update(value).digest('hex');
}

function digestCode(email, code) {
  return digest(`${email}:${code}`);
}

function digestSession(token) {
  return digest(`session:${token}`);
}

function digestSignupIp(clientIp) {
  const normalizedIp = typeof clientIp === 'string' ? clientIp.trim().toLowerCase().replace(/^::ffff:/, '') : '';
  if (!normalizedIp) {
    throw Object.assign(new Error('Não foi possível identificar a conexão para criar a conta.'), { status: 400 });
  }
  return digest(`signup-ip:${normalizedIp}`);
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function mailTransport() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP_HOST, SMTP_USER e SMTP_PASS precisam ser configurados.');
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

async function requestEmailCode(emailInput, clientIp) {
  const email = normalizeEmail(emailInput);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    const error = new Error('Informe um endereço de e-mail válido.');
    error.status = 400;
    throw error;
  }

  const transport = mailTransport();
  const db = getPool();
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  const existingUser = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (!existingUser.rowCount && email !== adminEmail) {
    const signupIpHash = digestSignupIp(clientIp);
    const existingIpUser = await db.query('SELECT id FROM users WHERE signup_ip_hash = $1', [signupIpHash]);
    if (existingIpUser.rowCount) {
      throw Object.assign(new Error('Já existe uma conta neste endereço de internet. Entre usando o e-mail da conta existente.'), { status: 409 });
    }
  }
  const cooldown = await db.query(
    `SELECT GREATEST(0, 60 - EXTRACT(EPOCH FROM (NOW() - created_at)))::INTEGER AS seconds
       FROM email_codes WHERE email = $1`,
    [email]
  );
  if (cooldown.rows[0] && cooldown.rows[0].seconds > 0) {
    const error = new Error('Aguarde antes de solicitar outro código.');
    error.status = 429;
    error.retryAfter = cooldown.rows[0].seconds;
    throw error;
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = digestCode(email, code);
  await db.query(
    `INSERT INTO email_codes (email, code_hash, expires_at, attempts, created_at)
     VALUES ($1, $2, NOW() + INTERVAL '${CODE_TTL_MINUTES} minutes', 0, NOW())
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at, attempts = 0, created_at = NOW()`,
    [email, codeHash]
  );

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transport.sendMail({
      from,
      to: email,
      subject: 'Seu código para entrar no Gerador de E-books',
      text: `Seu código de acesso é ${code}. Ele expira em ${CODE_TTL_MINUTES} minutos. Se você não solicitou este código, ignore este e-mail.`,
      html: `<p>Seu código de acesso é:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>Ele expira em ${CODE_TTL_MINUTES} minutos. Se você não solicitou este código, ignore este e-mail.</p>`,
    });
  } catch (error) {
    await db.query('DELETE FROM email_codes WHERE email = $1 AND code_hash = $2', [email, codeHash]).catch(() => {});
    console.error('Falha ao enviar código de acesso:', error.message);
    throw Object.assign(new Error('Não foi possível enviar o código. Verifique as configurações SMTP.'), { status: 502 });
  }
  return { email };
}

async function verifyEmailCode(emailInput, codeInput, clientIp) {
  const email = normalizeEmail(emailInput);
  const code = typeof codeInput === 'string' ? codeInput.trim() : '';
  if (!/^\d{6}$/.test(code)) {
    const error = new Error('O código deve ter 6 números.');
    error.status = 400;
    throw error;
  }

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM email_codes WHERE email = $1 FOR UPDATE', [email]);
    const record = result.rows[0];
    if (!record || new Date(record.expires_at) <= new Date() || record.attempts >= MAX_CODE_ATTEMPTS) {
      throw Object.assign(new Error('Código expirado ou inválido. Solicite outro.'), { status: 400 });
    }

    if (!safeCompare(record.code_hash, digestCode(email, code))) {
      await client.query('UPDATE email_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
      await client.query('COMMIT');
      throw Object.assign(new Error('Código incorreto.'), { status: 400 });
    }

    const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
    const isAdmin = Boolean(adminEmail && email === adminEmail);
    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    let signupIpHash = null;
    let guestFreeUsed = false;
    if (!isAdmin) {
      signupIpHash = digestSignupIp(clientIp);
      if (!existingUser.rowCount) {
        const existingIpUser = await client.query('SELECT id FROM users WHERE signup_ip_hash = $1', [signupIpHash]);
        if (existingIpUser.rowCount) {
          throw Object.assign(new Error('Já existe uma conta neste endereço de internet. Entre usando o e-mail da conta existente.'), { status: 409 });
        }
      }
      const guestUsage = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM ebook_reservations
            WHERE ip_hash = $1 AND is_free AND status IN ('pending', 'completed')
         ) AS used`,
        [signupIpHash]
      );
      guestFreeUsed = guestUsage.rows[0].used;
    }
    const userResult = await client.query(
      `INSERT INTO users (email, is_admin, signup_ip_hash, free_ebook_used) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         is_admin = users.is_admin OR EXCLUDED.is_admin,
         free_ebook_used = users.free_ebook_used OR EXCLUDED.free_ebook_used
       RETURNING id, email, is_admin, free_ebook_used, has_lifetime_access, paid_until`,
      [email, isAdmin, signupIpHash, guestFreeUsed]
    );

    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await client.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
      digestSession(sessionToken), userResult.rows[0].id, expiresAt,
    ]);
    await client.query('DELETE FROM email_codes WHERE email = $1', [email]);
    await client.query('COMMIT');
    return { user: userResult.rows[0], sessionToken, expiresAt };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505' && error.constraint === 'users_signup_ip_hash_unique') {
      throw Object.assign(new Error('Já existe uma conta neste endereço de internet. Entre usando o e-mail da conta existente.'), { status: 409 });
    }
    throw error;
  } finally {
    client.release();
  }
}

function readCookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  const item = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

async function getUserForRequest(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const result = await getPool().query(
    `SELECT u.id, u.email, u.is_admin, u.free_ebook_used, u.has_lifetime_access, u.paid_until
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [digestSession(token)]
  );
  return result.rows[0] || null;
}

async function destroySession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return;
  await getPool().query('DELETE FROM sessions WHERE token_hash = $1', [digestSession(token)]);
}

function sessionCookie(token, expiresAt, secure) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function expiredSessionCookie(secure) {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = {
  SESSION_COOKIE,
  digestCode,
  digestSignupIp,
  expiredSessionCookie,
  getUserForRequest,
  normalizeEmail,
  requestEmailCode,
  sessionCookie,
  destroySession,
  verifyEmailCode,
};
