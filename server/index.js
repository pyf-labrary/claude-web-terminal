#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { SessionManager, hasTmux } from './sessions.js';
import {
  checkLogin, mintToken, isAuthed, cookieHeader, clearCookieHeader,
  isDefaultPass, totpEnabled, COOKIE,
} from './auth.js';
import { record as recordLogin, recent as recentLogins, lockState } from './authlog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 7531);
const HOST = process.env.HOST || '0.0.0.0';

if (!hasTmux()) {
  console.error('FATAL: tmux not found on PATH. Install it (apt install tmux / brew install tmux).');
  process.exit(1);
}

const manager = new SessionManager();

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// Only trust X-Forwarded-For from the reverse proxy itself; `true` would let any
// client forge its IP and walk around the per-IP lockout and the audit log.
const TRUST_PROXY = process.env.CWT_TRUST_PROXY || 'loopback';

// Reject requests whose Origin isn't this host. Cookies are SameSite=Lax, so a
// page on a sibling subdomain counts as same-site and would otherwise be able
// to open the terminal WebSocket with the user's cookie.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json());
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || sameOrigin(req)) return next();
  res.status(403).json({ error: 'bad origin' });
});

app.use('/', express.static(PUBLIC_DIR));
app.use('/vendor', express.static(path.join(PUBLIC_DIR, 'vendor')));

// ---- public endpoints ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, totp: totpEnabled }); // login page needs `totp`; session count stays private
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const ua = req.headers['user-agent'];
  const lock = lockState(ip);
  if (lock.locked) {
    recordLogin({ ip, ua, ok: false, reason: 'locked' });
    return res.status(429).json({ error: 'too many attempts', retryMs: lock.retryMs });
  }
  const { user, pass, code } = req.body || {};
  if (!checkLogin(user, pass, code)) {
    recordLogin({ ip, ua, ok: false, reason: 'bad-credentials' });
    return res.status(401).json({ error: 'bad credentials', totp: totpEnabled });
  }
  recordLogin({ ip, ua, ok: true });
  res.setHeader('Set-Cookie', cookieHeader(mintToken(), isSecure(req)));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearCookieHeader());
  res.json({ ok: true });
});

// ---- auth guard ----
app.use('/api', (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.get('/api/me', (req, res) => res.json({ ok: true, defaultPass: isDefaultPass, totp: totpEnabled }));

app.get('/api/logins', (req, res) => res.json(recentLogins(50)));

app.get('/api/dirs', (req, res) => res.json(manager.dirs));

app.get('/api/sessions', (req, res) => res.json(manager.list()));

app.post('/api/sessions', (req, res) => {
  const { name, cwd, command } = req.body || {};
  const s = manager.create({ name, cwd, command });
  res.status(201).json(s.info());
});

app.delete('/api/sessions/:id', (req, res) => {
  const ok = manager.remove(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return socket.destroy();
  if (!sameOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  if (!isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const session = manager.get(url.searchParams.get('session'));
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, session));
});

wss.on('connection', (ws, req, session) => {
  session.attach(ws);
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i') session.write(msg.d);
    else if (msg.t === 'resize') session.resize(msg.cols, msg.rows);
  });
  ws.on('close', () => session.detach(ws));
  ws.on('error', () => session.detach(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`claude-web-terminal on http://${HOST}:${PORT}  (tmux-backed, persistent)`);
  if (isDefaultPass) {
    console.warn('  !! Using DEFAULT password "admin". Set CWT_USER / CWT_PASS before exposing.');
  }
});

function shutdown() {
  console.log('\nshutting down (tmux sessions stay alive)...');
  manager.killAllPtys();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
