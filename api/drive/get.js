import {
  corsHeaders,
  getSavedConfig,
  saveConfig,
  fetchWithTimeout,
  DRIVE_TIMEOUT_MS,
  resolveAuthUser,
  writeTmpUsers,
  sanitizeUsersList
} from '../_auth-lib.js';

export default async function handler(req, res) {
  corsHeaders(res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const cfg = getSavedConfig();
    const reqUrl = (req.query?.url || '').trim();
    const reqToken = (req.query?.token || '').trim();
    if (reqUrl) {
      saveConfig(reqUrl, reqToken);
    }
    const targetUrl = (cfg.scriptUrl || reqUrl).trim();
    const token = cfg.scriptToken || reqToken || '';
    const action = req.query?.action || 'getAll';

    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en el servidor ni en la app.' });
    }

    const cleanBase = targetUrl.replace(/\?.*$/, '');
    const urlWithParams = `${cleanBase}?action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}&_=${Date.now()}`;

    const response = await fetchWithTimeout(urlWithParams, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow'
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return res.status(502).json({ ok: false, error: 'Respuesta no válida de Google Apps Script: ' + text.slice(0, 200) });
    }

    const authUser = await resolveAuthUser(req);
    if (data && data.ok) {
      if (action === 'getAll' && data.data && data.data.app) {
        if (Array.isArray(data.data.app.userAccounts) || Array.isArray(data.data.app.authLogs)) {
          const merged = writeTmpUsers({
            userAccounts: data.data.app.userAccounts || [],
            deletedUserIds: data.data.app.deletedUserIds || [],
            authSettings: data.data.app.authSettings || {},
            authLogs: data.data.app.authLogs || []
          });
          data.data.app.userAccounts = sanitizeUsersList(merged.userAccounts);
          data.data.app.deletedUserIds = merged.deletedUserIds;
          data.data.app.authSettings = merged.authSettings;
          data.data.app.authLogs = authUser ? merged.authLogs : [];
        }
      } else if (action === 'getUsersAndAuth') {
        const merged = writeTmpUsers({
          userAccounts: data.userAccounts || [],
          deletedUserIds: data.deletedUserIds || [],
          authSettings: data.authSettings || {},
          authLogs: data.authLogs || []
        });
        data.userAccounts = sanitizeUsersList(merged.userAccounts);
        data.deletedUserIds = merged.deletedUserIds;
        data.authSettings = merged.authSettings;
        data.authLogs = authUser ? merged.authLogs : [];
      }
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Error in /api/drive/get serverless function:', err);
    return res.status(err?.name === 'AbortError' ? 504 : 500).json({
      ok: false,
      error: err?.name === 'AbortError'
        ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS / 1000} segundos.`
        : 'Error al consultar Google Apps Script: ' + (err?.message || err)
    });
  }
}
