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
CREATE SEQUENCE IF NOT EXISTS persona_seq START 1000;

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
  prioridad   text NOT NULL DEFAULT 'media'
              CHECK (prioridad IN ('alta','media','baja')),
  inicio      date,
  fin         date,
  comentarios jsonb NOT NULL DEFAULT '[]',
  creada_en   timestamptz NOT NULL DEFAULT now()
);

-- Migración para bases creadas antes de que existiera la prioridad.
-- Patrón para agregar columnas más adelante: ADD COLUMN IF NOT EXISTS,
-- nunca un ALTER que falle al repetirse.
ALTER TABLE tareas ADD COLUMN IF NOT EXISTS prioridad text NOT NULL DEFAULT 'media';

-- Cualquier valor fuera de rango bloquearía el CHECK de abajo,
-- así que primero se normaliza lo que haya en la base.
UPDATE tareas SET prioridad = 'media'
 WHERE prioridad IS NULL OR prioridad NOT IN ('alta','media','baja');

-- ADD COLUMN no arrastra el CHECK del CREATE TABLE, así que la
-- restricción se agrega aparte. Postgres no tiene
-- ADD CONSTRAINT IF NOT EXISTS, de ahí el bloque condicional.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tareas_prioridad_check'
  ) THEN
    ALTER TABLE tareas ADD CONSTRAINT tareas_prioridad_check
      CHECK (prioridad IN ('alta','media','baja'));
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS tareas_fin_idx         ON tareas (fin);
CREATE INDEX IF NOT EXISTS tareas_prioridad_idx   ON tareas (prioridad);
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
-- El equipo se administra desde la app: se agregan, editan
-- y quitan personas sin tocar la base a mano.
CREATE TABLE IF NOT EXISTS personas (
  id        text PRIMARY KEY,
  nombre    text NOT NULL,
  iniciales text NOT NULL DEFAULT '?',
  rol       text,
  color     text NOT NULL DEFAULT '#6B7079',
  capacidad int  NOT NULL DEFAULT 8 CHECK (capacidad BETWEEN 1 AND 40),
  disp      text NOT NULL DEFAULT 'oficina',
  disp_hasta date,
  orden     int  NOT NULL DEFAULT 0
);

-- Migración para bases anteriores a la disponibilidad.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS disp text NOT NULL DEFAULT 'oficina';
ALTER TABLE personas ADD COLUMN IF NOT EXISTS disp_hasta date;

UPDATE personas SET disp = 'oficina'
 WHERE disp IS NULL OR disp NOT IN ('oficina','casa','vacaciones','incapacidad','ausente');

DO $dp$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'personas_disp_check') THEN
    ALTER TABLE personas ADD CONSTRAINT personas_disp_check
      CHECK (disp IN ('oficina','casa','vacaciones','incapacidad','ausente'));
  END IF;
END
$dp$;

-- u-sin no es una persona: es la bandeja de lo que nadie ha
-- tomado. Debe existir siempre y va al final de la lista.
INSERT INTO personas (id, nombre, iniciales, rol, color, capacidad, orden)
VALUES ('u-sin', 'Sin asignar', '—', 'Pendiente de asignación', '#6B7079', 8, 9999)
ON CONFLICT (id) DO NOTHING;
