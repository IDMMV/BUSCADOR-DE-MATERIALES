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
  const newPass = String(body?.newPassword || '').trim();
  if (newPass.length < 4) {
    return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
  }

  const store = await hydrateUsersFromDrive(false);
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

  const salt = makeSalt();
  user.passwordSalt = salt;
  user.passwordHash = hashSecretServer(newPass, salt);
  user.mustChangePassword = false;
  user.isDefaultSeed = false;
  user.updatedAt = new Date().toISOString();

  appendServerAuditLog(store, 'CAMBIO_CLAVE', user, 'El usuario actualizó su contraseña personal', user.username, req);
  const saved = writeTmpUsers(store);
  await syncUsersToDriveServer().catch(() => {});

  return res.status(200).json({
    ok: true,
    user: sanitizeUser(user),
    userAccounts: sanitizeUsersList(saved.userAccounts),
    authLogs: saved.authLogs
  });
}
