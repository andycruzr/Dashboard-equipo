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
CREATE SEQUENCE IF NOT EXISTS persona_seq  START 1000;
CREATE SEQUENCE IF NOT EXISTS proyecto_seq START 1000;

-- ── Proyectos ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proyectos (
  id      text PRIMARY KEY,
  nombre  text NOT NULL,
  seccion text,
  area    text,
  estado  text NOT NULL DEFAULT 'pendiente'
          CHECK (estado IN ('pendiente','proceso','revision','completado')),
  entrega date,
  inicio  date,
  fin     date,
  nota    text,
  equipo  jsonb NOT NULL DEFAULT '[]'
);

-- Migración para bases creadas antes de la duración y el equipo
ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS inicio date;
ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS fin    date;
ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS equipo jsonb NOT NULL DEFAULT '[]';

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
  equipo      jsonb NOT NULL DEFAULT '[]',
  creada_en   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tareas ADD COLUMN IF NOT EXISTS equipo jsonb NOT NULL DEFAULT '[]';

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
  fijo   boolean NOT NULL DEFAULT false,
  tipo   text NOT NULL DEFAULT 'hito',
  hora   text,
  lugar  text
);

-- Migración: los hitos anteriores siguen siendo hitos
ALTER TABLE hitos ADD COLUMN IF NOT EXISTS tipo  text NOT NULL DEFAULT 'hito';
ALTER TABLE hitos ADD COLUMN IF NOT EXISTS hora  text;
ALTER TABLE hitos ADD COLUMN IF NOT EXISTS lugar text;

-- Las áreas se administran desde la app
CREATE TABLE IF NOT EXISTS areas (
  nombre text PRIMARY KEY,
  orden  int NOT NULL DEFAULT 0
);

-- Al crear la tabla por primera vez sobre una base que ya tiene
-- datos, se rescatan las áreas que ya estén en uso. Así nadie pierde
-- sus áreas al actualizar.
INSERT INTO areas (nombre)
SELECT DISTINCT area FROM tareas WHERE area IS NOT NULL
 UNION
SELECT DISTINCT area FROM proyectos WHERE area IS NOT NULL
 -- Solo la primera vez: si ya hay áreas, el equipo las administra y
 -- una que borraron a propósito no debe reaparecer en cada arranque.
 WHERE NOT EXISTS (SELECT 1 FROM areas)
ON CONFLICT DO NOTHING;

-- Coherencia: un proyecto que ya arrancó no puede seguir en
-- "No empezados". Se corrige también del lado del servidor, para
-- que la API devuelva datos consistentes aunque nadie abra la web.
UPDATE proyectos SET seccion = 'PROYECTOS'
 WHERE seccion = 'PROYECTOS NO EMPEZADOS'
   AND (estado <> 'pendiente'
        OR id IN (SELECT DISTINCT proyecto FROM tareas WHERE proyecto IS NOT NULL AND estado <> 'pendiente'));

-- Una tarea completada está al 100%
UPDATE tareas SET progreso = 1 WHERE estado = 'completado' AND progreso <> 1;

-- Fin nunca antes que inicio
UPDATE tareas    SET fin = inicio WHERE inicio IS NOT NULL AND fin IS NOT NULL AND fin < inicio;
UPDATE proyectos SET fin = inicio WHERE inicio IS NOT NULL AND fin IS NOT NULL AND fin < inicio;

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
