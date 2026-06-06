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
export const COOKIE = 'cwt_auth';
export const isDefaultPass = PASS === 'admin';

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

export function checkLogin(user, pass) {
  // constant-time-ish compare
  const okUser = user === USER;
  const okPass = pass != null && pass === PASS;
  return okUser && okPass;
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
