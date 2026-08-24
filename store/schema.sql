-- ═══════════════════════════════════════════════════
-- Slate — Tráfico Comms · esquema PostgreSQL
--
-- Este archivo lo ejecuta el servidor SOLO al arrancar
-- (store/postgres.js → init). No hace falta psql.
--
-- Todo es CREATE ... IF NOT EXISTS, así que correrlo
-- muchas veces es inofensivo: la segunda vez no hace nada.
-- ═══════════════════════════════════════════════════

-- Fila única que lleva el contador de versión usado para
-- detectar escrituras simultáneas.
CREATE TABLE IF NOT EXISTS board (
  id         int PRIMARY KEY DEFAULT 1,
  version    int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_singleton CHECK (id = 1)
);
INSERT INTO board (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS tarea_seq START 1000;
CREATE SEQUENCE IF NOT EXISTS hito_seq  START 1000;

-- ── Proyectos ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proyectos (
  id      text PRIMARY KEY,
  nombre  text NOT NULL,
  seccion text,
  area    text,
  estado  text NOT NULL DEFAULT 'pendiente'
          CHECK (estado IN ('pendiente','proceso','revision','completado')),
  entrega date,
  nota    text
);

-- ── Tareas ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tareas (
  id          text PRIMARY KEY,
  codigo      text NOT NULL,
  titulo      text NOT NULL,
  proyecto    text REFERENCES proyectos(id) ON DELETE SET NULL,
  area        text NOT NULL DEFAULT 'SIN ÁREA',
  responsable text NOT NULL DEFAULT 'u-sin',
  estado      text NOT NULL DEFAULT 'pendiente'
              CHECK (estado IN ('pendiente','proceso','revision','completado')),
  progreso    numeric(3,2) NOT NULL DEFAULT 0
              CHECK (progreso >= 0 AND progreso <= 1),
  notas       text,
  inicio      date,
  fin         date,
  comentarios jsonb NOT NULL DEFAULT '[]',
  creada_en   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tareas_fin_idx         ON tareas (fin);
CREATE INDEX IF NOT EXISTS tareas_estado_idx      ON tareas (estado);
CREATE INDEX IF NOT EXISTS tareas_responsable_idx ON tareas (responsable);
CREATE INDEX IF NOT EXISTS tareas_proyecto_idx    ON tareas (proyecto);

-- ── Hitos ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitos (
  id     text PRIMARY KEY,
  titulo text NOT NULL,
  fecha  date NOT NULL,
  fijo   boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS hitos_fecha_idx ON hitos (fecha);

-- ── Personas ─────────────────────────────────────────
-- Hoy PERSONAS está fijo en el front. Cuando quieras que
-- el equipo se administre desde la base, descomenta esto
-- y haz join contra tareas.responsable.
--
-- CREATE TABLE IF NOT EXISTS personas (
--   id        text PRIMARY KEY,
--   nombre    text NOT NULL,
--   iniciales text NOT NULL,
--   rol       text,
--   color     text,
--   capacidad int NOT NULL DEFAULT 8
-- );
