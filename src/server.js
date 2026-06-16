import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket, { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 3000);
const TWITCH_CHANNEL = cleanChannel(process.env.TWITCH_CHANNEL || 'skavstheworld');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const OVERLAY_KEY = process.env.OVERLAY_KEY || '';

const settings = {
  channel: TWITCH_CHANNEL,
  matchSeconds: Number(process.env.MATCH_SECONDS || 300),
  coinHit: Number(process.env.COIN_HIT || 2),
  coinSurvive: Number(process.env.COIN_SURVIVE || 1),
  coinKoBonus: Number(process.env.COIN_KO_BONUS || 12)
};

const COMMANDS = new Set([
  '!fight',
  '!join',
  '!strike',
  '!punch',
  '!jump',
  '!dash',
  '!block',
  '!weapon',
  '!taunt',
  '!special'
]);

const ALIASES = new Map([
  ['!join', 'fight'],
  ['!fight', 'fight'],
  ['!punch', 'strike'],
  ['!strike', 'strike'],
  ['!jump', 'jump'],
  ['!dash', 'dash'],
  ['!block', 'block'],
  ['!weapon', 'weapon'],
  ['!taunt', 'taunt'],
  ['!special', 'special']
]);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC, {
  extensions: ['html'],
  maxAge: '1h'
}));

app.get('/', (_req, res) => res.redirect('/overlay'));

app.get('/overlay', (req, res) => {
  if (OVERLAY_KEY && req.query.key !== OVERLAY_KEY) {
    return res.status(403).send('Missing or invalid overlay key.');
  }
  res.sendFile(path.join(PUBLIC, 'overlay.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'admin.html'));
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, channel: TWITCH_CHANNEL, twitchConnected: twitchClient.connected });
});

app.get('/api/settings', (req, res) => {
  if (OVERLAY_KEY && req.query.key !== OVERLAY_KEY && req.headers['x-overlay-key'] !== OVERLAY_KEY) {
    return res.status(403).json({ ok: false, error: 'invalid_overlay_key' });
  }
  res.json(settings);
});

app.post('/api/command', (req, res) => {
  if (ADMIN_KEY && req.body?.key !== ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'invalid_admin_key' });
  }

  const username = safeName(req.body?.username || 'Tester');
  const raw = String(req.body?.command || '').trim().toLowerCase();
  const command = raw.startsWith('!') ? ALIASES.get(raw) : raw;

  if (!command || !['fight', 'strike', 'jump', 'dash', 'block', 'weapon', 'taunt', 'special', 'reset', 'start', 'end'].includes(command)) {
    return res.status(400).json({ ok: false, error: 'unknown_command' });
  }

  broadcast({
    type: 'command',
    source: 'manual',
    username,
    displayName: req.body?.displayName || username,
    command,
    color: req.body?.color || null,
    at: Date.now()
  });

  res.json({ ok: true, username, command });
});

app.post('/api/game-event', (req, res) => {
  if (ADMIN_KEY && req.body?.key !== ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'invalid_admin_key' });
  }

  const type = String(req.body?.type || '').trim();
  if (!type) return res.status(400).json({ ok: false, error: 'missing_type' });

  broadcast({ type, payload: req.body?.payload || {}, at: Date.now() });
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (OVERLAY_KEY && url.searchParams.get('key') !== OVERLAY_KEY) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  sockets.add(ws);
  ws.send(JSON.stringify({ type: 'hello', settings, twitchConnected: twitchClient.connected }));

  ws.on('message', msg => {
    try {
      const data = JSON.parse(String(msg));
      if (data.type === 'overlay-ready') {
        ws.send(JSON.stringify({ type: 'settings', settings }));
      }
    } catch {}
  });

  ws.on('close', () => sockets.delete(ws));
  ws.on('error', () => sockets.delete(ws));
});

function broadcast(payload) {
  const packet = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(packet);
  }
}

class TwitchIrcClient {
  constructor({ channel, username, token }) {
    this.channel = channel;
    this.username = username || `justinfan${Math.floor(Math.random() * 90000) + 10000}`;
    this.token = token;
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 3000;
  }

  connect() {
    if (!this.channel) return;

    clearTimeout(this.reconnectTimer);
    console.log(`[twitch] connecting to #${this.channel} as ${this.username}`);
    this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 3000;

      const pass = this.token ? ensureOauth(this.token) : 'oauth:';
      this.send(`PASS ${pass}`);
      this.send(`NICK ${this.username.toLowerCase()}`);
      this.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      this.send(`JOIN #${this.channel}`);
      broadcast({ type: 'twitch-status', connected: true, at: Date.now() });
    });

    this.ws.on('message', buffer => {
      const raw = String(buffer);
      const lines = raw.split('\r\n').filter(Boolean);
      for (const line of lines) this.handleLine(line);
    });

    this.ws.on('close', () => this.scheduleReconnect('closed'));
    this.ws.on('error', err => {
      console.warn('[twitch] socket error:', err.message);
      this.scheduleReconnect('error');
    });
  }

  scheduleReconnect(reason) {
    if (this.connected) {
      console.log(`[twitch] disconnected: ${reason}`);
      broadcast({ type: 'twitch-status', connected: false, at: Date.now() });
    }
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
  }

  send(line) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(`${line}\r\n`);
  }

  handleLine(line) {
    if (line.startsWith('PING')) {
      this.send('PONG :tmi.twitch.tv');
      return;
    }

    if (!line.includes('PRIVMSG')) return;

    const parsed = parsePrivmsg(line);
    if (!parsed) return;

    const commandToken = parsed.message.trim().split(/\s+/)[0].toLowerCase();
    if (!COMMANDS.has(commandToken)) return;

    const command = ALIASES.get(commandToken);
    broadcast({
      type: 'command',
      source: 'twitch',
      username: safeName(parsed.username),
      displayName: parsed.displayName || parsed.username,
      command,
      color: parsed.color || null,
      at: Date.now()
    });
  }
}

function parsePrivmsg(line) {
  // Example with tags:
  // @badge-info=;badges=;color=#...;display-name=Name :name!name@name.tmi.twitch.tv PRIVMSG #channel :!fight
  let tags = {};
  let rest = line;

  if (line.startsWith('@')) {
    const firstSpace = line.indexOf(' ');
    const tagPart = line.slice(1, firstSpace);
    rest = line.slice(firstSpace + 1);
    for (const pair of tagPart.split(';')) {
      const [key, value = ''] = pair.split('=');
      tags[key] = decodeIrcTag(value);
    }
  }

  const match = rest.match(/^:([^!\s]+)!.* PRIVMSG #[^\s]+ :(.+)$/);
  if (!match) return null;

  const username = match[1];
  const message = match[2];

  return {
    username,
    message,
    displayName: tags['display-name'] || username,
    color: tags.color || null
  };
}

function decodeIrcTag(value) {
  return value
    .replace(/\\s/g, ' ')
    .replace(/\\:/g, ';')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
}

function ensureOauth(token) {
  if (!token) return '';
  return token.startsWith('oauth:') ? token : `oauth:${token}`;
}

function cleanChannel(value) {
  return String(value || '').trim().replace(/^#/, '').toLowerCase();
}

function safeName(value) {
  return String(value || 'viewer')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 25) || 'viewer';
}

const twitchClient = new TwitchIrcClient({
  channel: TWITCH_CHANNEL,
  username: process.env.TWITCH_BOT_USERNAME,
  token: process.env.TWITCH_OAUTH_TOKEN
});

twitchClient.connect();

server.listen(PORT, () => {
  console.log(`[server] running on http://localhost:${PORT}`);
  console.log(`[server] overlay http://localhost:${PORT}/overlay`);
  console.log(`[server] admin   http://localhost:${PORT}/admin`);
});
