// Nearby - local network chat, file sharing and calls.
// Run: npm install && npm start
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE = 2 * 1024 * 1024 * 1024; // 2 GB per file
const UPLOADS = path.join(__dirname, 'uploads');
const PUBLIC = path.join(__dirname, 'public');

// Start with a clean uploads folder (files live only while the server runs).
fs.mkdirSync(UPLOADS, { recursive: true });
for (const f of fs.readdirSync(UPLOADS)) fs.unlink(path.join(UPLOADS, f), () => {});

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

// Browsers only allow camera/microphone on HTTPS, so we serve a self-signed certificate.
function getCert(ips) {
  const dir = path.join(__dirname, '.cert');
  const file = path.join(dir, 'cert.json');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.ips === ips.join(',')) return c;
  } catch {}
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'nearby.local' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  const c = { ips: ips.join(','), key: pems.private, cert: pems.cert };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c));
  return c;
}

const clients = new Map(); // id -> { id, name, ws }
const files = new Map(); // fileId -> { name, type, size }
const history = []; // last chat/file messages
const HISTORY_MAX = 100;

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const broadcast = (obj) => clients.forEach((c) => send(c.ws, obj));
const remember = (m) => {
  history.push(m);
  if (history.length > HISTORY_MAX) history.shift();
};
const peerList = () => [...clients.values()].map(({ id, name }) => ({ id, name }));

const INLINE_OK = /^image\/(png|jpeg|gif|webp)$/;

function handleUpload(req, res, url) {
  const c = clients.get(url.searchParams.get('cid'));
  if (!c) { res.writeHead(403); return res.end(); }
  const name = (url.searchParams.get('name') || 'file').replace(/[\\/\0]/g, '_').slice(0, 200);
  const type = (url.searchParams.get('type') || '').slice(0, 100);
  const id = crypto.randomBytes(12).toString('hex');
  const fp = path.join(UPLOADS, id);
  const out = fs.createWriteStream(fp);
  let size = 0;
  let dead = false;
  const abort = () => {
    if (dead) return;
    dead = true;
    out.destroy();
    fs.unlink(fp, () => {});
  };
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_FILE) {
      abort();
      res.writeHead(413);
      res.end();
      req.destroy();
    }
  });
  req.on('close', () => { if (!req.complete) abort(); });
  req.on('error', abort);
  out.on('error', abort);
  out.on('finish', () => {
    if (dead) return;
    files.set(id, { name, type, size });
    const msg = { type: 'file', from: c.id, name: c.name, file: { id, name, size, mime: type }, ts: Date.now() };
    remember(msg);
    broadcast(msg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  req.pipe(out);
}

function handleDownload(res, id) {
  const meta = files.get(id);
  if (!/^[a-f0-9]{24}$/.test(id) || !meta) { res.writeHead(404); return res.end('Not found'); }
  const inline = INLINE_OK.test(meta.type);
  res.writeHead(200, {
    'Content-Type': inline ? meta.type : 'application/octet-stream',
    'Content-Length': meta.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(path.join(UPLOADS, id)).pipe(res);
}

const ips = lanIPs();
const { key, cert } = getCert(ips);

const server = https.createServer({ key, cert }, (req, res) => {
  const url = new URL(req.url, 'https://x');
  if (req.method === 'POST' && url.pathname === '/upload') return handleUpload(req, res, url);
  if (req.method === 'GET' && url.pathname.startsWith('/files/')) return handleDownload(res, url.pathname.slice(7));
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(path.join(PUBLIC, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('Missing public/index.html'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'join' && !me) {
      const name = String(m.name || '').trim().slice(0, 24) || 'Guest';
      me = { id: crypto.randomBytes(4).toString('hex'), name, ws };
      clients.set(me.id, me);
      send(ws, { type: 'welcome', id: me.id, peers: peerList(), history });
      clients.forEach((c) => c.id !== me.id && send(c.ws, { type: 'peer-joined', peer: { id: me.id, name } }));
      return;
    }
    if (!me) return;

    if (m.type === 'chat') {
      const text = String(m.text || '').slice(0, 4000);
      if (!text.trim()) return;
      const msg = { type: 'chat', from: me.id, name: me.name, text, ts: Date.now() };
      remember(msg);
      broadcast(msg);
    } else if (m.type === 'signal') {
      const target = clients.get(m.to);
      if (target) send(target.ws, { type: 'signal', from: me.id, data: m.data });
    }
  });

  ws.on('close', () => {
    if (!me) return;
    clients.delete(me.id);
    broadcast({ type: 'peer-left', id: me.id });
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Nearby is running. Open one of these on any device on the same Wi-Fi:\n');
  (ips.length ? ips : ['localhost']).forEach((ip) => console.log(`    https://${ip}:${PORT}`));
  console.log('\n  First visit shows a certificate warning (self-signed). Accept it once per device.\n');
});
