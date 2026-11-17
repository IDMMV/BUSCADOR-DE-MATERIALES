import {
  corsHeaders,
  parseBody,
  resolveAuthUser,
  hydrateUsersFromDrive,
  verifyPasswordServer
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
  const pass = String(body?.password || '');
  if (!pass) return res.status(200).json({ ok: false });

  const store = await hydrateUsersFromDrive(true);
  const admins = (store.userAccounts || []).filter(u => u && u.active !== false && u.role === 'admin');
  const matched = admins.some(a => verifyPasswordServer(a, pass));
  return res.status(200).json({ ok: matched });
}
