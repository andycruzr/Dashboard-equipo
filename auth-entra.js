/**
 * Validación de tokens de Microsoft Entra ID.
 *
 * ÚSALO SOLO SI HOSPEDAS FUERA DE AZURE (por ejemplo en Render).
 *
 * Si mueves el servidor a Azure App Service, activa "Authentication"
 * (Easy Auth) en el portal y no necesitas nada de este archivo:
 * Azure valida el token antes de que la petición llegue a Node y te
 * pasa el usuario en las cabeceras X-MS-CLIENT-PRINCIPAL-*.
 *
 * Variables:
 *   AUTH=entra
 *   TENANT_ID=...
 *   CLIENT_ID=...          (el mismo de la app registrada)
 */

const { createRemoteJWKSet, jwtVerify } = require('jose');

let jwks = null;

function middleware() {
  const tenant = process.env.TENANT_ID;
  const clientId = process.env.CLIENT_ID;
  if (!tenant || !clientId) {
    throw new Error('AUTH=entra necesita TENANT_ID y CLIENT_ID');
  }

  jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`));

  return async (req, res, next) => {
    if (req.path === '/api/health') return next();

    // La página en sí se sirve sin token: el navegador necesita cargar
    // el HTML para poder pedirle el token a Teams o a MSAL. Lo que se
    // protege es la API, que es donde están los datos.
    if (!req.path.startsWith('/api/')) return next();

    const cabecera = req.headers.authorization || '';
    const [tipo, token] = cabecera.split(' ');
    if (tipo !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Falta el token de Entra ID' });
    }

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: [
          `https://login.microsoftonline.com/${tenant}/v2.0`,
          `https://sts.windows.net/${tenant}/`
        ],
        audience: [clientId, `api://${process.env.APP_DOMAIN}/${clientId}`]
      });

      // Queda disponible para firmar los comentarios con el usuario real
      req.usuario = {
        id: payload.oid,
        nombre: payload.name,
        correo: payload.preferred_username || payload.upn
      };
      next();
    } catch (e) {
      res.status(401).json({ error: 'Token inválido', detail: e.message });
    }
  };
}

module.exports = { middleware };
