/**
 * Driver de PostgreSQL.
 *
 * Expone los mismos métodos que json-file.js, más init(), que
 * CREA LAS TABLAS SOLO AL ARRANCAR ejecutando schema.sql.
 * No necesitas psql ni ningún cliente SQL.
 *
 *   npm install pg
 *   STORAGE=postgres DATABASE_URL=postgres://… npm start
 *
 * Al arrancar el servidor:
 *   1. toma un advisory lock (evita que dos instancias creen
 *      las tablas a la vez y choquen)
 *   2. corre schema.sql — todo es CREATE ... IF NOT EXISTS,
 *      así que si las tablas ya están, no hace nada
 *   3. si la tabla tareas está vacía, carga data/seed.json
 *   4. suelta el lock
 *
 * Funciona igual en Neon, Supabase, Railway o RDS.
 */

const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

const q = (text, params) => pool.query(text, params);

/* Número arbitrario pero fijo: todas las instancias compiten por él. */
const LOCK_ID = 728461;

/* ── Mapeo fila ⇄ objeto ────────────────────────────── */
/* Las fechas se piden ya formateadas para que pg no las
   convierta a Date y se corran por zona horaria. */

const COLS_TAREA = `id, codigo, titulo, proyecto, area, responsable, estado,
  progreso::float8 AS progreso, notas,
  to_char(inicio,'YYYY-MM-DD') AS inicio,
  to_char(fin,'YYYY-MM-DD')    AS fin,
  comentarios`;

const COLS_PROYECTO = `id, nombre, seccion, area, estado,
  to_char(entrega,'YYYY-MM-DD') AS entrega, nota`;

const COLS_HITO = `id, titulo, to_char(fecha,'YYYY-MM-DD') AS fecha, fijo`;

/* ── Migración automática ───────────────────────────── */

async function init() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Falta DATABASE_URL. Ejemplo: DATABASE_URL=postgres://usuario:clave@host:5432/base');
  }

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    const sql = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(sql);          // multi-statement: corre como una transacción

    const { rows } = await client.query('SELECT count(*)::int AS n FROM tareas');
    if (rows[0].n > 0) {
      return { tablas:'listas', sembrado:false, tareas:rows[0].n };
    }

    // Base vacía: cargamos el seed generado desde el Excel.
    const seed = JSON.parse(
      await fs.readFile(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8'));
    await client.query('BEGIN');
    await escribirTodo(client, seed);
    await client.query('COMMIT');

    return { tablas:'creadas', sembrado:true, tareas:seed.tareas.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

/* Reemplaza el contenido completo. El orden importa por la FK:
   proyectos entra antes que tareas y sale después. */
async function escribirTodo(client, { tareas = [], proyectos = [], hitos = [] }) {
  await client.query('DELETE FROM tareas');
  await client.query('DELETE FROM hitos');
  if (proyectos.length) await client.query('DELETE FROM proyectos');

  for (const p of proyectos) {
    await client.query(
      `INSERT INTO proyectos (id, nombre, seccion, area, estado, entrega, nota)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.id, p.nombre, p.seccion, p.area, p.estado || 'pendiente', p.entrega || null, p.nota || null]);
  }
  for (const t of tareas) {
    await client.query(
      `INSERT INTO tareas (id, codigo, titulo, proyecto, area, responsable, estado,
                           progreso, notas, inicio, fin, comentarios)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [t.id, t.codigo, t.titulo, t.proyecto || null, t.area || 'SIN ÁREA',
       t.responsable || 'u-sin', t.estado || 'pendiente', t.progreso || 0,
       t.notas || null, t.inicio || null, t.fin || null,
       JSON.stringify(t.comentarios || [])]);
  }
  for (const h of hitos) {
    await client.query(
      `INSERT INTO hitos (id, titulo, fecha, fijo) VALUES ($1,$2,$3,$4)`,
      [h.id, h.titulo, h.fecha, !!h.fijo]);
  }
}

async function subirVersion(client) {
  const { rows } = await (client || pool).query(
    `UPDATE board SET version = version + 1, updated_at = now()
     WHERE id = 1 RETURNING version, updated_at`);
  return rows[0];
}

/* ── API del driver ─────────────────────────────────── */

module.exports = {
  init,

  async getState() {
    const [board, tareas, proyectos, hitos] = await Promise.all([
      q('SELECT version, updated_at FROM board WHERE id = 1'),
      q(`SELECT ${COLS_TAREA} FROM tareas ORDER BY fin NULLS LAST, codigo`),
      q(`SELECT ${COLS_PROYECTO} FROM proyectos ORDER BY nombre`),
      q(`SELECT ${COLS_HITO} FROM hitos ORDER BY fecha`)
    ]);
    return {
      version: board.rows[0]?.version ?? 0,
      updatedAt: board.rows[0]?.updated_at ?? null,
      tareas: tareas.rows,
      proyectos: proyectos.rows,
      hitos: hitos.rows
    };
  },

  async setState({ tareas, proyectos, hitos }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await escribirTodo(client, { tareas, proyectos, hitos });
      const v = await subirVersion(client);
      await client.query('COMMIT');
      return { version: v.version, updatedAt: v.updated_at, tareas, proyectos, hitos };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async reset() {
    const seed = JSON.parse(
      await fs.readFile(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8'));
    return module.exports.setState(seed);
  },

  async getTarea(id) {
    const { rows } = await q(`SELECT ${COLS_TAREA} FROM tareas WHERE id = $1`, [id]);
    return rows[0] || null;
  },

  async createTarea(f) {
    const { rows } = await q(
      `INSERT INTO tareas (id, codigo, titulo, proyecto, area, responsable, estado,
                           progreso, notas, inicio, fin, comentarios)
       VALUES (COALESCE($1, 't' || nextval('tarea_seq')),
               COALESCE($2, 'T-' || lpad(((SELECT count(*) FROM tareas) + 1)::text, 3, '0')),
               $3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${COLS_TAREA}`,
      [f.id || null, f.codigo || null, f.titulo, f.proyecto || null,
       f.area || 'SIN ÁREA', f.responsable || 'u-sin', f.estado || 'pendiente',
       f.progreso || 0, f.notas || null, f.inicio || null, f.fin || null,
       JSON.stringify(f.comentarios || [])]);
    await subirVersion();
    return rows[0];
  },

  async updateTarea(id, patch) {
    const permitidos = ['titulo','proyecto','area','responsable','estado',
                        'progreso','notas','inicio','fin','comentarios'];
    const claves = Object.keys(patch).filter(k => permitidos.includes(k));
    if (!claves.length) return module.exports.getTarea(id);

    const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const vals = claves.map(k => k === 'comentarios' ? JSON.stringify(patch[k]) : patch[k]);

    const { rows } = await q(
      `UPDATE tareas SET ${sets} WHERE id = $1 RETURNING ${COLS_TAREA}`, [id, ...vals]);
    if (!rows[0]) return null;
    await subirVersion();
    return rows[0];
  },

  async deleteTarea(id) {
    const { rowCount } = await q('DELETE FROM tareas WHERE id = $1', [id]);
    if (rowCount) await subirVersion();
    return rowCount > 0;
  },

  async addComment(tareaId, comentario) {
    const { rows } = await q(
      `UPDATE tareas SET comentarios = comentarios || $2::jsonb
       WHERE id = $1 RETURNING ${COLS_TAREA}`,
      [tareaId, JSON.stringify([comentario])]);
    if (!rows[0]) return null;
    await subirVersion();
    return rows[0];
  },

  async createHito(f) {
    const { rows } = await q(
      `INSERT INTO hitos (id, titulo, fecha, fijo)
       VALUES (COALESCE($1, 'h' || nextval('hito_seq')), $2, $3, $4)
       RETURNING ${COLS_HITO}`,
      [f.id || null, f.titulo, f.fecha, !!f.fijo]);
    await subirVersion();
    return rows[0];
  },

  async deleteHito(id) {
    const { rowCount } = await q('DELETE FROM hitos WHERE id = $1', [id]);
    if (rowCount) await subirVersion();
    return rowCount > 0;
  },

  async close(){ await pool.end(); }
};
