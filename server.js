// Nearby Lite: zero dependencies. Run: node server.js
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const os = require('os'), crypto = require('crypto'), zlib = require('zlib');

const PORT = +process.env.PORT || 3000;
const MAX_FILE = 2 * 1024 ** 3;
const UPLOADS = path.join(__dirname, 'uploads');
fs.rmSync(UPLOADS, { recursive: true, force: true });
fs.mkdirSync(UPLOADS);

const page = fs.readFileSync(path.join(__dirname, 'index.html'));
const pageGz = zlib.gzipSync(page);

const clients = new Map(), files = new Map(), history = [];
const sse = (res, o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
const broadcast = (o) => clients.forEach((c) => sse(c.res, o));
const remember = (m) => { history.push(m); if (history.length > 100) history.shift(); };
const peers = () => [...clients.values()].map(({ id, name }) => ({ id, name }));
const body = (req, limit = 262144) => new Promise((ok, no) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > limit) { req.destroy(); no(); } });
  req.on('end', () => ok(b)); req.on('error', no);
});

function events(req, res, url) {
  const name = (url.searchParams.get('name') || '').trim().slice(0, 24) || 'Guest';
  const id = crypto.randomBytes(4).toString('hex');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.write('retry: 1500\n\n');
  const me = { id, name, res };
  sse(res, { type: 'welcome', id, peers: peers(), history });
  clients.set(id, me);
  clients.forEach((c) => c.id !== id && sse(c.res, { type: 'peer-joined', peer: { id, name } }));
  req.on('close', () => { clients.delete(id); broadcast({ type: 'peer-left', id }); });
}

async function send(req, res, url) {
  const me = clients.get(url.searchParams.get('cid'));
  if (!me) { res.writeHead(403); return res.end(); }
  let m; try { m = JSON.parse(await body(req)); } catch { res.writeHead(400); return res.end(); }
  if (m.type === 'chat') {
    const text = String(m.text || '').slice(0, 4000);
    if (text.trim()) { const msg = { type: 'chat', from: me.id, name: me.name, text, ts: Date.now() }; remember(msg); broadcast(msg); }
  } else if (m.type === 'signal') {
    const t = clients.get(m.to);
    if (t) sse(t.res, { type: 'signal', from: me.id, data: m.data });
  }
  res.writeHead(204); res.end();
}

function upload(req, res, url) {
  const me = clients.get(url.searchParams.get('cid'));
  if (!me) { res.writeHead(403); return res.end(); }
  const name = (url.searchParams.get('name') || 'file').replace(/[\\/\0]/g, '_').slice(0, 200);
  const type = (url.searchParams.get('type') || '').slice(0, 100);
  const id = crypto.randomBytes(12).toString('hex'), fp = path.join(UPLOADS, id);
  const out = fs.createWriteStream(fp);
  let size = 0, dead = false;
  const kill = () => { if (!dead) { dead = true; out.destroy(); fs.unlink(fp, () => {}); } };
  req.on('data', (c) => { size += c.length; if (size > MAX_FILE) { kill(); res.writeHead(413); res.end(); req.destroy(); } });
  req.on('close', () => { if (!req.complete) kill(); });
  req.on('error', kill); out.on('error', kill);
  out.on('finish', () => {
    if (dead) return;
    files.set(id, { name, type, size });
    const msg = { type: 'file', from: me.id, name: me.name, file: { id, name, size, mime: type }, ts: Date.now() };
    remember(msg); broadcast(msg);
    res.writeHead(200); res.end('ok');
  });
  req.pipe(out);
}

function download(res, id) {
  const f = files.get(id);
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  const inline = /^image\/(png|jpeg|gif|webp)$/.test(f.type);
  res.writeHead(200, {
    'Content-Type': inline ? f.type : 'application/octet-stream', 'Content-Length': f.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(path.join(UPLOADS, id)).pipe(res);
}

const handler = (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (req.method === 'GET' && p === '/events') return events(req, res, url);
  if (req.method === 'POST' && p === '/send') return send(req, res, url);
  if (req.method === 'POST' && p === '/upload') return upload(req, res, url);
  if (req.method === 'GET' && p.startsWith('/files/')) return download(res, p.slice(7).replace(/[^a-f0-9]/g, ''));
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const gz = /gzip/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(gz && { 'Content-Encoding': 'gzip' }), 'Cache-Control': 'no-cache' });
    return res.end(gz ? pageGz : page);
  }
  res.writeHead(404); res.end('Not found');
};

// HTTPS only if key.pem + cert.pem exist (needed for calls on a local network).
const keyF = path.join(__dirname, 'key.pem'), certF = path.join(__dirname, 'cert.pem');
const tls = fs.existsSync(keyF) && fs.existsSync(certF);
const server = tls ? https.createServer({ key: fs.readFileSync(keyF), cert: fs.readFileSync(certF) }, handler) : http.createServer(handler);
server.requestTimeout = 0; // allow long uploads

setInterval(() => clients.forEach((c) => c.res.write(': ping\n\n')), 15000);

server.listen(PORT, '0.0.0.0', () => {
  const scheme = tls ? 'https' : 'http';
  console.log(`\n  Nearby Lite is running. Open on any device on the same Wi-Fi:\n`);
  for (const l of Object.values(os.networkInterfaces()))
    for (const n of l || []) if (n.family === 'IPv4' && !n.internal) console.log(`    ${scheme}://${n.address}:${PORT}`);
  if (!tls) console.log('\n  Chat and files work now. For voice/video calls, add key.pem + cert.pem (see README).\n');
});
