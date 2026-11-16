import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

const CONFIG_FILE = path.join(__dirname, 'data', 'server-config.json');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

function ensureDataDir(){
  const dir = path.join(__dirname, 'data');
  if(!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
  }
}

function mergeUsersLists(existingUsers = [], incomingUsers = [], deletedIds = []){
  const deletedSet = new Set((Array.isArray(deletedIds) ? deletedIds : []).map(String));
  const byId = new Map();
  const byUsername = new Map();

  const applyUser = (u) => {
    if (!u || !u.username) return;
    const id = String(u.id || ('usr-' + String(u.username).toUpperCase()));
    if (deletedSet.has(id)) return;
    const clean = { ...u, id, username: String(u.username).trim().toUpperCase() };
    const prev = byId.get(id) || byUsername.get(clean.username);
    if (!prev || String(clean.updatedAt || '') >= String(prev.updatedAt || '')) {
      byId.delete(prev?.id || id);
      byId.set(id, clean);
      byUsername.set(clean.username, clean);
    }
  };

  existingUsers.forEach(applyUser);
  incomingUsers.forEach(applyUser);
  return Array.from(byId.values()).filter(u => !deletedSet.has(String(u.id)));
}

function mergeAuthLogs(existingLogs = [], incomingLogs = []){
  const byId = new Map();
  [...(Array.isArray(existingLogs) ? existingLogs : []), ...(Array.isArray(incomingLogs) ? incomingLogs : [])]
    .forEach(log => {
      if (!log) return;
      const id = String(log.id || `${log.timestamp || ''}_${log.event || ''}_${log.username || ''}`);
      if (!byId.has(id)) byId.set(id, { ...log, id });
    });
  return Array.from(byId.values())
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, 500);
}

function readSavedUsers(){
  ensureDataDir();
  if(fs.existsSync(USERS_FILE)){
    try{
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      const rawAuth = parsed?.authSettings && typeof parsed.authSettings === 'object' ? parsed.authSettings : {};
      return {
        userAccounts: Array.isArray(parsed?.userAccounts) ? parsed.userAccounts : [],
        deletedUserIds: Array.isArray(parsed?.deletedUserIds) ? parsed.deletedUserIds : [],
        authSettings: { ...rawAuth, requireLogin: true, allowGuest: false },
        authLogs: Array.isArray(parsed?.authLogs) ? parsed.authLogs : [],
        updatedAt: parsed?.updatedAt || ''
      };
    }catch(_){}
  }
  return { userAccounts: [], deletedUserIds: [], authSettings: { requireLogin: true, allowGuest: false }, authLogs: [], updatedAt: '' };
}

function writeSavedUsers(payload){
  ensureDataDir();
  const current = readSavedUsers();
  const incomingDeleted = Array.isArray(payload?.deletedUserIds) ? payload.deletedUserIds : [];
  const deletedUserIds = Array.from(new Set([...(current.deletedUserIds || []), ...incomingDeleted].map(String))).slice(-200);
  const incomingUsers = Array.isArray(payload?.userAccounts) ? payload.userAccounts : [];
  const userAccounts = payload?.replaceAll
    ? incomingUsers.filter(u => u && !deletedUserIds.includes(String(u.id)))
    : mergeUsersLists(current.userAccounts, incomingUsers, deletedUserIds);
  const authLogs = mergeAuthLogs(current.authLogs, payload?.authLogs);
  const rawAuth = payload?.authSettings && typeof payload.authSettings === 'object' ? payload.authSettings : {};
  const data = {
    userAccounts,
    deletedUserIds,
    authSettings: { ...current.authSettings, ...rawAuth, requireLogin: true, allowGuest: false },
    authLogs,
    updatedAt: new Date().toISOString()
  };
  try{
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }catch(e){
    console.warn('Could not save users file:', e.message);
  }
  return data;
}

function cleanConfigUrl(u){
  const s = String(u || '').trim();
  if(!s || /TU_SCRIPT_ID/i.test(s)) return '';
  return s;
}

function cleanConfigToken(t){
  const s = String(t || '').trim();
  if(!s || /^TU_CLAVE_SECRETA_AQUI$/i.test(s)) return '';
  return s;
}

function readSavedConfig(){
  ensureDataDir();
  let fileCfg = {};
  if(fs.existsSync(CONFIG_FILE)){
    try{ fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; }catch(_){}
  }
  return {
    scriptUrl: cleanConfigUrl(process.env.GOOGLE_APPS_SCRIPT_URL) || cleanConfigUrl(fileCfg.scriptUrl),
    scriptToken: cleanConfigToken(process.env.GOOGLE_APPS_SCRIPT_TOKEN) || cleanConfigToken(fileCfg.scriptToken)
  };
}

function writeSavedConfig(url, token){
  ensureDataDir();
  const cur = readSavedConfig();
  const nextUrl = cleanConfigUrl(url) || cur.scriptUrl || '';
  const nextToken = cleanConfigToken(token) || cur.scriptToken || '';
  if(!nextUrl && !nextToken) return cur;
  const data = {
    scriptUrl: nextUrl,
    scriptToken: nextToken,
    updatedAt: new Date().toISOString()
  };
  try{
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  }catch(e){
    console.warn('Could not save server config to file:', e.message);
  }
  return data;
}

const DRIVE_TIMEOUT_MS = 25000;
function fetchWithTimeout(url, options={}, timeoutMs=DRIVE_TIMEOUT_MS){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  return fetch(url,{...options,signal:controller.signal}).finally(()=>clearTimeout(timer));
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname, {
  index: false,
  fallthrough: true,
  extensions: false,
  setHeaders: (res, filePath) => {
    if (/\.(js|mjs|css|json|webmanifest|png|jpe?g|gif|svg|ico|webp|xlsx|txt|map)$/i.test(filePath)) {
      res.setHeader('Cache-Control','no-store, max-age=0');
    }
  }
}));

app.get('/api/config', (req, res) => {
  const cfg = readSavedConfig();
  res.json({
    scriptUrl: cfg.scriptUrl,
    scriptToken: cfg.scriptToken
  });
});

app.post('/api/config', (req, res) => {
  const url = (req.body?.scriptUrl || req.body?.url || '').trim();
  const token = (req.body?.scriptToken || req.body?.token || '').trim();
  const saved = writeSavedConfig(url, token);
  res.json({ ok: true, config: saved });
});

app.get('/api/users', (req, res) => {
  res.json({ ok: true, ...readSavedUsers() });
});

app.post('/api/users', (req, res) => {
  const saved = writeSavedUsers(req.body || {});
  res.json({ ok: true, ...saved });
});

app.post('/api/drive/sync', async (req, res) => {
  try {
    const cfg = readSavedConfig();
    const reqUrl = (req.body?.targetUrl || req.body?.url || req.body?.scriptUrl || '').trim();
    const reqToken = (req.body?.token || req.body?.scriptToken || '').trim();

    if (reqUrl) {
      writeSavedConfig(reqUrl, reqToken);
    }

    const targetUrl = (cfg.scriptUrl || reqUrl).trim();
    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en el servidor ni en la app.' });
    }
    const payload = req.body?.payload ? { ...req.body.payload } : { ...req.body };
    delete payload.targetUrl;
    delete payload.url;

    if (cfg.scriptToken) {
      payload.token = cfg.scriptToken;
    } else if (!payload.token && reqToken) {
      payload.token = reqToken;
    }

    const response = await fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
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
    return res.json(data);
  } catch (err) {
    console.error('Error in /api/drive/sync proxy:', err);
    return res.status(err?.name==='AbortError'?504:500).json({ ok: false, error: err?.name==='AbortError'
      ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS/1000} segundos.`
      : 'Error de conexión con Google Apps Script: ' + (err?.message || err) });
  }
});

app.get('/api/drive/get', async (req, res) => {
  try {
    const cfg = readSavedConfig();
    const reqUrl = (req.query?.url || '').trim();
    const reqToken = (req.query?.token || '').trim();

    if (reqUrl) {
      writeSavedConfig(reqUrl, reqToken);
    }

    const targetUrl = (cfg.scriptUrl || reqUrl).trim();
    const token = cfg.scriptToken || reqToken;
    const action = req.query?.action || 'getAll';

    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en el servidor ni en la app.' });
    }

    const cleanBase = targetUrl.replace(/\?.*$/, '');
    const urlWithParams = `${cleanBase}?action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}&_=${Date.now()}`;

    const response = await fetchWithTimeout(urlWithParams, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      redirect: 'follow'
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return res.status(502).json({ ok: false, error: 'Respuesta no válida de Google Apps Script: ' + text.slice(0, 200) });
    }
    return res.json(data);
  } catch (err) {
    console.error('Error in /api/drive/get proxy:', err);
    return res.status(err?.name==='AbortError'?504:500).json({ ok: false, error: err?.name==='AbortError'
      ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS/1000} segundos.`
      : 'Error al consultar Google Apps Script: ' + (err?.message || err) });
  }
});

app.get('*', async (req, res) => {
  if (/\.[a-z0-9]+$/i.test(req.path)) {
    return res.status(404).type('text/plain').send('Recurso no encontrado: ' + req.path);
  }
  try {
    res.setHeader('Cache-Control','no-store, max-age=0');
    return res.sendFile(path.join(__dirname, 'index.html'));
  } catch (err) {
    console.error('Error sirviendo index.html:', err);
    return res.status(500).type('text/plain').send('No se pudo cargar la aplicación.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
