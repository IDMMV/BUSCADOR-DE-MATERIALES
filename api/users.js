import {
  corsHeaders,
  parseBody,
  resolveAuthUser,
  hydrateUsersFromDrive,
  sanitizeUser,
  sanitizeUsersList,
  makeSalt,
  hashSecretServer,
  appendServerAuditLog,
  writeTmpUsers,
  normalizeAuthSettings,
  syncUsersToDriveServer,
  getClientIp,
  clearLoginFailures
} from './_auth-lib.js';

export default async function handler(req, res) {
  corsHeaders(res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authUser = await resolveAuthUser(req);

  if (req.method === 'GET') {
    const store = await hydrateUsersFromDrive(true);
    const users = store.userAccounts || [];
    const onlyRootSeed = users.length === 1 && users[0]?.username === 'ADMIN' && Boolean(users[0]?.isDefaultSeed);
    return res.status(200).json({
      ok: true,
      userAccounts: sanitizeUsersList(users),
      deletedUserIds: store.deletedUserIds,
      authSettings: store.authSettings,
      authLogs: authUser ? store.authLogs : [],
      onlyRootSeed,
      updatedAt: store.updatedAt
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  if (!authUser) {
    return res.status(401).json({ ok: false, error: 'Sesión de administrador requerida.' });
  }
  if (authUser.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Permisos insuficientes. Se requiere rol de Administrador.' });
  }

  const body = parseBody(req);
  const op = String(body.op || '').trim();
  const store = await hydrateUsersFromDrive(true);
  const actor = authUser.username;

  if (op === 'create') {
    const username = String(body.username || '').trim().toUpperCase();
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const pass = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'user';
    const defaultCenter = ['1003', '1004'].includes(String(body.defaultCenter || '')) ? String(body.defaultCenter) : '';
    const defaultSupervisor = String(body.defaultSupervisor || '').trim().toUpperCase();
    const mustChangePassword = Boolean(body.mustChangePassword);

    if (!username || !fullName) {
      return res.status(400).json({ ok: false, error: 'Completa el Usuario y Nombre completo.' });
    }
    if (!pass.trim() || pass.length < 4) {
      return res.status(400).json({ ok: false, error: 'Asigna una contraseña de al menos 4 caracteres.' });
    }
    if ((store.userAccounts || []).some(u => String(u.username || '').toUpperCase() === username || (email && u.email && String(u.email).toLowerCase() === email))) {
      return res.status(409).json({ ok: false, error: 'Ya existe un usuario con ese código o correo.' });
    }

    const salt = makeSalt();
    const now = new Date().toISOString();
    const newUser = {
      id: 'usr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      username,
      email,
      fullName,
      role,
      active: true,
      mustChangePassword,
      isDefaultSeed: false,
      defaultCenter,
      defaultSupervisor,
      passwordSalt: salt,
      passwordHash: hashSecretServer(pass, salt),
      passwordUpdatedAt: now,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: ''
    };
    store.userAccounts.unshift(newUser);
    appendServerAuditLog(store, 'CREAR_USUARIO', newUser, `Cuenta creada (${role === 'admin' ? 'Administrador' : 'Usuario estándar'})`, actor, req);
    const saved = writeTmpUsers(store);
    await syncUsersToDriveServer().catch(() => {});
    return res.status(200).json({
      ok: true,
      user: sanitizeUser(newUser),
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  if (op === 'update') {
    const uid = String(body.id || '');
    const user = (store.userAccounts || []).find(u => u.id === uid);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const role = body.role === 'admin' ? 'admin' : 'user';
    const newPass = String(body.password || '');
    const defaultCenter = ['1003', '1004'].includes(String(body.defaultCenter || '')) ? String(body.defaultCenter) : '';
    const defaultSupervisor = String(body.defaultSupervisor || '').trim().toUpperCase();
    const mustChangePassword = Boolean(body.mustChangePassword);

    if (!fullName) return res.status(400).json({ ok: false, error: 'El nombre completo es obligatorio.' });
    if (email && (store.userAccounts || []).some(u => u.id !== uid && u.email && String(u.email).toLowerCase() === email)) {
      return res.status(409).json({ ok: false, error: 'Ese correo ya pertenece a otro usuario.' });
    }
    if (newPass && (!newPass.trim() || newPass.length < 4)) {
      return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
    }
    if (user.role === 'admin' && role !== 'admin') {
      const otherAdmins = (store.userAccounts || []).filter(u => u.id !== uid && u.active !== false && u.role === 'admin');
      if (!otherAdmins.length) {
        return res.status(400).json({ ok: false, error: 'Debe existir al menos un Administrador activo en el sistema.' });
      }
    }

    const now = new Date().toISOString();
    user.fullName = fullName;
    user.email = email;
    user.role = role;
    user.defaultCenter = defaultCenter;
    user.defaultSupervisor = defaultSupervisor;
    user.mustChangePassword = mustChangePassword;
    if (newPass) {
      const salt = makeSalt();
      user.passwordSalt = salt;
      user.passwordHash = hashSecretServer(newPass, salt);
      user.provisionalHash = '';
      user.provisionalSalt = '';
      user.isDefaultSeed = false;
      user.passwordUpdatedAt = now;
      const clientIp = getClientIp(req);
      clearLoginFailures(`${clientIp}::${String(user.username || '').trim().toUpperCase()}`);
      if (user.email) clearLoginFailures(`${clientIp}::${String(user.email || '').trim().toUpperCase()}`);
    }
    user.updatedAt = now;
    appendServerAuditLog(store, newPass ? 'CAMBIO_CLAVE' : 'ACTUALIZAR_USUARIO', user, newPass ? 'Administrador asignó nueva contraseña y actualizó cuenta' : 'Administrador actualizó datos/rol/perfil', actor, req);
    const saved = writeTmpUsers(store);
    const syncedToDrive = await syncUsersToDriveServer().catch(() => false);
    return res.status(200).json({
      ok: true,
      syncedToDrive: Boolean(syncedToDrive),
      user: sanitizeUser(user),
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  if (op === 'toggle') {
    const uid = String(body.id || '');
    const user = (store.userAccounts || []).find(u => u.id === uid);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
    const nextActive = user.active === false;
    if (!nextActive && user.role === 'admin') {
      const otherAdmins = (store.userAccounts || []).filter(u => u.id !== uid && u.active !== false && u.role === 'admin');
      if (!otherAdmins.length) {
        return res.status(400).json({ ok: false, error: 'No puedes desactivar al único Administrador activo.' });
      }
    }
    user.active = nextActive;
    user.updatedAt = new Date().toISOString();
    appendServerAuditLog(store, 'ACTUALIZAR_USUARIO', user, nextActive ? 'Cuenta activada' : 'Cuenta deshabilitada', actor, req);
    const saved = writeTmpUsers(store);
    await syncUsersToDriveServer().catch(() => {});
    return res.status(200).json({
      ok: true,
      user: sanitizeUser(user),
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  if (op === 'delete') {
    const uid = String(body.id || '');
    const user = (store.userAccounts || []).find(u => u.id === uid);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
    if (user.role === 'admin') {
      const otherAdmins = (store.userAccounts || []).filter(u => u.id !== uid && u.active !== false && u.role === 'admin');
      if (!otherAdmins.length) {
        return res.status(400).json({ ok: false, error: 'No puedes eliminar al único Administrador activo.' });
      }
    }
    store.deletedUserIds = Array.from(new Set([...(store.deletedUserIds || []), uid])).slice(-200);
    store.userAccounts = (store.userAccounts || []).filter(u => u.id !== uid);
    appendServerAuditLog(store, 'ELIMINAR_USUARIO', user, 'Usuario eliminado por administrador', actor, req);
    const saved = writeTmpUsers({ ...store, replaceAll: true });
    await syncUsersToDriveServer().catch(() => {});
    return res.status(200).json({
      ok: true,
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  if (op === 'settings') {
    const mins = Number(body.sessionTimeoutMinutes);
    store.authSettings = normalizeAuthSettings({ sessionTimeoutMinutes: Number.isFinite(mins) ? mins : 30 }, store.authSettings);
    appendServerAuditLog(store, 'CONFIG_SEGURIDAD', actor, `Tiempo de cierre por inactividad configurado a ${store.authSettings.sessionTimeoutMinutes} min`, actor, req);
    const saved = writeTmpUsers(store);
    await syncUsersToDriveServer().catch(() => {});
    return res.status(200).json({
      ok: true,
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  const saved = writeTmpUsers(body);
  return res.status(200).json({
    ok: true,
    userAccounts: sanitizeUsersList(saved.userAccounts),
    deletedUserIds: saved.deletedUserIds,
    authSettings: saved.authSettings,
    authLogs: saved.authLogs
  });
}
