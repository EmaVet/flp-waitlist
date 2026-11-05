// Five Little Pigs waitlist: shared list server. No dependencies.
// Env: STAFF_PIN (required), DATA_DIR (default ./data), PORT, CLOSE_HOUR (default 16, Melbourne time)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PIN = String(process.env.STAFF_PIN || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'waitlist.json');
const PUBLIC = path.join(__dirname, 'public');
const TZ = 'Australia/Melbourne';
const CLOSE_HOUR = Number(process.env.CLOSE_HOUR || 16);
const COLLECTIONS = ['guests', 'reports', 'settings'];
const ACTIVE = ['waiting', 'notified', 'coming', 'passed'];

if (!PIN) console.warn('STAFF_PIN is not set: every request will be refused.');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { rev: 1, guests: {}, reports: {}, settings: {}, lastAutoClose: '' };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* first run */ }

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
function publicState() { return { guests: db.guests, reports: db.reports, settings: db.settings }; }
function bump() { db.rev += 1; save(); }

// ---- PIN check with a simple lockout against guessing ----
const fails = new Map(); // ip -> {n, until}
function ipOf(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function pinOk(req) {
  const ip = ipOf(req);
  const f = fails.get(ip);
  if (f && f.until > Date.now()) return 'locked';
  const given = String(req.headers['x-pin'] || '');
  const a = Buffer.from(given), b = Buffer.from(PIN);
  const ok = PIN && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (ok) { fails.delete(ip); return 'ok'; }
  const n = (f ? f.n : 0) + 1;
  fails.set(ip, { n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
  return 'bad';
}

// ---- report (same numbers as the page shows) ----
function melb(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { key: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
function buildReport() {
  const all = Object.values(db.guests).filter(g => g.addedAt);
  if (!all.length) return null;
  const first = Math.min(...all.map(g => g.addedAt)), last = Math.max(...all.map(g => g.addedAt));
  const covers = a => a.reduce((n, g) => n + (+g.party || 0), 0);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const seated = all.filter(g => g.status === 'seated' && g.doneAt);
  const waits = seated.map(g => g.doneAt - g.addedAt);
  const hours = {}; all.forEach(g => { const h = melb(g.addedAt).hour; hours[h] = (hours[h] || 0) + 1; });
  const seat = { Inside: 0, Outside: 0, Either: 0 }; all.forEach(g => { const k = g.seat || 'Either'; seat[k] = (seat[k] || 0) + 1; });
  return {
    key: melb(first).key,
    date: new Date(first).toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    firstAt: first, lastAt: last, parties: all.length, covers: covers(all),
    seatedParties: seated.length, seatedCovers: covers(seated),
    texted: all.filter(g => g.notifiedAt).length,
    noReply: all.filter(g => g.passedCount || g.status === 'noshow').length,
    removed: all.filter(g => g.status === 'left').length,
    stillWaiting: all.filter(g => ACTIVE.includes(g.status)).length,
    avgQuoteMin: seated.length ? Math.round(avg(seated.map(g => g.quote || 0))) : null,
    avgWaitMs: avg(waits), longestWaitMs: waits.length ? Math.max(...waits) : null,
    withinQuote: seated.filter(g => g.doneAt - g.addedAt <= ((g.quote || 0) + 5) * 60000).length,
    hours, seat
  };
}
function closeDay(source) {
  const r = buildReport();
  if (r) {
    r.savedAt = Date.now(); r.emailed = false; r.auto = source === 'auto';
    const t = melb(r.savedAt);
    let id = `${r.key}-${String(t.hour).padStart(2, '0')}00`;
    while (db.reports[id]) id += '-b';
    db.reports[id] = r;
  }
  db.guests = {};
  bump();
  return r;
}
// Auto close at CLOSE_HOUR Melbourne time, once a day, if anyone is on the list.
setInterval(() => {
  const now = melb(Date.now());
  if (now.hour >= CLOSE_HOUR && db.lastAutoClose !== now.key) {
    db.lastAutoClose = now.key;
    if (Object.keys(db.guests).length) { const r = closeDay('auto'); console.log('Auto close', now.key, r && r.parties, 'parties'); }
    else save();
  }
}, 60000);

// ---- http ----
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 300000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_\-.:]{1,80}$/.test(id);
const plainObj = o => o && typeof o === 'object' && !Array.isArray(o);

const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': p === '/index.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') return send(res, 200, { ok: true });
  if (!url.startsWith('/api/')) return serveStatic(req, res);

  const auth = pinOk(req);
  if (auth === 'locked') return send(res, 429, { error: 'Too many wrong PINs. Try again in 5 minutes.' });
  if (auth !== 'ok') return send(res, 401, { error: 'Wrong PIN' });

  try {
    if (req.method === 'GET' && url === '/api/check') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url === '/api/state') {
      const since = Number(new URL(req.url, 'http://x').searchParams.get('rev'));
      if (since === db.rev) return send(res, 200, { rev: db.rev, unchanged: true });
      return send(res, 200, { rev: db.rev, data: publicState() });
    }
    if (req.method === 'POST' && url === '/api/op') {
      const { op, col, id, data } = await readBody(req);
      if (!COLLECTIONS.includes(col) || !validId(id)) return send(res, 400, { error: 'bad path' });
      if (op === 'set') { if (!plainObj(data)) return send(res, 400, { error: 'bad data' }); db[col][id] = data; }
      else if (op === 'update') {
        if (!plainObj(data)) return send(res, 400, { error: 'bad data' });
        if (!db[col][id]) return send(res, 400, { error: 'not found' });
        Object.assign(db[col][id], data);
      } else if (op === 'delete') { delete db[col][id]; }
      else return send(res, 400, { error: 'bad op' });
      bump();
      return send(res, 200, { rev: db.rev, data: publicState() });
    }
    if (req.method === 'POST' && url === '/api/close') {
      const r = closeDay('manual');
      return send(res, 200, { rev: db.rev, report: r, data: publicState() });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, () => console.log('Waitlist listening on', PORT));
