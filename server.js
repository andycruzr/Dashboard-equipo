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

app.use(cors());                                    // lock this down in production
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── Helpers ─────────────────────────────────────── */

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'Error del servidor', detail: err.message });
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
  const { tareas, proyectos, hitos, version } = req.body || {};
  if (!Array.isArray(tareas)) return bad(res, 'tareas debe ser un arreglo');
  if (!Array.isArray(hitos))  return bad(res, 'hitos debe ser un arreglo');

  const current = await store.getState();

  // Optimistic concurrency. Stale writer gets the fresh copy back, 409.
  if (typeof version === 'number' && version !== current.version) {
    return res.status(409).json(current);
  }

  const saved = await store.setState({ tareas, proyectos: proyectos || current.proyectos, hitos });
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
  const m = await store.createHito({ titulo, fecha, fijo: false });
  broadcast(await store.getState());
  res.status(201).json(m);
}));

app.delete('/api/hitos/:id', wrap(async (req, res) => {
  const ok = await store.deleteHito(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Milestone not found' });
  broadcast(await store.getState());
  res.status(204).end();
}));

app.get('/api/proyectos', wrap(async (req, res) => {
  const { proyectos } = await store.getState();
  res.json(proyectos);
}));

/* ── Health ──────────────────────────────────────── */

app.get('/api/health', wrap(async (req, res) => {
  const { version, updatedAt } = await store.getState();
  res.json({ ok: true, driver: store.driver, version, updatedAt });
}));

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.listen(PORT, () => {
  console.log(`Slate API on http://localhost:${PORT}  ·  storage: ${store.driver}`);
});
