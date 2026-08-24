/**
 * Selector de driver de almacenamiento.
 *
 * Todos los drivers exponen los mismos métodos. Cambia STORAGE
 * y la API sigue funcionando sin tocar una línea de server.js.
 *
 *   STORAGE=json      (por defecto) — un archivo JSON en disco, cero configuración
 *   STORAGE=postgres              — crea sus tablas solo al arrancar, ver postgres.js
 *
 * init() es opcional: si un driver no lo trae, se usa un no-op.
 */

const driver = process.env.STORAGE || 'json';

const impl = driver === 'postgres' ? require('./postgres')
                                   : require('./json-file');

if (typeof impl.init !== 'function') impl.init = async () => null;

module.exports = Object.assign({ driver }, impl);
