import {
  corsHeaders,
  parseBody,
  resolveAuthUser,
  readTmpUsers,
  appendServerAuditLog,
  writeTmpUsers,
  syncUsersToDriveServer,
  clearAuthCookie
} from '../_auth-lib.js';

export default async function handler(req, res) {
  corsHeaders(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = parseBody(req);
  const reason = String(body?.reason || 'manual');
  const authUser = await resolveAuthUser(req);
  if (authUser) {
    const store = readTmpUsers();
    const ev = reason === 'inactivity' ? 'CIERRE_INACTIVIDAD' : 'CIERRE_SESION';
    const detail = reason === 'inactivity' ? 'Cierre automático por inactividad' : 'Cierre de sesión manual';
    appendServerAuditLog(store, ev, authUser, detail, authUser.username, req);
    writeTmpUsers(store);
    await syncUsersToDriveServer().catch(() => {});
  }
  clearAuthCookie(res, req);
  return res.status(200).json({ ok: true });
}
