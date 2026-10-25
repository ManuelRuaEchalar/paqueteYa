const { Pool } = require('pg');
const { attachDatabasePool } = require('@vercel/functions');

if (!process.env.DATABASE_URL) throw new Error('Falta la variable de entorno DATABASE_URL');

// Supabase, pooler en modo transacción (puerto 6543): en serverless se recomienda 1 conexión por instancia.
// node-postgres no crea prepared statements con nombre, así que es compatible con ese modo.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: process.env.VERCEL ? 1 : 5,
});
// En Vercel (Fluid compute) libera las conexiones inactivas antes de suspender la función.
attachDatabasePool(pool);

const all = async (sql, params = []) => (await pool.query(sql, params)).rows;
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;
const run = (sql, params = []) => pool.query(sql, params);

// Ejecuta fn(client) dentro de una transacción con una sola conexión.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, all, one, run, tx };
