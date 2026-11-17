import {
  corsHeaders,
  parseBody,
  getClientIp,
  getRateLimitStatus,
  recordLoginFailure,
  clearLoginFailures,
  hydrateUsersFromDrive,
  verifyPasswordServer,
  appendServerAuditLog,
  writeTmpUsers,
  signSessionToken,
  setAuthCookie,
  syncUsersToDriveServer,
  sanitizeUser
} from '../_auth-lib.js';

export default async function handler(req, res) {
  corsHeaders(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });

  const body = parseBody(req);
  const identifier = String(body?.identifier || body?.username || '').trim();
  const password = String(body?.password || '');
  if (!identifier || !password) {
    return res.status(400).json({ ok: false, error: 'Ingresa tu usuario o correo y tu contraseña.' });
  }

  const clientIp = getClientIp(req);
  const rl = getRateLimitStatus(clientIp, identifier);
  if (rl.blocked) {
    return res.status(429).json({
      ok: false,
      error: `Demasiados intentos fallidos. Espera ${rl.remainingSec} segundos antes de volver a intentar.`,
      lockedSeconds: rl.remainingSec
    });
  }

  let store = await hydrateUsersFromDrive(false);
  const idUpper = identifier.toUpperCase();
  const idLower = identifier.toLowerCase();

  const findUser = (st) => (st.userAccounts || []).find(u =>
    String(u.username || '').toUpperCase() === idUpper ||
    (u.email && String(u.email).trim().toLowerCase() === idLower)
  );
  let user = findUser(store);
  if (!user || !verifyPasswordServer(user, password)) {
    store = await hydrateUsersFromDrive(true);
    user = findUser(store);
  }

  if (!user) {
    recordLoginFailure(rl.key);
    appendServerAuditLog(store, 'INTENTO_FALLIDO', idUpper, 'Usuario no registrado', idUpper, req);
    writeTmpUsers(store);
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
  }

  if (user.active === false) {
    recordLoginFailure(rl.key);
    appendServerAuditLog(store, 'INTENTO_FALLIDO', user, 'Cuenta deshabilitada intentó ingresar', user.username, req);
    writeTmpUsers(store);
    return res.status(403).json({ ok: false, error: 'Esta cuenta está deshabilitada. Contacta al Administrador.' });
  }

  if (!verifyPasswordServer(user, password)) {
    recordLoginFailure(rl.key);
    appendServerAuditLog(store, 'INTENTO_FALLIDO', user, 'Contraseña incorrecta', user.username, req);
    writeTmpUsers(store);
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
  }

  clearLoginFailures(rl.key);
  const now = new Date().toISOString();
  user.lastLoginAt = now;
  appendServerAuditLog(store, 'INICIO_SESION', user, 'Ingreso autorizado desde pantalla de inicio', user.username, req);
  const saved = writeTmpUsers(store);

  const token = signSessionToken(user);
  setAuthCookie(res, req, token);
  syncUsersToDriveServer().catch(() => {});

  return res.status(200).json({
    ok: true,
    user: sanitizeUser(user),
    token,
    authSettings: saved.authSettings,
    authLogs: saved.authLogs
  });
}
