'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const express = require('express'), Database = require('better-sqlite3');
const E = process.env;

/* ---------- Configuración (variables de entorno) ---------- */
const PORT = +E.PORT || 3000;
const PIN = E.ADMIN_PIN || '';
const TZ_OFF = +(E.TZ_OFFSET_MIN ?? -180);           // Paraguay: UTC-3 (-180 min)
const CC = E.COUNTRY_CODE || '595';                  // prefijo de país para números locales
const WA = { id: E.WA_PHONE_NUMBER_ID, token: E.WA_TOKEN, ver: E.WA_GRAPH_VERSION || 'v21.0', lang: E.WA_LANG || 'es' };
const WA_ON = !!(WA.id && WA.token);
const TPL = {
  c: E.TPL_CONFIRM || 'barberapp_confirmacion', r: E.TPL_REMINDER || 'barberapp_recordatorio',
  x: E.TPL_CANCEL || 'barberapp_cancelacion', u: E.TPL_UPDATE || 'barberapp_cambio', b: E.TPL_BARBER || 'barberapp_aviso_barbero'
};
if (PIN.length < 4) { console.error('Falta ADMIN_PIN (mínimo 4 caracteres).'); process.exit(1); }

/* ---------- Base de datos ---------- */
const DB_PATH = E.DB_PATH || path.join(__dirname, 'data', 'barberapp.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY AUTOINCREMENT, svc INTEGER, sn TEXT, p INTEGER, m INTEGER,
  b INTEGER, d TEXT, t INTEGER, name TEXT, wa TEXT, nw INTEGER DEFAULT 1, created INTEGER, UNIQUE(b, d, t));
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, bid INTEGER, kind TEXT, to_num TEXT,
  tpl TEXT, params TEXT, text TEXT, at INTEGER, due INTEGER, st TEXT DEFAULT 'pendiente', tries INTEGER DEFAULT 0, err TEXT, sent_at INTEGER);
CREATE TABLE IF NOT EXISTS log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, txt TEXT);
CREATE INDEX IF NOT EXISTS ob_idx ON outbox(st, at);`);
const kvGet = k => { const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : null; };
const kvSet = (k, v) => db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));

const DEF = {
  shop: 'Azuaga Barbería', cur: 'Gs ', open: '09:00', close: '19:00', off: [0], slot: 30,
  svcs: [{ id: 1, n: 'Barba + corte de pelo + cejas', m: 45, p: 60000 }, { id: 2, n: 'Corte de pelo', m: 30, p: 50000 },
         { id: 3, n: 'Barba', m: 30, p: 30000 }, { id: 4, n: 'Cejas', m: 15, p: 20000 }],
  bars: [{ id: 1, n: 'Pabellón', wa: '' }, { id: 2, n: 'Joaquín', wa: '' }],
  rem: { on: true, min: 30 }, wa: ''
};
if (!kvGet('cfg')) kvSet('cfg', DEF);
const getCfg = () => kvGet('cfg') || DEF;
let SECRET = kvGet('secret');
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); kvSet('secret', SECRET); }
db.prepare("UPDATE outbox SET st='pendiente' WHERE st='enviando'").run();

/* ---------- Fechas y teléfonos ---------- */
const pad = n => String(n).padStart(2, '0');
const tm = s => { const [a, b] = s.split(':'); return +a * 60 + +b; };
const fm = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const localNow = () => new Date(Date.now() + TZ_OFF * 60000);
const todayKey = () => { const d = localNow(); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
const nowMin = () => { const d = localNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const utc = (d, t) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd) + (t - TZ_OFF) * 60000; };
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) === d;
const dow = d => new Date(d + 'T12:00:00Z').getUTCDay();
const fdate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
function normWa(w) {
  let n = String(w || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.startsWith('00')) n = n.slice(2); else if (n.startsWith('0')) n = CC + n.slice(1); else if (n.length <= 9) n = CC + n;
  return n.length >= 8 && n.length <= 15 ? n : '';
}

/* ---------- Cola de mensajes ---------- */
function enq(key, kind, bid, to, tpl, params, text, at, due) {
  if (!to) return;
  db.prepare('INSERT OR IGNORE INTO outbox(key,kind,bid,to_num,tpl,params,text,at,due) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(key, kind, bid, to, tpl, JSON.stringify(params), text, at, due || null);
}
const LBL = { c: 'Nueva reserva', u: 'Reserva modificada', x: 'Reserva cancelada' };
function notify(k, x) {
  const cfg = getCfg(), br = cfg.bars.find(b => b.id == x.b) || { n: '', wa: '' }, f = fdate(x.d), h = fm(x.t), now = Date.now();
  const id = `${k}:${x.id}:${now}`, info = `${LBL[k]}: ${x.name} (+${x.wa}) · ${x.sn} · ${f} ${h} · ${br.n}`;
  db.prepare('INSERT INTO log(at,txt) VALUES(?,?)').run(now, info);
  const T = {
    c: [[x.name, cfg.shop, x.sn, f, h], `¡Hola, ${x.name}! Tu turno en ${cfg.shop} quedó confirmado: ${x.sn}, ${f} a las ${h}.`],
    u: [[x.name, cfg.shop, x.sn, f, h], `¡Hola, ${x.name}! Tu turno en ${cfg.shop} cambió: ${x.sn}, ${f} a las ${h}.`],
    x: [[x.name, cfg.shop, f, h], `Hola, ${x.name}. Tu turno en ${cfg.shop} del ${f} a las ${h} fue cancelado.`]
  }[k];
  enq(id, k, x.id, x.wa, TPL[k], T[0], T[1], now);
  const bw = normWa(br.wa);
  if (bw) enq('b' + id, 'b', x.id, bw, TPL.b, [LBL[k], x.name, '+' + x.wa, x.sn, f, h], info, now);
}
function ensureReminder(x) {
  const cfg = getCfg(), key = `r:${x.id}:${x.d}:${x.t}`, due = utc(x.d, x.t), at = due - cfg.rem.min * 60000;
  db.prepare("UPDATE outbox SET st='cancelado' WHERE bid=? AND kind='r' AND st='pendiente' AND key!=?").run(x.id, key);
  if (!cfg.rem.on || at <= Date.now()) return;
  enq(key, 'r', x.id, x.wa, TPL.r, [x.name, cfg.shop, fm(x.t), x.sn],
    `¡Hola, ${x.name}! Te recordamos que hoy tenés un turno en ${cfg.shop} a las ${fm(x.t)} (${x.sn}). ¡Te esperamos!`, at, due);
  db.prepare("UPDATE outbox SET at=?, st='pendiente' WHERE key=? AND st IN ('pendiente','cancelado')").run(at, key);
}
const syncReminders = () => db.prepare('SELECT * FROM bookings WHERE d>=?').all(todayKey()).forEach(ensureReminder);

async function sendWA(r) {
  const body = {
    messaging_product: 'whatsapp', to: r.to_num, type: 'template',
    template: { name: r.tpl, language: { code: WA.lang }, components: [{ type: 'body',
      parameters: JSON.parse(r.params).map(t => ({ type: 'text', text: String(t).replace(/[\r\n\t]+/g, ' ').slice(0, 200) })) }] }
  };
  const res = await fetch(`https://graph.facebook.com/${WA.ver}/${WA.id}/messages`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + WA.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(res.status + ' ' + (await res.text()));
}
let ticking = false;
async function tick() {
  if (ticking || !WA_ON) return;
  ticking = true;
  try {
    const now = Date.now();
    const rows = db.prepare("SELECT * FROM outbox WHERE st='pendiente' AND at<=? ORDER BY at LIMIT 20").all(now);
    for (const r of rows) {
      if (r.kind === 'r' && r.due && now > r.due) { db.prepare("UPDATE outbox SET st='vencido' WHERE id=?").run(r.id); continue; }
      db.prepare("UPDATE outbox SET st='enviando' WHERE id=?").run(r.id);
      try {
        await sendWA(r);
        db.prepare("UPDATE outbox SET st='enviado', sent_at=?, err=NULL WHERE id=?").run(Date.now(), r.id);
      } catch (e) {
        const tries = r.tries + 1;
        db.prepare('UPDATE outbox SET st=?, tries=?, at=?, err=? WHERE id=?')
          .run(tries >= 5 ? 'fallido' : 'pendiente', tries, Date.now() + tries * 60000, String(e.message).slice(0, 300), r.id);
        console.error('WhatsApp falló:', r.id, e.message);
      }
    }
  } finally { ticking = false; }
}

/* ---------- Reservas ---------- */
const ser = r => ({ id: r.id, s: r.svc, sn: r.sn, p: r.p, m: r.m, b: r.b, d: r.d, t: r.t, name: r.name, wa: r.wa, nw: r.nw ? 1 : undefined });
function validate(x, admin, ign) {
  const cfg = getCfg(), sv = cfg.svcs.find(s => s.id == x.svc), br = cfg.bars.find(b => b.id == x.b);
  const name = String(x.name || '').trim().slice(0, 60), wa = normWa(x.wa), t = Number.isInteger(+x.t) && x.t !== null && x.t !== '' ? +x.t : NaN;
  if (!sv || !br) return { err: 'Servicio o barbero inválido' };
  if (!validDate(x.d)) return { err: 'Fecha inválida' };
  if (!name) return { err: 'Falta el nombre' };
  if (!wa) return { err: 'WhatsApp inválido' };
  if (isNaN(t) || t < tm(cfg.open) || t + sv.m > tm(cfg.close)) return { err: 'Horario fuera de atención' };
  if (!admin) {
    const td = todayKey();
    if (cfg.off.includes(dow(x.d))) return { err: 'Ese día no se atiende' };
    if ((t - tm(cfg.open)) % cfg.slot) return { err: 'Horario inválido' };
    if (x.d < td || x.d > addDays(td, 30) || (x.d === td && t <= nowMin())) return { err: 'Fecha no disponible' };
  }
  const clash = db.prepare('SELECT 1 FROM bookings WHERE b=? AND d=? AND id!=? AND ?<t+m AND t<?').get(br.id, x.d, ign || 0, t, t + sv.m);
  if (clash) return { err: 'Ese horario ya fue reservado', busy: 1 };
  return { sv, br, name, wa, t };
}
function saveBooking(x, admin) {
  const v = validate(x, admin, x.id);
  if (v.err) return v;
  try {
    let row;
    if (x.id) {
      const old = db.prepare('SELECT id FROM bookings WHERE id=?').get(x.id);
      if (!old) return { err: 'La reserva no existe' };
      db.prepare('UPDATE bookings SET svc=?,sn=?,p=?,m=?,b=?,d=?,t=?,name=?,wa=? WHERE id=?')
        .run(v.sv.id, v.sv.n, v.sv.p, v.sv.m, v.br.id, x.d, v.t, v.name, v.wa, x.id);
      row = db.prepare('SELECT * FROM bookings WHERE id=?').get(x.id);
      notify('u', row);
    } else {
      const r = db.prepare('INSERT INTO bookings(svc,sn,p,m,b,d,t,name,wa,nw,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(v.sv.id, v.sv.n, v.sv.p, v.sv.m, v.br.id, x.d, v.t, v.name, v.wa, admin ? 0 : 1, Date.now());
      row = db.prepare('SELECT * FROM bookings WHERE id=?').get(r.lastInsertRowid);
      notify('c', row);
    }
    ensureReminder(row);
    return { row };
  } catch (e) {
    if (String(e.code || e.message).includes('CONSTRAINT')) return { err: 'Ese horario ya fue reservado', busy: 1 };
    throw e;
  }
}
function removeBooking(id) {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM bookings WHERE id=?').run(id);
  db.prepare("UPDATE outbox SET st='cancelado' WHERE bid=? AND kind='r' AND st='pendiente'").run(id);
  notify('x', row);
  return true;
}

/* ---------- Ajustes ---------- */
function cleanCfg(x, o) {
  const n = v => Math.max(0, Math.round(+v) || 0), s = (v, l) => String(v ?? '').trim().slice(0, l), hm = v => /^\d{2}:\d{2}$/.test(v) ? v : null;
  const c = {
    shop: s(x.shop, 60) || o.shop, cur: String(x.cur || o.cur).slice(0, 6), open: hm(x.open) || o.open, close: hm(x.close) || o.close,
    off: [...new Set((x.off || []).map(Number).filter(d => d >= 0 && d <= 6))],
    slot: Math.min(120, Math.max(5, n(x.slot) || o.slot)),
    svcs: (x.svcs || []).slice(0, 30).map(v => ({ id: n(v.id), n: s(v.n, 60) || 'Servicio', m: Math.min(480, Math.max(5, n(v.m) || 30)), p: n(v.p) })),
    bars: (x.bars || []).slice(0, 20).map(v => ({ id: n(v.id), n: s(v.n, 40) || 'Barbero', wa: s(v.wa, 30) })),
    rem: { on: !!(x.rem && x.rem.on), min: Math.min(720, n(x.rem && x.rem.min) || 30) },
    wa: s(x.wa, 30)
  };
  return c.svcs.length && c.bars.length && tm(c.open) < tm(c.close) ? c : null;
}

/* ---------- Seguridad ---------- */
const hits = new Map();
function limit(key, max, ms) {
  const n = Date.now(), a = (hits.get(key) || []).filter(t => n - t < ms);
  if (a.length >= max) { hits.set(key, a); return false; }
  a.push(n); hits.set(key, a); return true;
}
setInterval(() => hits.clear(), 3600e3).unref();
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const mkToken = () => { const e = Date.now() + 12 * 3600e3; return e + '.' + sign(String(e)); };
function auth(req, res, next) {
  try {
    const [e, s] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
    if (e && s && +e > Date.now() && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sign(e)))) return next();
  } catch (_) { /* token inválido */ }
  res.status(401).json({ error: 'No autorizado' });
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

/* ---------- API ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '60kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }); next(); });
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/health', (req, res) => res.json({ ok: 1, whatsapp: WA_ON }));

app.get('/api/state', (req, res) => {
  const c = getCfg();
  res.json({
    shop: c.shop, cur: c.cur, open: c.open, close: c.close, off: c.off, slot: c.slot, svcs: c.svcs,
    bars: c.bars.map(b => ({ id: b.id, n: b.n })),
    busy: db.prepare('SELECT id,b,d,t,m FROM bookings WHERE d>=?').all(todayKey())
  });
});

app.post('/api/book', (req, res) => {
  if (!limit('book' + req.ip, 10, 3600e3)) return res.status(429).json({ error: 'Demasiados intentos. Probá más tarde.' });
  const wa = normWa(req.body.wa);
  if (wa) {
    const td = todayKey(), c = db.prepare('SELECT COUNT(*) c FROM bookings WHERE wa=? AND (d>? OR (d=? AND t>?))').get(wa, td, td, nowMin()).c;
    if (c >= 3) return res.status(400).json({ error: 'Ya tenés 3 turnos activos.' });
  }
  const r = saveBooking({ ...req.body, id: 0 }, false);
  if (r.err) return res.status(r.busy ? 409 : 400).json({ error: r.err });
  res.json({ ok: 1 });
});

app.post('/api/admin/login', (req, res) => {
  if (!limit('login' + req.ip, 8, 600e3)) return res.status(429).json({ error: 'Demasiados intentos' });
  if (!crypto.timingSafeEqual(sha(req.body.pin || ''), sha(PIN))) return res.status(401).json({ error: 'PIN incorrecto' });
  res.json({ token: mkToken() });
});

app.get('/api/admin/state', auth, (req, res) => {
  res.json({
    ...getCfg(),
    bk: db.prepare('SELECT * FROM bookings WHERE d>=? ORDER BY d,t').all(addDays(todayKey(), -60)).map(ser),
    log: db.prepare('SELECT at,txt FROM log ORDER BY id DESC LIMIT 300').all(),
    q: db.prepare('SELECT to_num AS "to", text, st FROM outbox ORDER BY id DESC LIMIT 15').all().reverse(),
    pend: db.prepare("SELECT COUNT(*) c FROM outbox WHERE st='pendiente'").get().c, wa_on: WA_ON
  });
});

app.put('/api/admin/settings', auth, (req, res) => {
  const c = cleanCfg(req.body || {}, getCfg());
  if (!c) return res.status(400).json({ error: 'Ajustes inválidos' });
  kvSet('cfg', c); syncReminders(); res.json({ ok: 1 });
});

app.post('/api/admin/booking', auth, (req, res) => {
  const r = saveBooking({ ...req.body, id: +req.body.id || 0 }, true);
  if (r.err) return res.status(r.busy ? 409 : 400).json({ error: r.err });
  res.json({ ok: 1, booking: ser(r.row) });
});
app.delete('/api/admin/booking/:id', auth, (req, res) => removeBooking(+req.params.id) ? res.json({ ok: 1 }) : res.status(404).json({ error: 'No existe' }));
app.post('/api/admin/seen', auth, (req, res) => { db.prepare('UPDATE bookings SET nw=0').run(); res.json({ ok: 1 }); });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Error del servidor' }); });

if (require.main === module) {
  app.listen(PORT, () => console.log(`BarberApp en puerto ${PORT} · WhatsApp ${WA_ON ? 'conectado' : 'SIN configurar (los mensajes quedan en cola)'}`));
  setInterval(() => tick().catch(e => console.error(e)), 30000);
  tick().catch(e => console.error(e));
}
module.exports = { app, saveBooking, removeBooking, cleanCfg, syncReminders, db, tick, normWa };
