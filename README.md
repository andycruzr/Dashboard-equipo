# Slate — Tráfico Comms

Tablero de tráfico y cronograma Gantt del equipo, con los datos de
`GANTT_COMMS.xlsx`. Un solo archivo HTML en el front y un Express con
PostgreSQL detrás.

```
server/
├── server.js            API, autenticación, SSE
├── Dockerfile           Para Fly, Cloud Run, Railway o cualquier PaaS
├── render.yaml          Plano de Render: crea base + servicio de una vez
├── .env.example         Variables a llenar
├── public/index.html    El tablero (copia de tablero-comms.html)
├── data/seed.json       Los 95 registros del Excel
└── store/
    ├── index.js         Elige el driver según STORAGE
    ├── json-file.js     Archivo JSON en disco, cero configuración
    ├── postgres.js      PostgreSQL — crea sus tablas al arrancar
    └── schema.sql       Lo ejecuta postgres.js, no necesitas psql
```

## Probarlo local en dos minutos

```bash
cd server
npm install
npm start                     # http://localhost:3000
```

Sin variables usa el driver `json`: guarda en `data/board.json` y no
necesita base de datos. Abre la URL y ya estás trabajando.

## Ponerlo online

El front detecta la API solo. Si `index.html` se sirve desde este
servidor, pregunta por `/api/health` y, si responde, usa la base de
datos. No hay que editar ninguna línea.

### Render (la ruta más corta, capa gratuita)

1. Sube la carpeta `server/` a un repositorio de GitHub.
2. En Render: **New → Blueprint**, conecta el repo, **Apply**.
   `render.yaml` crea la base PostgreSQL y el servicio web, y los conecta.
3. Render genera `CLAVE_ACCESO` — la ves en **Environment** del servicio.
   El usuario es `comms`.
4. Entra a la URL que te da. Al primer arranque el servidor crea las
   tablas y carga los 95 registros del Excel. En los logs verás:
   `{"tablas":"creadas","sembrado":true,"tareas":95}`

La capa gratuita de Render duerme el servicio tras 15 minutos sin uso;
la primera visita después tarda unos 30 segundos en despertar. El plan
de USD 7/mes lo evita.

### Railway, Fly.io, Cloud Run

Usa el `Dockerfile`. Solo hay que darle las variables de `.env.example`
y una `DATABASE_URL`. En Railway: **New Project → Deploy from repo**,
agrega **PostgreSQL** desde el panel y Railway inyecta `DATABASE_URL` solo.

### Base de datos aparte (Neon, Supabase)

Ambas dan una `DATABASE_URL` con TLS lista para pegar. Nada más que hacer:
el servidor crea el esquema al arrancar.

## Variables

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `PORT` | `3000` | Puerto. Los hostings lo inyectan solos |
| `STORAGE` | `json` | `json` o `postgres` |
| `DATABASE_URL` | — | Cadena de conexión de PostgreSQL |
| `PGSSL` | activo | `false` solo para un Postgres local sin TLS |
| `DATA_FILE` | `data/board.json` | Ruta del archivo del driver `json` |
| `USUARIO_ACCESO` | `comms` | Usuario del tablero |
| `CLAVE_ACCESO` | — | **Sin esto el tablero queda abierto** |
| `ORIGENES` | — | Dominios permitidos si el front vive aparte |
| `NODE_ENV` | — | `production` activa HSTS y oculta detalles de error |

## Migración automática

`store/postgres.js` corre al arrancar, antes de aceptar peticiones:

1. Toma un *advisory lock* para que dos instancias no creen las tablas a la vez.
2. Ejecuta `schema.sql`. Todo es `CREATE ... IF NOT EXISTS`, así que
   correrlo mil veces no rompe nada.
3. Si `tareas` está vacía, carga `data/seed.json`.
4. Suelta el lock y el servidor empieza a escuchar.

Si la conexión falla, el proceso **sale con código 1** y un mensaje
claro en vez de arrancar y devolver errores 500 en cada petición.

Para agregar una columna después: añádela a `schema.sql` como
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` y reinicia. Cuando el
proyecto crezca, cambia esto por una herramienta de migraciones de
verdad (`node-pg-migrate`), porque este esquema no lleva historial de
versiones.

## API

### Estado completo
Es lo que usa el tablero: una lectura al cargar, una escritura con debounce por cambio.

| Método | Ruta | Notas |
| --- | --- | --- |
| GET | `/api/state` | `{ tareas, proyectos, hitos, version, updatedAt }` |
| PUT | `/api/state` | Manda la `version` que leíste. Si otro guardó antes → `409` con el estado fresco |
| POST | `/api/state/reset` | Restaura `data/seed.json` |
| GET | `/api/events` | SSE: empuja los cambios a todos los navegadores abiertos |

### Recursos

| Método | Ruta |
| --- | --- |
| GET | `/api/tareas?estado=&responsable=&proyecto=` |
| GET | `/api/tareas/:id` |
| POST | `/api/tareas` |
| PATCH | `/api/tareas/:id` |
| DELETE | `/api/tareas/:id` |
| POST | `/api/tareas/:id/comentarios` |
| GET | `/api/proyectos` |
| GET · POST | `/api/hitos` |
| DELETE | `/api/hitos/:id` |
| GET | `/api/health` |

```bash
curl -u comms:TU_CLAVE -X PATCH https://tu-app.onrender.com/api/tareas/t13 \
  -H 'Content-Type: application/json' \
  -d '{"estado":"completado","progreso":1}'
```

Los errores de PostgreSQL se traducen a códigos correctos: un `CHECK`
violado o una llave foránea inexistente devuelven `400`, no `500`.

## Escrituras simultáneas

`PUT /api/state` lleva un contador de versión. Si dos personas editan a
la vez, la segunda llega con una versión vieja, recibe `409` con el
tablero actual, y el front adopta esa copia en vez de pisar el trabajo
del otro. Sale un aviso en pantalla.

Para un equipo de siete es suficiente. Si llegan a editar la misma tarea
en el mismo segundo de forma rutinaria, mueve el front de
`PUT /api/state` a las rutas `PATCH /api/tareas/:id`: así dos personas en
tareas distintas nunca chocan.

## Lo que falta antes de considerarlo definitivo

- **Identidad real.** `PERSONAS` está fijo en el front y los comentarios
  se publican siempre como `u-andres`. La contraseña protege el acceso,
  pero no distingue quién es quién.
- **Rate limiting.** `express-rate-limit` en las rutas de escritura.
- **Respaldos.** Render y Neon respaldan la base en sus planes pagos. En
  el gratuito, exporta `/api/state` de vez en cuando.
- **Migraciones con historial** cuando el esquema empiece a cambiar seguido.

## De dónde salen los datos

`data/seed.json` se generó desde `GANTT_COMMS.xlsx`:

| Excel | JSON |
| --- | --- |
| Hoja `GANTT COMMS`, filas sin estado | `proyectos` (21) |
| Hoja `GANTT COMMS`, filas con estado | `tareas` (95) |
| Columna `ASIGNADO A` | `responsable` |
| Columna `CLIENTE` | `area` |
| Columna `PROGRESO` | `progreso` (0–1) |
| Columna `PRIORIDAD` | `estado` |
| Hoja `ESTATUS`, `FECHA DE ENTREGA` | `hitos` (9) |

Estados: `NO EMPEZADO`→`pendiente`, `EN PROCESO`→`proceso`,
`ENTREGADO`→`revision`, `APROBADO`→`completado`.
