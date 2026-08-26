/**
 * Slate — production board API
 * ─────────────────────────────
 * Express server with a pluggable storage layer.
 * Swap the driver in store/index.js when you add a real database;
 * nothing in this file needs to change.
 *
 *   npm install
 *   npm start          → http://localhost:3000
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);          // Render, Railway y Fly van detrás de un proxy

/* ── CORS ─────────────────────────────────────────────
   En producción solo se aceptan los orígenes de ORIGENES
   (separados por coma). Si el front se sirve desde este
   mismo servidor, no hace falta configurarlo.            */
const ORIGENES = (process.env.ORIGENES || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(PROD && ORIGENES.length ? { origin: ORIGENES, credentials: true } : {}));

/* ── Cabeceras básicas ──────────────────────────────── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use(express.json({ limit: '4mb' }));

/* ── Contraseña de acceso ─────────────────────────────
   Define CLAVE_ACCESO y todo el tablero queda detrás de
   una autenticación básica del navegador. Si no la
   defines, el servidor arranca abierto y lo advierte.
   Es lo mínimo antes de publicar datos internos.        */
const CLAVE = process.env.CLAVE_ACCESO;
const USUARIO = process.env.USUARIO_ACCESO || 'comms';

if (CLAVE) {
  app.use((req, res, next) => {
    // /api/health queda abierto: es el que consulta el hosting para
    // saber si el servicio está vivo.
    if (req.path === '/api/health') return next();

    const cabecera = req.headers.authorization || '';
    const [tipo, b64] = cabecera.split(' ');
    if (tipo === 'Basic' && b64) {
      const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
      if (u === USUARIO && seguraIgual(p || '', CLAVE)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Trafico Comms", charset="UTF-8"');
    res.status(401).json({ error: 'Autenticación requerida' });
  });
}

// Comparación de longitud constante: no filtra la clave por tiempos
function seguraIgual(a, b) {
  const crypto = require('crypto');
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1h' : 0 }));

/* ── Helpers ─────────────────────────────────────── */

/* Los errores de Postgres traen un código SQLSTATE. Un dato inválido
   es culpa de quien llama, no del servidor: se responde 400, no 500. */
const SQLSTATE = {
  '23514': [400, 'Valor fuera de rango permitido'],   // CHECK
  '23503': [400, 'Referencia inexistente'],           // llave foránea
  '23505': [409, 'Ese registro ya existe'],           // clave duplicada
  '22P02': [400, 'Formato de dato inválido'],
  '22008': [400, 'Fecha inválida (usa AAAA-MM-DD)']
};

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  // El `detail` de Postgres incluye la fila completa que falló, así que
  // solo se envía fuera de producción.
  const dev = process.env.NODE_ENV !== 'production';
  const conocido = SQLSTATE[err.code];
  if (conocido) {
    const [status, mensaje] = conocido;
    return res.status(status).json(dev ? { error: mensaje, detail: err.detail || err.message }
                                       : { error: mensaje });
  }
  console.error(err);
  res.status(500).json(dev ? { error: 'Error del servidor', detail: err.message }
                           : { error: 'Error del servidor' });
});

const bad = (res, msg) => res.status(400).json({ error: msg });

/* Server-sent events: every connected browser gets pushed the new
   state after any write, so two people on the board stay in sync. */
const clients = new Set();

function broadcast(state) {
  const frame = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(frame);
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(': connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

/* ── Whole-state endpoints ───────────────────────── */
/* The single-file client uses these two. Simplest path to persistence. */

app.get('/api/state', wrap(async (req, res) => {
  res.json(await store.getState());
}));

app.put('/api/state', wrap(async (req, res) => {
  const { tareas, proyectos, hitos, personas, areas, version } = req.body || {};
  if (!Array.isArray(tareas)) return bad(res, 'tareas debe ser un arreglo');
  if (!Array.isArray(hitos))  return bad(res, 'hitos debe ser un arreglo');

  const current = await store.getState();

  // Optimistic concurrency. Stale writer gets the fresh copy back, 409.
  if (typeof version === 'number' && version !== current.version) {
    return res.status(409).json(current);
  }

  const saved = await store.setState({ tareas, proyectos: proyectos || current.proyectos, hitos,
                                      personas: personas || current.personas, areas: areas || current.areas });
  broadcast(saved);
  res.json({ version: saved.version, updatedAt: saved.updatedAt });
}));

app.post('/api/state/reset', wrap(async (req, res) => {
  const saved = await store.reset();
  broadcast(saved);
  res.json({ ok: true, version: saved.version });
}));

/* ── Granular REST ───────────────────────────────── */
/* Not used by the single-file client, but here so mobile apps,
   Zapier, or a future React front end have a real resource API. */

app.get('/api/tareas', wrap(async (req, res) => {
  const { tareas } = await store.getState();
  const { responsable, estado, proyecto } = req.query;
  res.json(tareas.filter(t =>
    (!responsable || t.responsable === responsable) &&
    (!estado      || t.estado      === estado) &&
    (!proyecto    || t.proyecto    === proyecto)));
}));

app.get('/api/tareas/:id', wrap(async (req, res) => {
  const task = await store.getTarea(req.params.id);
  task ? res.json(task) : res.status(404).json({ error: 'Tarea no encontrada' });
}));

app.post('/api/tareas', wrap(async (req, res) => {
  const { titulo, inicio, fin } = req.body || {};
  if (!titulo) return bad(res, 'titulo es obligatorio');
  if (!inicio && !fin) return bad(res, 'se requiere inicio o fin (AAAA-MM-DD)');

  const task = await store.createTarea({
    titulo,
    inicio: inicio || fin,
    fin: fin || inicio,
    codigo: req.body.codigo,
    proyecto: req.body.proyecto || null,
    area: req.body.area || 'SIN ÁREA',
    estado: req.body.estado || 'pendiente',
    responsable: req.body.responsable || 'u-sin',
    progreso: req.body.progreso || 0,
    prioridad: req.body.prioridad || 'media',
    equipo: req.body.equipo || [],
    notas: req.body.notas || null,
    comentarios: []
  });
  broadcast(await store.getState());
  res.status(201).json(task);
}));

app.patch('/api/tareas/:id', wrap(async (req, res) => {
  const task = await store.updateTarea(req.params.id, req.body || {});
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  broadcast(await store.getState());
  res.json(task);
}));

app.delete('/api/tareas/:id', wrap(async (req, res) => {
  const ok = await store.deleteTarea(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Tarea no encontrada' });
  broadcast(await store.getState());
  res.status(204).end();
}));

app.post('/api/tareas/:id/comentarios', wrap(async (req, res) => {
  const { por, texto } = req.body || {};
  if (!texto) return bad(res, 'texto es obligatorio');
  const task = await store.addComment(req.params.id, {
    por: por || 'u-andres',
    texto,
    cuando: new Date().toISOString()
  });
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  broadcast(await store.getState());
  res.status(201).json(task);
}));

/* ── Milestones ──────────────────────────────────── */

app.get('/api/hitos', wrap(async (req, res) => {
  const { hitos } = await store.getState();
  res.json(hitos);
}));

app.post('/api/hitos', wrap(async (req, res) => {
  const { titulo, fecha } = req.body || {};
  if (!titulo) return bad(res, 'titulo es obligatorio');
  if (!fecha)  return bad(res, 'fecha es obligatoria (AAAA-MM-DD)');
  const m = await store.createHito({ titulo, fecha, fijo: false,
    tipo: req.body.tipo || 'hito', hora: req.body.hora, lugar: req.body.lugar });
  broadcast(await store.getState());
  res.status(201).json(m);
}));

app.delete('/api/hitos/:id', wrap(async (req, res) => {
  const ok = await store.deleteHito(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Milestone not found' });
  broadcast(await store.getState());
  res.status(204).end();
}));

app.get('/api/areas', wrap(async (req, res) => {
  const { areas } = await store.getState();
  res.json(areas || []);
}));

app.get('/api/proyectos', wrap(async (req, res) => {
  const { proyectos } = await store.getState();
  res.json(proyectos);
}));

app.post('/api/proyectos', wrap(async (req, res) => {
  const { nombre } = req.body || {};
  if (!nombre) return bad(res, 'nombre es obligatorio');
  const p = await store.createProyecto({
    nombre, seccion: req.body.seccion, area: req.body.area,
    estado: req.body.estado, entrega: req.body.entrega, nota: req.body.nota,
    inicio: req.body.inicio, fin: req.body.fin, equipo: req.body.equipo
  });
  broadcast(await store.getState());
  res.status(201).json(p);
}));

app.patch('/api/proyectos/:id', wrap(async (req, res) => {
  const p = await store.updateProyecto(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'Proyecto no encontrado' });
  broadcast(await store.getState());
  res.json(p);
}));

/* Sus tareas quedan sueltas, con proyecto en null. */
app.delete('/api/proyectos/:id', wrap(async (req, res) => {
  const ok = await store.deleteProyecto(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Proyecto no encontrado' });
  broadcast(await store.getState());
  res.status(204).end();
}));

/* ── Personas ────────────────────────────────────── */

app.get('/api/personas', wrap(async (req, res) => {
  const { personas } = await store.getState();
  res.json(personas || []);
}));

app.post('/api/personas', wrap(async (req, res) => {
  const { nombre } = req.body || {};
  if (!nombre) return bad(res, 'nombre es obligatorio');
  const p = await store.createPersona({
    nombre,
    iniciales: req.body.iniciales,
    rol: req.body.rol,
    color: req.body.color,
    capacidad: req.body.capacidad,
    disp: req.body.disp,
    dispHasta: req.body.dispHasta
  });
  broadcast(await store.getState());
  res.status(201).json(p);
}));

app.patch('/api/personas/:id', wrap(async (req, res) => {
  if (req.params.id === 'u-sin') return bad(res, 'Sin asignar no se puede editar');
  const p = await store.updatePersona(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'Persona no encontrada' });
  broadcast(await store.getState());
  res.json(p);
}));

/* Sus tareas abiertas vuelven a "Sin asignar", no se borran. */
app.delete('/api/personas/:id', wrap(async (req, res) => {
  if (req.params.id === 'u-sin') return bad(res, 'Sin asignar no se puede quitar');
  const ok = await store.deletePersona(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Persona no encontrada' });
  broadcast(await store.getState());
  res.status(204).end();
}));

/* ── Health ──────────────────────────────────────── */

app.get('/api/health', wrap(async (req, res) => {
  const { version, updatedAt } = await store.getState();
  res.json({ ok: true, driver: store.driver, version, updatedAt });
}));

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

/* ── Arranque ─────────────────────────────────────────
   Antes de escuchar, el driver prepara su almacenamiento.
   En Postgres eso significa crear las tablas si no existen
   y sembrar los datos del Excel si la base está vacía.
   Si algo falla, el proceso sale con un mensaje claro en vez
   de arrancar y devolver errores 500 en cada petición.      */

(async function arrancar() {
  try {
    const info = await store.init();
    console.log(`Almacenamiento: ${store.driver}`,
                info ? '· ' + JSON.stringify(info) : '');
  } catch (err) {
    console.error(`\n✕ No se pudo preparar el almacenamiento (${store.driver})`);
    console.error('  ' + err.message);
    if (/ECONNREFUSED|ENOTFOUND|password|SSL|self.signed/i.test(err.message)) {
      console.error('\n  Revisa DATABASE_URL. Para un Postgres local sin TLS agrega PGSSL=false:');
      console.error('  STORAGE=postgres PGSSL=false DATABASE_URL=postgres://user:pass@localhost:5432/slate npm start\n');
    }
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Slate API en http://localhost:${PORT}`);
    if (CLAVE) {
      console.log(`Autenticación: clave compartida (usuario ${USUARIO})`);
    } else {
      console.warn('\n⚠  Sin autenticación: cualquiera con la URL puede ver y editar el tablero.');
      console.warn('   Define CLAVE_ACCESO en las variables de entorno de Render.\n');
    }
  });
})();
