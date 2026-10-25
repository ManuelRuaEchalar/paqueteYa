// Copia los datos de la base SQLite local (data/app.db) a Postgres. Uso: npm run db:migrar
// Aplica el esquema primero. No pisa filas que ya existan (mismo id), así que se puede repetir.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { pool, tx } = require('../db');

const archivo = process.argv[2] || path.join(__dirname, '..', 'data', 'app.db');
const sqlite = new DatabaseSync(archivo, { readOnly: true });
const cols = (t) => sqlite.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
// SQLite guarda las fechas como texto UTC "YYYY-MM-DD HH:MM:SS".
const fecha = (s) => (s ? s.replace(' ', 'T') + 'Z' : null);

const TABLAS = {
  puntos: ['id', 'nombre', 'paqueteria', 'email', 'whatsapp', 'password', 'direccion', 'lat', 'lng', 'created_at'],
  paquetes: ['id', 'punto_id', 'numero', 'codigo', 'token', 'estado',
    'remitente_nombre', 'remitente_whatsapp', 'remitente_ci', 'destinatario_nombre', 'destinatario_whatsapp', 'destinatario_ci',
    'descripcion', 'moneda', 'precio', 'ubicacion', 'created_at', 'recibido_at', 'entregado_at'],
  cajas: ['id', 'punto_id', 'nombre', 'created_at'],
};
const FECHAS = new Set(['created_at', 'recibido_at', 'entregado_at']);

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8'));

  await tx(async (c) => {
    for (const [tabla, campos] of Object.entries(TABLAS)) {
      const existentes = cols(tabla);
      const faltan = campos.filter((f) => !existentes.includes(f));
      if (faltan.length) throw new Error(`${tabla}: faltan columnas ${faltan.join(', ')} (abre la app con SQLite una vez para migrarla)`);

      let nuevas = 0;
      const filas = sqlite.prepare(`SELECT ${campos.join(', ')} FROM ${tabla} ORDER BY id`).all();
      for (const f of filas) {
        const valores = campos.map((k) => (FECHAS.has(k) ? fecha(f[k]) : f[k]));
        const r = await c.query(
          `INSERT INTO ${tabla} (${campos.join(', ')}) VALUES (${campos.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT DO NOTHING`, valores);
        nuevas += r.rowCount;
      }
      // Los ids se copiaron tal cual: el contador de identidad debe seguir desde el mayor.
      await c.query(`SELECT setval(pg_get_serial_sequence('${tabla}', 'id'), COALESCE((SELECT MAX(id) FROM ${tabla}), 0) + 1, false)`);
      console.log(`${tabla}: ${filas.length} en SQLite, ${nuevas} copiadas`);
    }
  });
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
