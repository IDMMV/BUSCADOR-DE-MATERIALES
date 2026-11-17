import {
  corsHeaders,
  parseBody,
  resolveAuthUser,
  hydrateUsersFromDrive,
  verifyPasswordServer,
  makeSalt,
  hashSecretServer,
  appendServerAuditLog,
  writeTmpUsers,
  syncUsersToDriveServer,
  signSessionToken,
  setAuthCookie,
  getClientIp,
  clearLoginFailures,
  sanitizeUser,
  sanitizeUsersList
} from '../_auth-lib.js';

export default async function handler(req, res) {
  corsHeaders(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });

  const authUser = await resolveAuthUser(req);
  if (!authUser) {
    return res.status(401).json({ ok: false, error: 'Sesión requerida o expirada. Inicia sesión nuevamente.' });
  }

  const body = parseBody(req);
  const curPass = String(body?.currentPassword || '');
  const newPass = String(body?.newPassword || '');
  if (!newPass.trim() || newPass.length < 4) {
    return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
  }

  const store = await hydrateUsersFromDrive(true);
  const user = (store.userAccounts || []).find(
    u => u.id === authUser.id || String(u.username || '').toUpperCase() === String(authUser.username).toUpperCase()
  );
  if (!user) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
  }

  if (!body?.forcedFirstChange || curPass) {
    if (!verifyPasswordServer(user, curPass)) {
      return res.status(401).json({ ok: false, error: 'La contraseña actual es incorrecta.' });
    }
  } else if (!user.mustChangePassword) {
    return res.status(401).json({ ok: false, error: 'Ingresa tu contraseña actual.' });
  }

  const now = new Date().toISOString();
  const salt = makeSalt();
  user.passwordSalt = salt;
  user.passwordHash = hashSecretServer(newPass, salt);
  user.provisionalHash = '';
  user.provisionalSalt = '';
  user.mustChangePassword = false;
  user.isDefaultSeed = false;
  user.passwordUpdatedAt = now;
  user.updatedAt = now;

  const clientIp = getClientIp(req);
  clearLoginFailures(`${clientIp}::${String(user.username || '').trim().toUpperCase()}`);
  if (user.email) clearLoginFailures(`${clientIp}::${String(user.email || '').trim().toUpperCase()}`);

  appendServerAuditLog(store, 'CAMBIO_CLAVE', user, 'El usuario actualizó su contraseña personal', user.username, req);
  const saved = writeTmpUsers(store);
  const token = signSessionToken(user);
  setAuthCookie(res, req, token);
  const syncedToDrive = await syncUsersToDriveServer().catch(() => false);

  return res.status(200).json({
    ok: true,
    syncedToDrive: Boolean(syncedToDrive),
    token,
    user: sanitizeUser(user),
    userAccounts: sanitizeUsersList(saved.userAccounts),
    authLogs: saved.authLogs
  });
}
