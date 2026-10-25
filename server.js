const express = require('express');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const EN_VERCEL = !!process.env.VERCEL;
// URL que se graba en los QR. Sin dominio propio, en Vercel se usa el dominio de producción del
// proyecto (xxx.vercel.app) también en los previews, para que los QR no apunten a un deploy temporal.
const BASE_URL = (process.env.BASE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
  || `http://localhost:${PORT}`).replace(/\/+$/, '');

if (EN_VERCEL && !process.env.SESSION_SECRET) throw new Error('Falta la variable de entorno SESSION_SECRET');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
// En Vercel los archivos de public/ los sirve la CDN; esto es para desarrollo local.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({
  name: 'sess',
  secret: process.env.SESSION_SECRET || 'cambia-esta-clave-en-produccion',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  sameSite: 'lax',
  secure: EN_VERCEL,
}));

// Express 4 no captura errores de handlers async: los pasa a next() para el manejador de errores.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const normCaja = (s) => String(s || '').trim().toUpperCase().slice(0, 20);
const normCI = (s) => String(s || '').trim().toUpperCase().slice(0, 20) || null;
const cajasDe = (puntoId) => db.all('SELECT * FROM cajas WHERE punto_id = $1 ORDER BY lower(nombre)', [puntoId]);
// Sólo vale una caja que exista en el punto; si no, el paquete queda sin ubicación.
const cajaValida = async (puntoId, nombre) =>
  (await db.one('SELECT nombre FROM cajas WHERE punto_id = $1 AND nombre = $2', [puntoId, normCaja(nombre)]))?.nombre || null;
const esDuplicado = (e) => e.code === '23505';

app.use(ah(async (req, res, next) => {
  res.locals.user = null;
  if (req.session.puntoId) {
    res.locals.user = await db.one('SELECT * FROM puntos WHERE id = $1', [req.session.puntoId]);
    if (!res.locals.user) req.session = null;
  }
  res.locals.path = req.path;
  res.locals.url = req.originalUrl;
  next();
}));

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

const ESTADOS = {
  por_recibir: 'Por recibir',
  en_punto: 'En el punto',
  entregado: 'Entregado',
};
app.locals.ESTADOS = ESTADOS;
app.locals.icon = require('./icons');
app.locals.mapsUrl = (u) => {
  if (u.lat != null && u.lng != null) return `https://www.google.com/maps/search/?api=1&query=${u.lat},${u.lng}`;
  if (u.direccion) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(u.direccion)}`;
  return null;
};
app.locals.fmtFecha = (d) => d
  ? new Date(d).toLocaleString('es-BO', { timeZone: 'America/La_Paz', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';

// ---------- públicas ----------
app.get('/', (req, res) => res.render('landing'));

app.get('/registro', (req, res) => res.render('registro', { error: null, form: {} }));
app.post('/registro', ah(async (req, res) => {
  const form = req.body;
  const email = String(form.email || '').trim().toLowerCase();
  const err = (m) => res.status(400).render('registro', { error: m, form });

  if (!form.nombre?.trim() || !form.paqueteria?.trim()) return err('Completa tu nombre y el de la paquetería.');
  if (!/^[^\s@]+@gmail\.com$/.test(email)) return err('Ingresa un correo de Gmail válido.');
  if (onlyDigits(form.whatsapp).length < 7) return err('Ingresa un número de WhatsApp válido.');
  if (String(form.password || '').length < 6) return err('La contraseña debe tener al menos 6 caracteres.');

  let r;
  try {
    r = await db.one(`INSERT INTO puntos (nombre, paqueteria, email, whatsapp, password)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
      form.nombre.trim(), form.paqueteria.trim(), email,
      onlyDigits(form.whatsapp), hashPassword(form.password)]);
  } catch (e) {
    if (esDuplicado(e)) return err('Ese correo ya está registrado.');
    throw e;
  }
  req.session.puntoId = r.id;
  res.redirect('/app?bienvenida=1');
}));

app.get('/login', (req, res) => res.render('login', { error: null, email: '', next: req.query.next || '' }));
app.post('/login', ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const p = await db.one('SELECT * FROM puntos WHERE email = $1', [email]);
  if (!p || !checkPassword(String(req.body.password || ''), p.password)) {
    return res.status(401).render('login', { error: 'Correo o contraseña incorrectos.', email, next: req.body.next || '' });
  }
  req.session.puntoId = p.id;
  const next = String(req.body.next || '');
  res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/app');
}));

app.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });

// ---------- app (requiere login) ----------
app.get('/app', requireAuth, ah(async (req, res) => {
  const user = res.locals.user;
  const estado = ESTADOS[req.query.estado] ? req.query.estado : 'por_recibir';
  const q = String(req.query.q || '').trim();

  const counts = Object.fromEntries(Object.keys(ESTADOS).map((k) => [k, 0]));
  for (const row of await db.all('SELECT estado, COUNT(*)::int n FROM paquetes WHERE punto_id = $1 GROUP BY estado', [user.id])) {
    counts[row.estado] = row.n;
  }

  let sql = 'SELECT * FROM paquetes WHERE punto_id = $1 AND estado = $2';
  const params = [user.id, estado];
  if (q) {
    sql += ` AND (codigo ILIKE $3 OR destinatario_nombre ILIKE $3 OR remitente_nombre ILIKE $3 OR destinatario_whatsapp ILIKE $3
      OR remitente_ci ILIKE $3 OR destinatario_ci ILIKE $3)`;
    params.push(`%${q}%`);
  }
  sql += ' ORDER BY id DESC LIMIT 200';
  const paquetes = await db.all(sql, params);

  res.render('paquetes', { estado, q, counts, paquetes, bienvenida: req.query.bienvenida });
}));

app.get('/app/registrar', requireAuth, ah(async (req, res) =>
  res.render('registrar', { error: null, form: {}, cajas: await cajasDe(res.locals.user.id) })));
app.post('/app/registrar', requireAuth, ah(async (req, res) => {
  const user = res.locals.user;
  const f = req.body;
  const err = async (m) => res.status(400).render('registrar', { error: m, form: f, cajas: await cajasDe(user.id) });
  if (!f.remitente_nombre?.trim() || !f.destinatario_nombre?.trim()) {
    return err('El nombre del remitente y del destinatario son obligatorios.');
  }
  if (onlyDigits(f.remitente_whatsapp).length < 7 || onlyDigits(f.destinatario_whatsapp).length < 7) {
    return err('Revisa los números de WhatsApp.');
  }
  const precio = f.precio === '' || f.precio == null ? null : Number(f.precio);
  const ubicacion = await cajaValida(user.id, f.ubicacion);

  const codigo = await db.tx(async (c) => {
    // Bloquea la fila del punto para que dos registros simultáneos no tomen el mismo número.
    await c.query('SELECT 1 FROM puntos WHERE id = $1 FOR UPDATE', [user.id]);
    const { n: numero } = (await c.query('SELECT COALESCE(MAX(numero), 0) + 1 n FROM paquetes WHERE punto_id = $1', [user.id])).rows[0];
    const codigo = `P${user.id}-${String(numero).padStart(5, '0')}`;
    await c.query(`INSERT INTO paquetes
      (punto_id, numero, codigo, token, remitente_nombre, remitente_whatsapp, remitente_ci,
       destinatario_nombre, destinatario_whatsapp, destinatario_ci, descripcion, moneda, precio, ubicacion)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [
      user.id, numero, codigo, crypto.randomBytes(12).toString('hex'),
      f.remitente_nombre.trim(), '591' + onlyDigits(f.remitente_whatsapp).replace(/^591/, ''), normCI(f.remitente_ci),
      f.destinatario_nombre.trim(), '591' + onlyDigits(f.destinatario_whatsapp).replace(/^591/, ''), normCI(f.destinatario_ci),
      (f.descripcion || '').trim() || null, f.moneda === 'USD' ? 'USD' : 'Bs.',
      Number.isFinite(precio) ? precio : null, ubicacion]);
    return codigo;
  });
  res.redirect(`/app/paquete/${codigo}?nuevo=1`);
}));

app.get('/app/escanear', requireAuth, (req, res) => res.render('escanear'));

// Busca un paquete por código o token, sólo del punto logueado.
function findPaquete(userId, ref) {
  return db.one('SELECT * FROM paquetes WHERE punto_id = $1 AND (codigo = $2 OR token = $3)',
    [userId, String(ref).toUpperCase(), String(ref)]);
}

// Destino del QR. Requiere login y que el paquete pertenezca al punto.
app.get('/q/:token', requireAuth, ah(async (req, res) => {
  const p = await db.one('SELECT * FROM paquetes WHERE token = $1', [req.params.token]);
  if (!p || p.punto_id !== res.locals.user.id) {
    return res.status(403).render('denegado');
  }
  res.redirect(`/app/paquete/${p.codigo}`);
}));

app.get('/app/paquete/:ref', requireAuth, ah(async (req, res) => {
  const p = await findPaquete(res.locals.user.id, req.params.ref);
  if (!p) return res.status(404).render('denegado');
  const qrUrl = `${BASE_URL}/q/${p.token}`;
  const qr = await QRCode.toDataURL(qrUrl, { margin: 1, width: 320 });
  res.render('paquete', { p, qr, nuevo: req.query.nuevo, cajas: await cajasDe(res.locals.user.id) });
}));

app.get('/app/paquete/:ref/ticket', requireAuth, ah(async (req, res) => {
  const p = await findPaquete(res.locals.user.id, req.params.ref);
  if (!p) return res.status(404).render('denegado');
  const qr = await QRCode.toDataURL(`${BASE_URL}/q/${p.token}`, { margin: 0, width: 300 });
  res.render('ticket', { p, qr });
}));

app.post('/app/paquete/:ref/estado', requireAuth, ah(async (req, res) => {
  const p = await findPaquete(res.locals.user.id, req.params.ref);
  if (!p) return res.status(404).render('denegado');
  const { accion } = req.body;
  if (accion === 'recibir') {
    await db.run(`UPDATE paquetes SET estado = 'en_punto', ubicacion = COALESCE($1, ubicacion),
      recibido_at = now() WHERE id = $2`, [await cajaValida(p.punto_id, req.body.ubicacion), p.id]);
  } else if (accion === 'entregar') {
    await db.run(`UPDATE paquetes SET estado = 'entregado', entregado_at = now() WHERE id = $1`, [p.id]);
  } else if (accion === 'revertir') {
    const prev = p.estado === 'entregado' ? 'en_punto' : 'por_recibir';
    await db.run(`UPDATE paquetes SET estado = $1, entregado_at = NULL,
      recibido_at = CASE WHEN $1 = 'por_recibir' THEN NULL ELSE recibido_at END WHERE id = $2`, [prev, p.id]);
  } else if (accion === 'eliminar' && p.estado === 'por_recibir') {
    await db.run('DELETE FROM paquetes WHERE id = $1', [p.id]);
    return res.redirect('/app');
  }
  res.redirect(`/app/paquete/${p.codigo}`);
}));

// ---------- cajas ----------
app.get('/app/cajas', requireAuth, ah(async (req, res) => {
  const cajas = await db.all(`SELECT c.*, (SELECT COUNT(*)::int FROM paquetes p WHERE p.punto_id = c.punto_id
      AND p.ubicacion = c.nombre AND p.estado <> 'entregado') activos
    FROM cajas c WHERE c.punto_id = $1 ORDER BY lower(c.nombre)`, [res.locals.user.id]);
  res.render('cajas', { cajas, error: req.query.error || null });
}));

app.post('/app/cajas', requireAuth, ah(async (req, res) => {
  const nombre = normCaja(req.body.nombre);
  if (!nombre) return res.redirect('/app/cajas?error=' + encodeURIComponent('Escribe un nombre para la caja.'));
  const r = await db.run('INSERT INTO cajas (punto_id, nombre) VALUES ($1, $2) ON CONFLICT DO NOTHING', [res.locals.user.id, nombre]);
  if (!r.rowCount) return res.redirect('/app/cajas?error=' + encodeURIComponent(`Ya existe la caja ${nombre}.`));
  res.redirect('/app/cajas');
}));

app.post('/app/cajas/:id', requireAuth, ah(async (req, res) => {
  const user = res.locals.user;
  const id = Number(req.params.id);
  const c = Number.isInteger(id) && await db.one('SELECT * FROM cajas WHERE id = $1 AND punto_id = $2', [id, user.id]);
  if (!c) return res.redirect('/app/cajas');
  if (req.body.accion === 'eliminar') {
    // Los paquetes conservan el nombre de la caja como texto en su historial.
    await db.run('DELETE FROM cajas WHERE id = $1', [c.id]);
    return res.redirect('/app/cajas');
  }
  const nombre = normCaja(req.body.nombre);
  if (!nombre) return res.redirect('/app/cajas?error=' + encodeURIComponent('El nombre no puede quedar vacío.'));
  if (nombre === c.nombre) return res.redirect('/app/cajas');
  try {
    await db.tx(async (t) => {
      await t.query('UPDATE cajas SET nombre = $1 WHERE id = $2', [nombre, c.id]);
      await t.query('UPDATE paquetes SET ubicacion = $1 WHERE punto_id = $2 AND ubicacion = $3', [nombre, user.id, c.nombre]);
    });
  } catch (e) {
    if (esDuplicado(e)) return res.redirect('/app/cajas?error=' + encodeURIComponent(`Ya existe la caja ${nombre}.`));
    throw e;
  }
  res.redirect('/app/cajas');
}));

// ---------- dirección del punto ----------
app.post('/app/direccion', requireAuth, ah(async (req, res) => {
  const direccion = String(req.body.direccion || '').trim().slice(0, 300) || null;
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  const ok = req.body.lat !== '' && req.body.lng !== '' && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  await db.run('UPDATE puntos SET direccion = $1, lat = $2, lng = $3 WHERE id = $4',
    [direccion, ok ? lat : null, ok ? lng : null, res.locals.user.id]);
  const back = String(req.body.back || '');
  res.redirect(back.startsWith('/app') ? back : '/app');
}));

app.use((req, res) => res.status(404).render('denegado'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <div style="font-family:system-ui,sans-serif;max-width:420px;margin:20vh auto;padding:16px;text-align:center">
    <h2>Ocurrió un error</h2><p style="color:#78716c">Intenta de nuevo en unos segundos.</p>
    <a href="/app" style="color:#ea580c;font-weight:700">Volver</a></div>`);
});

// En Vercel se exporta la app y la plataforma la ejecuta como función; en local se levanta el servidor.
if (!EN_VERCEL) app.listen(PORT, () => console.log(`PaqueteYa corriendo en ${BASE_URL}`));

module.exports = app;
