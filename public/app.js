/* global Terminal, FitAddon */
const $ = (s) => document.querySelector(s);
const tabsEl = $('#tabs');
const stageEl = $('#stage');
const statusEl = $('#status');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  return res.status === 204 ? null : res.json();
}

function setStatus(msg, err) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('err', !!err);
}

const THEME = {
  background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5',
  black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
  brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
  brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff', brightWhite: '#c0caf5',
};

class Win {
  constructor(info) {
    this.id = info.id;
    this.alive = info.alive !== false;

    this.pane = document.createElement('div');
    this.pane.className = 'term-pane';
    stageEl.appendChild(this.pane);

    this.tab = document.createElement('div');
    this.tab.className = 'tab';
    this.tab.innerHTML = `<span class="dot"></span><span class="name"></span><button class="close" title="关闭">✕</button>`;
    this.tab.querySelector('.name').textContent = info.name;
    this.tab.title = `${info.command || 'shell'} · ${info.cwd}`;
    this.tab.addEventListener('click', (e) => {
      if (e.target.closest('.close')) return;
      app.activate(this.id);
    });
    this.tab.querySelector('.close').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`关闭并终止窗口 "${info.name}"？`)) app.close(this.id);
    });
    tabsEl.appendChild(this.tab);

    this.term = new Terminal({
      theme: THEME, fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.pane);
    this.term.onData((d) => this.send({ t: 'i', d }));
    this.connect();
    this.updateDot();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws?session=${this.id}`);
    this.ws.onopen = () => this.resize();
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'o') this.term.write(m.d);
      else if (m.t === 'meta') { this.alive = m.alive !== false; this.updateDot(); }
    };
    this.ws.onclose = () => {
      if (!this.disposed) setTimeout(() => { if (!this.disposed) this.connect(); }, 1500);
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  resize() {
    if (!this.pane.classList.contains('active')) return;
    try {
      this.fit.fit();
      this.send({ t: 'resize', cols: this.term.cols, rows: this.term.rows });
    } catch {}
  }

  updateDot() {
    this.tab.classList.toggle('dead', !this.alive);
    this.tab.querySelector('.dot').title = this.alive ? '运行中 (tmux)' : '会话已结束';
  }

  activate(on) {
    this.pane.classList.toggle('active', on);
    this.tab.classList.toggle('active', on);
    if (on) { this.resize(); this.term.focus(); }
  }

  dispose() {
    this.disposed = true;
    try { this.ws && this.ws.close(); } catch {}
    this.term.dispose();
    this.pane.remove();
    this.tab.remove();
  }
}

const app = {
  wins: new Map(),
  active: null,

  add(info) {
    const w = new Win(info);
    this.wins.set(info.id, w);
    this.activate(info.id);
    this.refreshEmpty();
    return w;
  },

  activate(id) {
    for (const [wid, w] of this.wins) w.activate(wid === id);
    this.active = id;
  },

  async close(id) {
    const w = this.wins.get(id);
    if (!w) return;
    w.dispose();
    this.wins.delete(id);
    try { await api('DELETE', `/api/sessions/${id}`); } catch {}
    if (this.active === id) {
      const next = this.wins.keys().next().value;
      if (next) this.activate(next);
    }
    this.refreshEmpty();
  },

  refreshEmpty() {
    let empty = $('#empty');
    if (this.wins.size === 0) {
      if (!empty) {
        empty = document.createElement('div');
        empty.id = 'empty';
        empty.innerHTML = `<div>还没有窗口</div><button>新建一个 Claude 窗口</button>`;
        empty.querySelector('button').addEventListener('click', openNewDialog);
        stageEl.appendChild(empty);
      }
    } else if (empty) empty.remove();
  },

  async load() {
    try {
      await api('GET', '/api/me'); // triggers 401 -> login if needed
    } catch { return; }
    try {
      const list = await api('GET', '/api/sessions');
      for (const info of list) this.add(info);
      setStatus(`${list.length} 个会话`);
    } catch (e) {
      if (e.message !== 'unauthorized') setStatus('连接失败', true);
    }
    this.refreshEmpty();
  },
};

// ---- create dialog ----
const dlg = $('#newDlg');
async function openNewDialog() {
  // populate remembered dirs
  let dirs = [];
  try { dirs = await api('GET', '/api/dirs'); } catch {}
  const dl = $('#dirlist');
  dl.innerHTML = dirs.map((d) => `<option value="${d}">`).join('');
  const chips = $('#dirchips');
  chips.innerHTML = dirs.slice(0, 6).map((d) => `<span class="chip" data-d="${d}">${d.replace(/^.*\//, '') || d}</span>`).join('');
  chips.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { dlg.querySelector('[name=cwd]').value = c.dataset.d; }));
  dlg.showModal();
}
$('#add').addEventListener('click', openNewDialog);
dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'ok') return;
  const f = dlg.querySelector('form');
  const body = {
    name: f.name.value.trim() || undefined,
    cwd: f.cwd.value.trim() || undefined,
    command: f.command.value,
  };
  try {
    const info = await api('POST', '/api/sessions', body);
    app.add(info);
    setStatus(`已创建 ${info.name}`);
  } catch (e) {
    if (e.message !== 'unauthorized') setStatus('创建失败', true);
  }
});

// ---- login ----
function showLogin() { $('#login').hidden = false; }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: f.user.value, pass: f.pass.value }),
  });
  if (res.ok) location.reload();
  else $('#loginErr').textContent = '用户名或密码错误';
});
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

// ---- global resize ----
let rt;
window.addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(() => { const w = app.wins.get(app.active); if (w) w.resize(); }, 120);
});

app.load();
