import {
  corsHeaders,
  getSavedConfig,
  saveConfig,
  parseBody,
  fetchWithTimeout,
  DRIVE_TIMEOUT_MS,
  hydrateUsersFromDrive,
  mergeAuthLogs,
  writeTmpUsers,
  sanitizeUsersList
} from '../_auth-lib.js';

export default async function handler(req, res) {
  corsHeaders(res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  try {
    const body = parseBody(req);
    const cfg = getSavedConfig();
    const reqUrl = (body?.targetUrl || body?.url || body?.scriptUrl || '').trim();
    const reqToken = (body?.token || body?.scriptToken || '').trim();

    if (reqUrl) {
      saveConfig(reqUrl, reqToken);
    }

    const targetUrl = (cfg.scriptUrl || reqUrl).trim();
    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en el servidor o en la app.' });
    }

    const payload = body?.payload ? { ...body.payload } : { ...body };
    delete payload.targetUrl;
    delete payload.url;

    const serverUsers = await hydrateUsersFromDrive(true);
    if (payload.action === 'syncUsersAndAuth') {
      payload.userAccounts = serverUsers.userAccounts;
      payload.deletedUserIds = serverUsers.deletedUserIds;
      payload.authSettings = serverUsers.authSettings;
      payload.authLogs = mergeAuthLogs(serverUsers.authLogs, payload.authLogs);
    } else if (payload.action === 'syncAll' && payload.data && payload.data.app) {
      payload.data = {
        ...payload.data,
        app: {
          ...payload.data.app,
          userAccounts: serverUsers.userAccounts,
          deletedUserIds: serverUsers.deletedUserIds,
          authSettings: serverUsers.authSettings,
          authLogs: mergeAuthLogs(serverUsers.authLogs, payload.data.app.authLogs)
        }
      };
    }

    if (cfg.scriptToken) {
      payload.token = cfg.scriptToken;
    } else if (!payload.token && reqToken) {
      payload.token = reqToken;
    }

    const response = await fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return res.status(502).json({ ok: false, error: 'Respuesta no válida de Google Apps Script: ' + text.slice(0, 200) });
    }

    if (data && data.ok && Array.isArray(data.userAccounts)) {
      const merged = writeTmpUsers({
        userAccounts: data.userAccounts,
        deletedUserIds: data.deletedUserIds,
        authSettings: data.authSettings,
        authLogs: data.authLogs
      });
      data.userAccounts = sanitizeUsersList(merged.userAccounts);
      data.authLogs = merged.authLogs;
      data.authSettings = merged.authSettings;
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Error in /api/drive/sync serverless function:', err);
    return res.status(err?.name === 'AbortError' ? 504 : 500).json({
      ok: false,
      error: err?.name === 'AbortError'
        ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS / 1000} segundos.`
        : 'Error de conexión con Google Apps Script: ' + (err?.message || err)
    });
  }
}
