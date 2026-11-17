import { corsHeaders, resolveAuthUser, readTmpUsers, sanitizeUser } from '../_auth-lib.js';

export default async function handler(req, res) {
  corsHeaders(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authUser = await resolveAuthUser(req);
  if (!authUser) {
    return res.status(200).json({ ok: false, authenticated: false });
  }
  const store = readTmpUsers();
  return res.status(200).json({
    ok: true,
    authenticated: true,
    user: sanitizeUser(authUser),
    authSettings: store.authSettings
  });
}
