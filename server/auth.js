import crypto from 'node:crypto';

// Simple username/password login that mints an HMAC-signed cookie token.
// Config via env:
//   CWT_USER     (default "admin")
//   CWT_PASS     (default "admin"  -> loud warning)
//   CWT_SECRET   (cookie signing key; derived from CWT_PASS if unset, so
//                 sessions survive restarts without extra config)
//   CWT_TTL_DAYS (cookie lifetime, default 30)

const USER = process.env.CWT_USER || 'admin';
const PASS = process.env.CWT_PASS || 'admin';
const TTL_DAYS = Number(process.env.CWT_TTL_DAYS || 30);
const SECRET = process.env.CWT_SECRET
  || crypto.createHash('sha256').update(`cwt:${USER}:${PASS}`).digest('hex');
// Optional TOTP (RFC 6238) second factor. Set CWT_TOTP_SECRET (base32) to enable.
const TOTP_SECRET = (process.env.CWT_TOTP_SECRET || '').replace(/\s/g, '').toUpperCase();
export const COOKIE = 'cwt_auth';
export const isDefaultPass = PASS === 'admin';
export const totpEnabled = !!TOTP_SECRET;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of s.replace(/=+$/, '')) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secret).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16)
    | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}
function verifyTOTP(token) {
  if (!TOTP_SECRET) return true; // disabled
  if (!/^\d{6}$/.test(String(token || ''))) return false;
  const secret = base32Decode(TOTP_SECRET);
  const step = Math.floor(Date.now() / 30000);
  for (const w of [-1, 0, 1]) {
    try { if (crypto.timingSafeEqual(Buffer.from(hotp(secret, step + w)), Buffer.from(String(token)))) return true; } catch {}
  }
  return false;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  } catch {
    return false;
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return false; }
  if (!payload.exp || Date.now() > payload.exp) return false;
  return payload;
}

export function checkLogin(user, pass, code) {
  const okUser = user === USER;
  const okPass = pass != null && pass === PASS;
  const okCode = verifyTOTP(code);
  return okUser && okPass && okCode;
}

export function mintToken() {
  return sign({ u: USER, iat: Date.now(), exp: Date.now() + TTL_DAYS * 86400_000 });
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

export function tokenFromReq(req) {
  const c = parseCookies(req.headers.cookie);
  return c[COOKIE];
}

export function isAuthed(req) {
  return !!verify(tokenFromReq(req));
}

export function cookieHeader(token, secure) {
  const attrs = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${TTL_DAYS * 86400}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`;
}
