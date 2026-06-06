import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Append-only login audit log + simple per-IP brute-force lockout.
const DIR = process.env.CWT_STATE_DIR
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-web-terminal');
const FILE = path.join(DIR, 'auth.log');

const MAX_FAILS = Number(process.env.CWT_MAX_FAILS || 6);
const WINDOW_MS = Number(process.env.CWT_LOCK_WINDOW_MS || 15 * 60 * 1000);
const attempts = new Map(); // ip -> { fails, first, until }

export function lockState(ip) {
  const a = attempts.get(ip);
  if (a && a.until && Date.now() < a.until) {
    return { locked: true, retryMs: a.until - Date.now() };
  }
  return { locked: false };
}

function noteResult(ip, ok) {
  if (ok) { attempts.delete(ip); return; }
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now - a.first > WINDOW_MS) a = { fails: 0, first: now, until: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) a.until = now + WINDOW_MS;
  attempts.set(ip, a);
}

export function record({ ip, ua, ok, reason }) {
  noteResult(ip, ok);
  const line = JSON.stringify({
    ts: new Date().toISOString(), ip: ip || '?', ok: !!ok,
    reason: reason || (ok ? 'success' : 'fail'),
    ua: (ua || '').slice(0, 160),
  });
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, line + '\n');
  } catch { /* best-effort */ }
}

export function recent(limit = 50) {
  try {
    const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
