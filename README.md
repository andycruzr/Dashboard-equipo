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

**Una carpeta es una etiqueta, no un cajón.** Un proyecto o una tarea
puede llevar varias y aparece en todas.

Antes cada cosa vivía en una sola carpeta y existían subcarpetas para
cubrir el resto de casos. Eso era justo lo que se sentía raro: una
subcarpeta no dice "esto también es de aquello", dice "esto está más
adentro". La jerarquía se eliminó por completo.

- **Marcar varias**: el chip de carpeta de cualquier tarjeta abre una
  lista con casillas, y no se cierra al marcar la primera. Lo mismo en el
  panel de detalle y en los formularios de alta.
- Una tarea **hereda las carpetas de su proyecto** mientras no tenga
  ninguna propia. En cuanto marcas una, deja de heredar.
- Filtrar por cualquiera de sus carpetas la encuentra. En la vista
  Proyectos y en el cronograma agrupado por carpeta, lo que lleva dos
  **aparece bajo las dos cabeceras**: la suma de los grupos puede pasar
  del total, y es lo correcto.
- El chip muestra la primera y cuántas más: `Corporativo +1`.
- **Borrar una carpeta** solo quita esa etiqueta. Lo que llevaba otras
  las conserva, y no se borra ningún proyecto ni ninguna tarea.
- El botón **Agregar** de cada carpeta añade o quita **esa** etiqueta sin
  tocar las demás que ya tuvieran las cosas marcadas.

Las áreas cliente (CORPO, TALENT, CDI...) se eliminaron: hacían el mismo
trabajo de agrupar y obligaban a mantener dos taxonomías en paralelo.

En la base, `carpeta text` pasó a `carpetas jsonb` y la columna `padre`
de la tabla de carpetas desapareció. `schema.sql` migra los datos
existentes al arrancar: la carpeta que hubiera se convierte en una
etiqueta única. El front hace lo mismo en memoria, así que un tablero de
la versión anterior se abre sin que nadie tenga que tocar nada.

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

## Cambiar el responsable

Se cambia desde tres sitios, todos con el mismo menú de personas: el
avatar de la tarea en cualquier lista, el campo **Responsable** del panel
de detalle y la fila del responsable dentro de **Equipo de la tarea**. Un
colaborador se asciende con la flecha de su fila, y el que estaba pasa a
colaborar en vez de desaparecer.

Antes esto estaba roto y no era evidente: al eliminar el arrastrar y
soltar se borró `asignarA()`, que también usaba el menú de personas. El
menú se abría, elegías a alguien y no pasaba nada, sin ningún error en
pantalla. `test/llamadas.js` ahora revisa que no haya ninguna función que
se llame y no exista, para que esa clase de fallo no vuelva a pasar en
silencio.

## Volver

Entrar a un proyecto, una carpeta o una persona te lleva a otra vista, y
antes ahí se acababa el camino: para regresar había que acordarse de
dónde saliste. Ahora aparece un botón **Volver a …** arriba del
contenido, que deshace el salto y suelta el filtro que lo acompañaba. Si
encadenas dos saltos, te devuelve al principio y no a medio camino.

## Todo se mueve con botones

**No hay arrastrar y soltar.** Tuvo dos versiones y las dos fallaron: la
nativa de HTML5 no existe en pantallas táctiles, y la de eventos de
puntero se portaba mal en uso real. Un gesto que a veces agarra la
tarjeta, a veces la abre y a veces no hace nada es peor que no tenerlo.

| Qué mover | Cómo |
| --- | --- |
| Estado de una tarea | Desplegable en la propia tarjeta, o el campo del panel |
| Responsable | Avatar de la tarea, que abre el menú de personas |
| Carpeta de una tarea | Chip de carpeta de la tarjeta, o el campo del panel |
| Carpeta de un proyecto | Chip de carpeta de su tarjeta, o el campo del formulario |
| Llenar una carpeta entera | Botón **Agregar** en la cabecera de la carpeta |

Son controles que funcionan igual con ratón, dedo y teclado, y que se
pueden probar de verdad en la batería automática. El arrastre no: jsdom
no tiene disposición ni `elementFromPoint`, así que las pruebas lo daban
por bueno mientras en el navegador estaba roto.

### Cuatro formas de meter algo en una carpeta

1. **Al crear la tarea.** El alta trae un selector de carpeta, precargado
   con la carpeta en la que estés parado.
2. **Al crear o editar el proyecto.** Mismo selector en su formulario.
3. **Desde la tarjeta.** El chip de carpeta de cualquier tarea o proyecto
   abre el menú para moverlo, en la vista que sea.
4. **Desde la carpeta.** El botón **Agregar** de su cabecera abre la
   lista completa de proyectos y tareas sueltas con una casilla cada uno:
   marcas lo que entra, desmarcas lo que sale, y se aplica todo junto.
   Desmarcar nunca borra nada, solo saca de la carpeta.

## Auditoría

Repaso completo de usabilidad, accesibilidad, código y diseño. Lo que se
quitó y por qué:

**Dos barras de filtros haciendo lo mismo.** La tira de arriba filtraba
por estado, prioridad y avisos; la barra de abajo repetía las tres en
desplegables, escribiendo en las mismas variables. Dos sitios para poner
el mismo filtro y dos aspectos distintos de "activo". La barra se quedó
solo con las dimensiones que necesitan una lista para elegir
(responsable, carpeta, proyecto, área), y lo que se pone desde la tira
aparece abajo como ficha con su × — todo lo activo, junto y en un solo
estilo.

**El filtro se quedaba pegado.** Entrar a una carpeta, a un proyecto o a
una persona pone un filtro, y ese filtro era global: al salir al
cronograma seguías viendo solo esa carpeta sin haberlo pedido. Ahora hay
dos clases. El que pones tú desde la barra o la tira se queda hasta que
lo quites. El que se pone solo al entrar a algo se suelta en cuanto
cambias de vista o de pestaña, y el aviso lo dice mientras está activo
("se suelta al cambiar de vista"). Ir de una carpeta a otra tampoco
acumula: reemplaza.

**El filtro activo no se veía.** La señal existía (borde de acento en la
barra de arriba) pero estaba en el sitio equivocado: nadie mira una barra
superior cuando está buscando por qué falta una tarea. Ahora hay un aviso
**dentro del contenido**, justo encima de la lista, que dice las tres
cosas que importan: cuántas ves de cuántas, qué está filtrando y un botón
para quitarlo. Sale en todas las vistas y se anuncia con `role="status"`.

**Filtrar te sacaba de la vista.** Tocar un estado en la tira te llevaba
al tablero aunque estuvieras a media revisión del cronograma. Ahora solo
cambia de vista desde Equipo, la única que no muestra tareas.

**Código muerto.** Cinco funciones que nadie llamaba (`bindPersonas`,
`chipCarpeta`, `tarjetaCifra`, `franjaEquipo`, `hayFiltros`), la función
vacía `wireSoltar` con sus dos llamadas, once reglas CSS sin un solo uso
(`.rapida`, `.rapidas`, `.drop-activo`, `.zona-drop`, `.stencil`,
`.tinte-8`, `.tinte-14`), el campo `nTareas` que nunca se leía y un
atributo `data-` huérfano. Hoy el archivo no tiene ninguna función ni
clase sin usar.

**Accesibilidad.** Tres campos sin nombre para un lector de pantalla
(`#search`, `#commentBox`, `#llBuscar`) ahora lo tienen. Ocho botones de
icono de entre 20 y 30px crecen a 40px en pantalla táctil, sin cambiar
nada en escritorio.

**Listas que escondían tareas sin salida.** El bloque de tareas sueltas
mostraba seis y decía "y 16 más en el cronograma": te informaba de que
existían y te dejaba sin forma de verlas. Ahora todo recorte lleva un
botón que despliega la lista completa y la vuelve a plegar. Esas dos
listas además se saltaban los filtros y eran las únicas del tablero que
seguían mostrando tareas completadas.

**Consistencia visual.** 18 radios de esquina distintos se redujeron a
una escala de 6 (4, 8, 12, 16, 20, redondo) y 20 tamaños de letra a 13,
moviendo cada valor como mucho 1px para no romper ninguna caja.

Todo esto queda fijado en `test/auditoria.js`: si algo de esto vuelve, la
prueba falla.

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
| Hoja `GANTT COMMS`, filas sin estado | `proyectos` (28) |
| Hoja `GANTT COMMS`, filas con estado | `tareas` (140) |
| Columna `ASIGNADO A` | `responsable` |
| Columna `CLIENTE` | `carpeta` |
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
