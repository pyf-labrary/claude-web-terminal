import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Persistent state: session metadata + remembered working dirs. Survives
// server restarts so previously opened terminals can be re-listed and
// reconnected (the live terminal itself is held by tmux).
const DIR = process.env.CWT_STATE_DIR
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-web-terminal');
const FILE = path.join(DIR, 'state.json');

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { sessions: [], dirs: [] };
  }
}

export function saveState(state) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('state save failed:', e.message);
  }
}

export const STATE_FILE = FILE;
