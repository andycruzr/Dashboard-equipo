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
  responsable text NOT NULL DEFAULT 'u-sin',
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
  entrega     date,
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
ALTER TABLE tareas ADD COLUMN IF NOT EXISTS entrega date;
-- La entrega arranca igual al fin para lo que ya existía
UPDATE tareas SET entrega = fin WHERE entrega IS NULL AND fin IS NOT NULL;

ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS responsable text NOT NULL DEFAULT 'u-sin';

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

-- ── Carpetas ─────────────────────────────────────────
-- Agrupan proyectos y tareas por tema, aparte del estado.
-- No llevan llave foránea a propósito: si alguien borra una
-- carpeta a mano, lo de dentro no debe irse con ella. Las
-- referencias muertas se limpian aquí abajo al arrancar.
CREATE SEQUENCE IF NOT EXISTS carpeta_seq START 1000;

CREATE TABLE IF NOT EXISTS carpetas (
  id     text PRIMARY KEY,
  nombre text NOT NULL,
  color  text NOT NULL DEFAULT '#7B8794',
  padre  text,
  orden  int  NOT NULL DEFAULT 0
);

ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS carpeta text;
ALTER TABLE tareas    ADD COLUMN IF NOT EXISTS carpeta text;

CREATE INDEX IF NOT EXISTS proyectos_carpeta_idx ON proyectos (carpeta);
CREATE INDEX IF NOT EXISTS tareas_carpeta_idx    ON tareas (carpeta);

-- Un solo nivel de anidación: la nieta sube a hija.
UPDATE carpetas h SET padre = NULL
 WHERE h.padre IS NOT NULL
   AND EXISTS (SELECT 1 FROM carpetas m WHERE m.id = h.padre AND m.padre IS NOT NULL);

-- Nadie es su propio padre.
UPDATE carpetas SET padre = NULL WHERE padre = id;

-- Apuntar a una carpeta que ya no existe equivale a no tener carpeta.
UPDATE proyectos SET carpeta = NULL
 WHERE carpeta IS NOT NULL AND carpeta NOT IN (SELECT id FROM carpetas);
UPDATE tareas SET carpeta = NULL
 WHERE carpeta IS NOT NULL AND carpeta NOT IN (SELECT id FROM carpetas);

-- ── Baja de las áreas ────────────────────────────────
-- Las áreas cliente (CORPO, TALENT, CDI...) se convirtieron en
-- carpetas: hacían el mismo trabajo de agrupar y obligaban a
-- mantener dos taxonomías. La migración es directa porque el área
-- de cada tarea coincidía siempre con la de su proyecto.
INSERT INTO carpetas (id, nombre, color, padre, orden)
SELECT 'c-' || lower(regexp_replace(area, '[^a-zA-Z0-9]+', '-', 'g')),
       initcap(area), '#7B8794', NULL, 0
  FROM (SELECT DISTINCT area FROM proyectos WHERE area IS NOT NULL) a
 WHERE EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='proyectos' AND column_name='area')
ON CONFLICT (id) DO NOTHING;

UPDATE proyectos SET carpeta = 'c-' || lower(regexp_replace(area, '[^a-zA-Z0-9]+', '-', 'g'))
 WHERE carpeta IS NULL AND area IS NOT NULL;
UPDATE tareas t SET carpeta = 'c-' || lower(regexp_replace(t.area, '[^a-zA-Z0-9]+', '-', 'g'))
 WHERE t.carpeta IS NULL AND t.proyecto IS NULL AND t.area IS NOT NULL;

ALTER TABLE tareas    DROP COLUMN IF EXISTS area;
ALTER TABLE proyectos DROP COLUMN IF EXISTS area;
DROP TABLE IF EXISTS areas;

-- ── De cajón único a etiquetas ───────────────────────
-- Una carpeta pasó a ser una etiqueta: un proyecto o una tarea puede
-- llevar varias y aparece en todas. La columna carpeta (una sola) se
-- convierte en carpetas (jsonb con la lista), y la jerarquía de
-- subcarpetas desaparece, que era lo que se sentía raro: una
-- subcarpeta no es "esto también es de aquello", es otro cajón.
ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS carpetas jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tareas    ADD COLUMN IF NOT EXISTS carpetas jsonb NOT NULL DEFAULT '[]';

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='proyectos' AND column_name='carpeta') THEN
    UPDATE proyectos SET carpetas = to_jsonb(ARRAY[carpeta])
     WHERE carpeta IS NOT NULL AND carpetas = '[]'::jsonb;
    UPDATE tareas SET carpetas = to_jsonb(ARRAY[carpeta])
     WHERE carpeta IS NOT NULL AND carpetas = '[]'::jsonb;
    ALTER TABLE proyectos DROP COLUMN carpeta;
    ALTER TABLE tareas    DROP COLUMN carpeta;
  END IF;
END
$mig$;

ALTER TABLE carpetas DROP COLUMN IF EXISTS padre;
