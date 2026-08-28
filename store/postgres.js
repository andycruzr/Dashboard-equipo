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

const COLS_TAREA = `id, codigo, titulo, proyecto, carpeta, area, responsable, estado,
  progreso::float8 AS progreso, notas, prioridad, equipo,
  to_char(entrega,'YYYY-MM-DD') AS entrega,
  to_char(inicio,'YYYY-MM-DD') AS inicio,
  to_char(fin,'YYYY-MM-DD')    AS fin,
  comentarios`;

const COLS_PROYECTO = `id, nombre, seccion, carpeta, area, estado, equipo, responsable,
  to_char(entrega,'YYYY-MM-DD') AS entrega,
  to_char(inicio,'YYYY-MM-DD')  AS inicio,
  to_char(fin,'YYYY-MM-DD')     AS fin, nota`;

const COLS_CARPETA = `id, nombre, color, padre, orden`;

const COLS_HITO = `id, titulo, to_char(fecha,'YYYY-MM-DD') AS fecha, fijo, tipo, hora, lugar`;

const COLS_PERSONA = `id, nombre, iniciales, rol, color, capacidad, disp,
  to_char(disp_hasta,'YYYY-MM-DD') AS "dispHasta"`;

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
async function escribirTodo(client, { tareas = [], proyectos = [], hitos = [], personas = [], areas = [], carpetas = [] }) {
  await client.query('DELETE FROM tareas');
  await client.query('DELETE FROM hitos');
  if (proyectos.length) await client.query('DELETE FROM proyectos');
  // u-sin nunca se borra: hay tareas que dependen de esa bandeja
  if (personas.length) await client.query("DELETE FROM personas WHERE id <> 'u-sin'");

  for (let i = 0; i < personas.length; i++) {
    const p = personas[i];
    await client.query(
      `INSERT INTO personas (id, nombre, iniciales, rol, color, capacidad, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         nombre = EXCLUDED.nombre, iniciales = EXCLUDED.iniciales, rol = EXCLUDED.rol,
         color = EXCLUDED.color, capacidad = EXCLUDED.capacidad, orden = EXCLUDED.orden`,
      [p.id, p.nombre, p.iniciales || '?', p.rol || null, p.color || '#868C96',
       p.capacidad || 8, p.id === 'u-sin' ? 9999 : i]);
  }

  /* Las carpetas entran antes que lo que archivan, para que un
     volcado completo nunca deje un proyecto apuntando al vacío. */
  await client.query('DELETE FROM carpetas');
  for (let i = 0; i < carpetas.length; i++) {
    const c = carpetas[i];
    await client.query(
      `INSERT INTO carpetas (id, nombre, color, padre, orden) VALUES ($1,$2,$3,$4,$5)`,
      [c.id, c.nombre, c.color || '#7B8794', c.padre || null,
       c.orden == null ? i : c.orden]);
  }

  for (const p of proyectos) {
    await client.query(
      `INSERT INTO proyectos (id, nombre, seccion, carpeta, area, estado, inicio, fin, nota, equipo, responsable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [p.id, p.nombre, p.seccion, p.carpeta || null, p.area, p.estado || 'pendiente',
       p.inicio || null, p.fin || null, p.nota || null,
       JSON.stringify(p.equipo || []), p.responsable || 'u-sin']);
  }
  for (const t of tareas) {
    await client.query(
      `INSERT INTO tareas (id, codigo, titulo, proyecto, carpeta, area, responsable, estado,
                           progreso, notas, prioridad, inicio, fin, comentarios, equipo, entrega)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [t.id, t.codigo, t.titulo, t.proyecto || null, t.carpeta || null, t.area || 'SIN ÁREA',
       t.responsable || 'u-sin', t.estado || 'pendiente', t.progreso || 0,
       t.notas || null, t.prioridad || 'media', t.inicio || null, t.fin || null,
       JSON.stringify(t.comentarios || []), JSON.stringify(t.equipo || []), t.entrega || null]);
  }
  if (areas.length) {
    await client.query('DELETE FROM areas');
    for (let i = 0; i < areas.length; i++)
      await client.query('INSERT INTO areas (nombre, orden) VALUES ($1,$2)', [areas[i], i]);
  }
  for (const h of hitos) {
    await client.query(
      `INSERT INTO hitos (id, titulo, fecha, fijo, tipo, hora, lugar)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [h.id, h.titulo, h.fecha, !!h.fijo, h.tipo || 'hito', h.hora || null, h.lugar || null]);
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
    const [board, tareas, proyectos, hitos, personas, areas, carpetas] = await Promise.all([
      q('SELECT version, updated_at FROM board WHERE id = 1'),
      q(`SELECT ${COLS_TAREA} FROM tareas ORDER BY fin NULLS LAST, codigo`),
      q(`SELECT ${COLS_PROYECTO} FROM proyectos ORDER BY nombre`),
      q(`SELECT ${COLS_HITO} FROM hitos ORDER BY fecha`),
      q(`SELECT ${COLS_PERSONA} FROM personas ORDER BY orden, nombre`),
      q('SELECT nombre FROM areas ORDER BY orden, nombre'),
      q(`SELECT ${COLS_CARPETA} FROM carpetas ORDER BY orden, nombre`)
    ]);
    return {
      version: board.rows[0]?.version ?? 0,
      updatedAt: board.rows[0]?.updated_at ?? null,
      tareas: tareas.rows,
      proyectos: proyectos.rows,
      hitos: hitos.rows,
      personas: personas.rows,
      areas: areas.rows.map(r => r.nombre),
      carpetas: carpetas.rows
    };
  },

  async setState({ tareas, proyectos, hitos, personas, areas, carpetas }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await escribirTodo(client, { tareas, proyectos, hitos, personas, areas, carpetas });
      const v = await subirVersion(client);
      await client.query('COMMIT');
      return { version: v.version, updatedAt: v.updated_at, tareas, proyectos, hitos, personas, areas, carpetas };
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
                           progreso, notas, prioridad, inicio, fin, comentarios)
       VALUES (COALESCE($1, 't' || nextval('tarea_seq')),
               -- Del mayor código existente, no del total de filas:
               -- contando, borrar una tarea hacía repetir el código
               COALESCE($2, 'T-' || lpad((COALESCE(
                 (SELECT max(NULLIF(regexp_replace(codigo, '\\D', '', 'g'), '')::int) FROM tareas), 0
               ) + 1)::text, 3, '0')),
               $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${COLS_TAREA}`,
      [f.id || null, f.codigo || null, f.titulo, f.proyecto || null,
       f.area || 'SIN ÁREA', f.responsable || 'u-sin', f.estado || 'pendiente',
       f.progreso || 0, f.notas || null, f.prioridad || 'media',
       f.inicio || null, f.fin || null, JSON.stringify(f.comentarios || [])]);
    await subirVersion();
    return rows[0];
  },

  async updateTarea(id, patch) {
    const permitidos = ['titulo','proyecto','carpeta','area','responsable','estado',
                        'progreso','notas','prioridad','inicio','fin','comentarios','equipo','entrega'];
    const claves = Object.keys(patch).filter(k => permitidos.includes(k));
    if (!claves.length) return module.exports.getTarea(id);

    const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const vals = claves.map(k => ['comentarios','equipo'].includes(k) ? JSON.stringify(patch[k]) : patch[k]);

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
      `INSERT INTO hitos (id, titulo, fecha, fijo, tipo, hora, lugar)
       VALUES (COALESCE($1, 'h' || nextval('hito_seq')), $2,$3,$4,$5,$6,$7)
       RETURNING ${COLS_HITO}`,
      [f.id || null, f.titulo, f.fecha, !!f.fijo, f.tipo || 'hito', f.hora || null, f.lugar || null]);
    await subirVersion();
    return rows[0];
  },

  async deleteHito(id) {
    const { rowCount } = await q('DELETE FROM hitos WHERE id = $1', [id]);
    if (rowCount) await subirVersion();
    return rowCount > 0;
  },

  async createProyecto(f) {
    const { rows } = await q(
      `INSERT INTO proyectos (id, nombre, seccion, area, estado, entrega, inicio, fin, nota, equipo)
       VALUES (COALESCE($1, 'p-' || nextval('proyecto_seq')), $2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${COLS_PROYECTO}`,
      [f.id || null, f.nombre, f.seccion || 'PROYECTOS', f.area || null,
       f.estado || 'pendiente', f.entrega || null, f.inicio || null, f.fin || null,
       f.nota || null, JSON.stringify(f.equipo || [])]);
    await subirVersion();
    return rows[0];
  },

  async updateProyecto(id, patch) {
    const permitidos = ['nombre','seccion','carpeta','area','estado','inicio','fin','nota','equipo','responsable'];
    const claves = Object.keys(patch).filter(k => permitidos.includes(k));
    if (!claves.length) return null;
    const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await q(
      `UPDATE proyectos SET ${sets} WHERE id = $1 RETURNING ${COLS_PROYECTO}`,
      [id, ...claves.map(k => k === 'equipo' ? JSON.stringify(patch[k]) : patch[k])]);
    if (!rows[0]) return null;
    await subirVersion();
    return rows[0];
  },

  /* La llave foránea es ON DELETE SET NULL: las tareas del proyecto
     quedan sueltas en vez de borrarse con él. */
  async deleteProyecto(id) {
    const { rowCount } = await q('DELETE FROM proyectos WHERE id = $1', [id]);
    if (rowCount) await subirVersion();
    return rowCount > 0;
  },

  /* ── Carpetas ─────────────────────────────────────── */

  async createCarpeta(f) {
    const { rows } = await q(
      `INSERT INTO carpetas (id, nombre, color, padre, orden)
       VALUES (COALESCE($1, 'c-' || nextval('carpeta_seq')), $2, $3, $4,
               (SELECT COALESCE(MAX(orden), 0) + 1 FROM carpetas))
       RETURNING ${COLS_CARPETA}`,
      [f.id || null, f.nombre, f.color || '#7B8794', f.padre || null]);
    await subirVersion();
    return rows[0];
  },

  async updateCarpeta(id, patch) {
    const permitidos = ['nombre','color','padre','orden'];
    const claves = Object.keys(patch).filter(k => permitidos.includes(k));
    if (!claves.length) return null;
    const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await q(
      `UPDATE carpetas SET ${sets} WHERE id = $1 RETURNING ${COLS_CARPETA}`,
      [id, ...claves.map(k => patch[k])]);
    if (!rows[0]) return null;
    await subirVersion();
    return rows[0];
  },

  /* Borrar una carpeta no borra lo que hay dentro: sus proyectos y
     tareas quedan sin carpeta y sus subcarpetas suben un nivel. */
  async deleteCarpeta(id) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE carpetas SET padre = NULL WHERE padre = $1', [id]);
      await client.query('UPDATE proyectos SET carpeta = NULL WHERE carpeta = $1', [id]);
      await client.query('UPDATE tareas    SET carpeta = NULL WHERE carpeta = $1', [id]);
      const { rowCount } = await client.query('DELETE FROM carpetas WHERE id = $1', [id]);
      if (rowCount) await subirVersion(client);
      await client.query('COMMIT');
      return rowCount > 0;
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
  },

  async createPersona(f) {
    const { rows } = await q(
      `INSERT INTO personas (id, nombre, iniciales, rol, color, capacidad, disp, disp_hasta, orden)
       VALUES (COALESCE($1, 'u-' || nextval('persona_seq')), $2, $3, $4, $5, $6, $7, $8,
               (SELECT COALESCE(MAX(orden), 0) + 1 FROM personas WHERE id <> 'u-sin'))
       RETURNING ${COLS_PERSONA}`,
      [f.id || null, f.nombre, f.iniciales || '?', f.rol || null,
       f.color || '#868C96', f.capacidad || 8, f.disp || 'oficina', f.dispHasta || null]);
    await subirVersion();
    return rows[0];
  },

  async updatePersona(id, patch) {
    if (id === 'u-sin') return null;                 // la bandeja no se edita
    const permitidos = ['nombre','iniciales','rol','color','capacidad','disp','dispHasta'];
    const claves = Object.keys(patch).filter(k => permitidos.includes(k));
    if (!claves.length) return null;
    const col = k => k === 'dispHasta' ? 'disp_hasta' : k;
    const sets = claves.map((k, i) => `${col(k)} = $${i + 2}`).join(', ');
    const { rows } = await q(
      `UPDATE personas SET ${sets} WHERE id = $1 RETURNING ${COLS_PERSONA}`,
      [id, ...claves.map(k => patch[k])]);
    if (!rows[0]) return null;
    await subirVersion();
    return rows[0];
  },

  /* Al quitar a alguien, sus tareas pasan a la bandeja sin asignar
     en la misma transacción: nunca quedan apuntando a un fantasma. */
  async deletePersona(id) {
    if (id === 'u-sin') return false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE tareas SET responsable = 'u-sin' WHERE responsable = $1", [id]);
      const { rowCount } = await client.query('DELETE FROM personas WHERE id = $1', [id]);
      if (rowCount) await subirVersion(client);
      await client.query('COMMIT');
      return rowCount > 0;
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
  },

  async close(){ await pool.end(); }
};
