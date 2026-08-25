/**
 * JSON file driver — the default.
 *
 * Good for a small team and a single server process. Writes are
 * serialised through a promise chain so two overlapping requests
 * can't interleave and corrupt the file.
 *
 * Outgrow it when: you need more than one server process, or the
 * file passes a few megabytes. Then switch to postgres.js.
 */

const fs = require('fs/promises');
const path = require('path');

const FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'board.json');
const SEED = path.join(__dirname, '..', 'data', 'seed.json');

let cache = null;
let queue = Promise.resolve();          // write lock

async function readFile() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    cache = JSON.parse(await fs.readFile(SEED, 'utf8'));
    cache.version = 1;
    cache.updatedAt = new Date().toISOString();
    await writeFile(cache);
  }
  return cache;
}

async function writeFile(state) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  // Write to a temp file then rename: a crash mid-write can't leave
  // a half-written board on disk.
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, FILE);
  cache = state;
  return state;
}

/* Serialise every mutation. */
function lock(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

async function commit(mutate) {
  return lock(async () => {
    const state = await readFile();
    const next = mutate(structuredClone(state)) || state;
    next.version = (state.version || 0) + 1;
    next.updatedAt = new Date().toISOString();
    return writeFile(next);
  });
}

const nextId = (rows, prefix) =>
  prefix + (rows.reduce((max, r) => Math.max(max, +String(r.id).replace(/\D/g, '') || 0), 0) + 1);

module.exports = {
  /* Prepara el archivo: si no existe, lo crea desde el seed.
     Mismo contrato que postgres.init(), para que server.js no
     tenga que saber cuál driver está corriendo. */
  async init() {
    const estado = await readFile();
    return { archivo: FILE, tareas: (estado.tareas || []).length };
  },

  async getState() {
    return readFile();
  },

  async setState({ tareas, proyectos, hitos, personas }) {
    return commit(s => {
      s.tareas = tareas;
      if (proyectos) s.proyectos = proyectos;
      if (personas)  s.personas  = personas;
      s.hitos = hitos;
      return s;
    });
  },

  async reset() {
    const seed = JSON.parse(await fs.readFile(SEED, 'utf8'));
    return commit(s => {
      s.tareas = seed.tareas; s.proyectos = seed.proyectos;
      s.hitos = seed.hitos; s.personas = seed.personas;
      return s;
    });
  },

  async getTarea(id) {
    const { tareas } = await readFile();
    return tareas.find(t => t.id === id) || null;
  },

  async createTarea(fields) {
    let created;
    await commit(s => {
      // Se limpian los undefined antes de mezclar: si no, un campo ausente
      // en el body pisaría el valor por defecto que acabamos de calcular.
      const limpio = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined));

      created = {
        id: nextId(s.tareas, 't'),
        codigo: 'T-' + String(s.tareas.length + 1).padStart(3, '0'),
        proyecto: null, area: 'SIN ÁREA', estado: 'pendiente',
        responsable: 'u-sin', progreso: 0, notas: null,
        inicio: null, fin: null, comentarios: [],
        ...limpio
      };
      s.tareas.push(created);
      return s;
    });
    return created;
  },

  async updateTarea(id, patch) {
    let updated = null;
    await commit(s => {
      const t = s.tareas.find(x => x.id === id);
      if (!t) return s;
      // id and code are immutable once assigned
      const { id: _i, codigo: _c, ...safe } = patch;
      Object.assign(t, safe);
      updated = t;
      return s;
    });
    return updated;
  },

  async deleteTarea(id) {
    let removed = false;
    await commit(s => {
      const before = s.tareas.length;
      s.tareas = s.tareas.filter(t => t.id !== id);
      removed = s.tareas.length < before;
      return s;
    });
    return removed;
  },

  async addComment(taskId, comment) {
    let updated = null;
    await commit(s => {
      const t = s.tareas.find(x => x.id === taskId);
      if (!t) return s;
      t.comentarios.push(comment);
      updated = t;
      return s;
    });
    return updated;
  },

  async createPersona(fields) {
    let created;
    await commit(s => {
      s.personas = s.personas || [];
      const limpio = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      created = { id: nextId(s.personas, 'u-'), iniciales:'?', rol:null,
                  color:'#868C96', capacidad:8, disp:'oficina', dispHasta:null, ...limpio };
      const i = s.personas.findIndex(p => p.id === 'u-sin');
      i === -1 ? s.personas.push(created) : s.personas.splice(i, 0, created);
      return s;
    });
    return created;
  },

  async updatePersona(id, patch) {
    if (id === 'u-sin') return null;
    let updated = null;
    await commit(s => {
      const p = (s.personas || []).find(x => x.id === id);
      if (!p) return s;
      const { id: _i, ...safe } = patch;
      Object.assign(p, safe);
      updated = p;
      return s;
    });
    return updated;
  },

  /* Sus tareas vuelven a la bandeja sin asignar en el mismo commit. */
  async deletePersona(id) {
    if (id === 'u-sin') return false;
    let removed = false;
    await commit(s => {
      const antes = (s.personas || []).length;
      s.personas = (s.personas || []).filter(p => p.id !== id);
      removed = s.personas.length < antes;
      if (removed) s.tareas.forEach(t => { if (t.responsable === id) t.responsable = 'u-sin'; });
      return s;
    });
    return removed;
  },

  async createHito(fields) {
    let created;
    await commit(s => {
      const limpio = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined));
      created = { id: nextId(s.hitos, 'h'), fijo: false, ...limpio };
      s.hitos.push(created);
      return s;
    });
    return created;
  },

  async deleteHito(id) {
    let removed = false;
    await commit(s => {
      const before = s.hitos.length;
      s.hitos = s.hitos.filter(m => m.id !== id);
      removed = s.hitos.length < before;
      return s;
    });
    return removed;
  }
};
