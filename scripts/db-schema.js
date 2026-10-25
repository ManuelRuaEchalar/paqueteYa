// Crea o actualiza las tablas en Postgres. Uso: npm run db:schema
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8'));
  console.log('Esquema aplicado.');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
