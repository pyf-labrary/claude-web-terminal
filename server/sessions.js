import pty from 'node-pty';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadState, saveState } from './state.js';

// Max bytes of live scrollback retained per session so a *second* browser
// attaching to an already-running session sees recent output. (The first
// attach is covered by tmux's own full-screen repaint.)
const MAX_BUFFER = 256 * 1024;
const PREFIX = 'cwt_';

export function hasTmux() {
  try {
    return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function tmux(args, opts = {}) {
  return spawnSync('tmux', args, { encoding: 'utf8', ...opts });
}

function tmuxSessionExists(name) {
  return tmux(['has-session', '-t', name]).status === 0;
}

function listTmuxSessions() {
  const r = tmux(['list-sessions', '-F', '#{session_name}']);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(PREFIX));
}

let counter = 0;

export class Session {
  constructor({ id, name, cwd, command, createdAt }) {
    counter += 1;
    this.id = id || `${Date.now().toString(36)}${counter}`;
    this.tmuxName = PREFIX + this.id;
    this.name = name || `window ${counter}`;
    this.cwd = cwd || os.homedir();
    this.command = command ?? 'claude';
    this.createdAt = createdAt || Date.now();
    this.cols = 120;
    this.rows = 32;
    this.clients = new Set();
    this.buffer = [];
    this.bufferBytes = 0;
    this.pty = null;
    this.needsLaunch = false; // send launch command on first attach
  }

  // Make sure the backing tmux session exists. Returns true if freshly created.
  ensureTmux() {
    if (tmuxSessionExists(this.tmuxName)) return false;
    tmux(['new-session', '-d', '-s', this.tmuxName, '-c', this.cwd, '-x', String(this.cols), '-y', String(this.rows)]);
    // Plain-terminal feel: no status bar, mouse scroll, big history.
    tmux(['set-option', '-t', this.tmuxName, 'status', 'off']);
    tmux(['set-option', '-t', this.tmuxName, 'mouse', 'on']);
    tmux(['set-option', '-t', this.tmuxName, 'history-limit', '20000']);
    this.needsLaunch = !!(this.command && this.command.trim());
    return true;
  }

  alive() {
    return tmuxSessionExists(this.tmuxName);
  }

  _attachPty() {
    if (this.pty) return;
    this.ensureTmux();
    this.pty = pty.spawn('tmux', ['attach-session', '-t', this.tmuxName], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    this.pty.onData((data) => this._onData(data));
    this.pty.onExit(() => { this.pty = null; }); // tmux detach; session persists
    if (this.needsLaunch) {
      this.needsLaunch = false;
      setTimeout(() => { try { this.pty && this.pty.write(`${this.command}\r`); } catch {} }, 350);
    }
  }

  _onData(data) {
    this.buffer.push(data);
    this.bufferBytes += Buffer.byteLength(data);
    while (this.bufferBytes > MAX_BUFFER && this.buffer.length > 1) {
      this.bufferBytes -= Buffer.byteLength(this.buffer.shift());
    }
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'o', d: data }));
    }
  }

  attach(ws) {
    const first = this.clients.size === 0;
    this.clients.add(ws);
    if (first && !this.pty) {
      // Fresh attach: clear stale buffer; tmux repaints the live screen.
      this.buffer = []; this.bufferBytes = 0;
      this._attachPty();
    } else {
      // A peer is already attached — replay what we've buffered.
      const replay = this.buffer.join('');
      if (replay) ws.send(JSON.stringify({ t: 'o', d: replay }));
    }
    ws.send(JSON.stringify({ t: 'meta', alive: this.alive() }));
  }

  detach(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0 && this.pty) {
      // Detach from tmux (session keeps running) and free the pty.
      try { this.pty.kill(); } catch {}
      this.pty = null;
      this.buffer = []; this.bufferBytes = 0;
    }
  }

  write(data) {
    if (!this.pty) this._attachPty();
    try { this.pty && this.pty.write(data); } catch {}
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    try { this.pty && this.pty.resize(cols, rows); } catch {}
  }

  kill() {
    try { this.pty && this.pty.kill(); } catch {}
    this.pty = null;
    tmux(['kill-session', '-t', this.tmuxName]);
  }

  info() {
    return {
      id: this.id, name: this.name, cwd: this.cwd, command: this.command,
      createdAt: this.createdAt, clients: this.clients.size, alive: this.alive(),
    };
  }

  meta() {
    return { id: this.id, name: this.name, cwd: this.cwd, command: this.command, createdAt: this.createdAt };
  }
}

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.dirs = [];
    this._restore();
  }

  _restore() {
    const state = loadState();
    this.dirs = state.dirs || [];
    const live = new Set(listTmuxSessions());
    // Rebuild sessions whose tmux backing still exists.
    for (const meta of state.sessions || []) {
      if (live.has(PREFIX + meta.id)) {
        const s = new Session(meta);
        s.needsLaunch = false; // already running inside tmux
        this.sessions.set(s.id, s);
        live.delete(PREFIX + meta.id);
      }
    }
    // Adopt any orphan cwt_* tmux sessions not in our state.
    for (const tn of live) {
      const id = tn.slice(PREFIX.length);
      const s = new Session({ id, name: `recovered ${id}`, command: '' });
      s.needsLaunch = false;
      this.sessions.set(s.id, s);
    }
    this._persist();
  }

  _persist() {
    saveState({
      sessions: [...this.sessions.values()].map((s) => s.meta()),
      dirs: this.dirs,
    });
  }

  rememberDir(dir) {
    if (!dir) return;
    this.dirs = [dir, ...this.dirs.filter((d) => d !== dir)].slice(0, 12);
  }

  create(opts) {
    const s = new Session(opts);
    s.ensureTmux();
    this.sessions.set(s.id, s);
    if (opts.cwd) this.rememberDir(opts.cwd);
    this._persist();
    return s;
  }

  get(id) { return this.sessions.get(id); }

  list() { return [...this.sessions.values()].map((s) => s.info()); }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.kill();
    this.sessions.delete(id);
    this._persist();
    return true;
  }

  killAllPtys() {
    // On server shutdown: detach our ptys but LEAVE tmux sessions running.
    for (const s of this.sessions.values()) {
      try { s.pty && s.pty.kill(); } catch {}
      s.pty = null;
    }
  }
}
