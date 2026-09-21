import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

const CONFIG_FILE = path.join(__dirname, 'data', 'server-config.json');

function ensureDataDir(){
  const dir = path.join(__dirname, 'data');
  if(!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readSavedConfig(){
  ensureDataDir();
  let fileCfg = {};
  if(fs.existsSync(CONFIG_FILE)){
    try{ fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; }catch(_){}
  }
  return {
    scriptUrl: (process.env.GOOGLE_APPS_SCRIPT_URL || fileCfg.scriptUrl || '').trim(),
    scriptToken: (process.env.GOOGLE_APPS_SCRIPT_TOKEN || fileCfg.scriptToken || '').trim()
  };
}

function writeSavedConfig(url, token){
  ensureDataDir();
  const cur = readSavedConfig();
  const nextUrl = (url || cur.scriptUrl || '').trim();
  const nextToken = (token || cur.scriptToken || '').trim();
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

const DRIVE_TIMEOUT_MS = 12000;
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
