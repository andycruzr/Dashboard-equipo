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
├── data/seed.json       Los datos de partida (140 tareas, 27 proyectos)
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
4. Al arrancar por primera vez, el servidor crea las tablas y carga los
   datos de `data/seed.json`. En los logs verás:
   `{"tablas":"creadas","sembrado":true,"tareas":140}`

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
| GET · POST | `/api/carpetas` |
| PATCH · DELETE | `/api/carpetas/:id` |
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

## Carpetas

Una capa de orden **aparte del estado**: un proyecto puede estar en la
carpeta "Marca empleadora" y a la vez estar en curso. Agrupan proyectos
y también tareas sueltas.

- Admiten **un nivel de subcarpeta**. Con dos, nadie recuerda dónde dejó
  las cosas, así que el esquema y la interfaz lo impiden.
- Una tarea **hereda la carpeta de su proyecto** salvo que tenga una
  propia. Archivar el proyecto archiva sus doce tareas de una vez.
- Filtrar por una carpeta madre **incluye lo que hay en sus hijas**.
- **Borrar una carpeta no borra nada**: sus proyectos y tareas quedan sin
  carpeta y sus subcarpetas suben al primer nivel.

La columna `carpeta` de `tareas` y `proyectos` no lleva llave foránea a
propósito: si alguien borra una fila de `carpetas` a mano en la base, lo
de dentro no debe irse con ella. Las referencias muertas se limpian en
cada arranque, en `schema.sql`.

Las carpetas se ven en **todas** las vistas, no solo en Proyectos:

| Vista | Qué muestra |
| --- | --- |
| Resumen | Una tarjeta por carpeta con abiertas, proyectos, subcarpetas, barra de estados y vencidas |
| Mi trabajo | Chip de carpeta en cada fila |
| Tablero | Chip en cada tarjeta y reparto por carpeta en la cabecera de cada columna |
| Cronograma | Opción **Agrupar por carpeta**, con las subcarpetas colgando de su madre |
| Calendario | Línea de color a la izquierda de cada tarea y reparto del mes |
| Equipo | En qué carpetas trabaja cada persona |

Cualquiera de esos chips filtra por su carpeta, y volver a pulsarlo quita
el filtro.

## Completadas

Casi la mitad del tablero está terminado (64 de 140). Dejarlas en las
listas del día a día era trabajar sobre un escritorio sin vaciar la
papelera, así que **lo completado vive en su propia pestaña** y sale del
tablero, el cronograma, el calendario y Mi trabajo.

- La pestaña **Completadas** las agrupa por mes, de lo más reciente hacia
  atrás, que es como se busca algo que ya se hizo.
- Cualquiera se puede **reabrir** desde ahí. El avance no se toca:
  reabrir dice que la tarea vuelve a estar viva, no que se deshizo.
- La columna Completado del tablero sigue existiendo como sitio donde
  soltar una tarjeta, pero solo enseña las cuatro últimas y enlaza al
  archivo.
- El interruptor **Sin completadas / Con completadas** de la barra de
  filtros las devuelve a la vista cuando hacen falta. Filtrar por
  `Estado: Completado` también las muestra.

Las métricas no cambian: el avance de un proyecto, los anillos y las
barras de estado siguen contando todas las tareas. El archivo esconde
tareas de las listas de trabajo, no de las cuentas.

De paso, el tablero pinta 80 tarjetas en vez de 140: el pintado bajó un
43%.

### Códigos de tarea

Las versiones viejas numeraban `T-###` contando filas, así que borrar una
tarea hacía que la siguiente reutilizara un código ya usado. Hoy los tres
drivers numeran a partir del **mayor código existente**, y al cargar se
renumera cualquier repetido que venga de esa época, conservando el
primero para no cambiarle el código a quien ya lo tenga anotado.

## Arrastrar y soltar

El tablero usa **eventos de puntero**, no el arrastre nativo de HTML5.
El nativo no existe en pantallas táctiles: en iPad las tarjetas no se
movían. Con ratón la tarjeta se levanta a los 6px de movimiento; con el
dedo hay que mantener pulsado 350ms, para que deslizar la columna siga
siendo deslizar. El desplegable de estado de cada tarjeta sigue estando:
arrastrar es el atajo, no el único camino.

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
- **Orden de carpetas a mano.** Hoy se ordenan por el campo `orden`, que
  se asigna al crearlas. Falta poder reordenarlas arrastrando.

## De dónde salen los datos

`data/seed.json` se generó desde `GANTT_COMMS.xlsx`:

| Excel | JSON |
| --- | --- |
| Hoja `GANTT COMMS`, filas sin estado | `proyectos` (27) |
| Hoja `GANTT COMMS`, filas con estado | `tareas` (140) |
| Columna `ASIGNADO A` | `responsable` |
| Columna `CLIENTE` | `area` |
| Columna `PROGRESO` | `progreso` (0–1) |
| Columna `PRIORIDAD` | `estado` |
| Hoja `ESTATUS`, `FECHA DE ENTREGA` | `hitos` (9) |

Estados: `NO EMPEZADO`→`pendiente`, `EN PROCESO`→`proceso`,
`ENTREGADO`→`revision`, `APROBADO`→`completado`.

## Volver a cargar datos desde un CSV exportado

`Exportar CSV` saca el tablero completo. Para devolverlo al seed hay
que **fusionar**, no reemplazar: el CSV no lleva ids, ni carpetas, ni
las fechas de los comentarios. Las tareas se emparejan por **código +
título**, porque el código solo no basta.

Los códigos se generaban contando tareas, así que borrar una hacía que
la siguiente repitiera un código ya usado. En el CSV del 27 de agosto
había tres pares repetidos. Ahora salen del mayor código existente, en
el cliente y en los dos drivers.
