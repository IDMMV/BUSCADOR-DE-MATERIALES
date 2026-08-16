import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const DRIVE_TIMEOUT_MS = 12000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname, {
  index: false,
  fallthrough: true,
  extensions: false,
  setHeaders: (res, filePath) => {
    if (/\.(js|mjs|css|json|webmanifest|png|jpe?g|gif|svg|ico|webp|xlsx|txt|map)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  }
}));

function fetchWithTimeout(url, options = {}, timeoutMs = DRIVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const scriptUrl = (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
  const scriptToken = (process.env.GOOGLE_APPS_SCRIPT_TOKEN || '').trim();
  res.json({ configured: Boolean(scriptUrl && scriptToken), proxyOnly: true });
});

app.post('/api/drive/sync', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const envUrl = (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
    const envToken = (process.env.GOOGLE_APPS_SCRIPT_TOKEN || '').trim();
    const targetUrl = (envUrl || req.body?.targetUrl || req.body?.url || '').trim();
    if (!targetUrl) return res.status(400).json({ ok:false, error:'URL de Google Apps Script no configurada en el servidor o en la app.' });
    const payload = req.body?.payload ? { ...req.body.payload } : { ...req.body };
    delete payload.targetUrl; delete payload.url;
    if (envToken) payload.token = envToken;
    else if (!payload.token && req.body?.token) payload.token = req.body.token;
    const response = await fetchWithTimeout(targetUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload),redirect:'follow'});
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { return res.status(502).json({ok:false,error:'Respuesta no válida de Google Apps Script: '+text.slice(0,200)}); }
    return res.status(response.ok ? 200 : 502).json(data);
  } catch(err) {
    const timeout = err?.name === 'AbortError';
    console.error('Error in /api/drive/sync proxy:', err);
    return res.status(timeout ? 504 : 500).json({ok:false,error:timeout?`Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS/1000} segundos.`:'Error de conexión con Google Apps Script: '+(err?.message||err)});
  }
});

app.get('/api/drive/get', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const envUrl=(process.env.GOOGLE_APPS_SCRIPT_URL||'').trim();
    const envToken=(process.env.GOOGLE_APPS_SCRIPT_TOKEN||'').trim();
    const targetUrl=(envUrl||req.query?.url||'').trim();
    const token=envToken||req.query?.token||'';
    const action=req.query?.action||'getAll';
    if(!targetUrl) return res.status(400).json({ok:false,error:'URL de Google Apps Script no configurada en el servidor o en la app.'});
    const cleanBase=targetUrl.replace(/\?.*$/,'');
    const urlWithParams=`${cleanBase}?action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}&_=${Date.now()}`;
    const response=await fetchWithTimeout(urlWithParams,{method:'GET',headers:{Accept:'application/json'},redirect:'follow'});
    const text=await response.text();
    let data; try { data=JSON.parse(text); } catch { return res.status(502).json({ok:false,error:'Respuesta no válida de Google Apps Script: '+text.slice(0,200)}); }
    return res.status(response.ok ? 200 : 502).json(data);
  } catch(err) {
    const timeout = err?.name === 'AbortError';
    console.error('Error in /api/drive/get proxy:', err);
    return res.status(timeout ? 504 : 500).json({ok:false,error:timeout?`Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS/1000} segundos.`:'Error al consultar Google Apps Script: '+(err?.message||err)});
  }
});

app.get('*', async (req,res)=>{
  if (/\.[a-z0-9]+$/i.test(req.path)) return res.status(404).type('text/plain').send('Recurso no encontrado: '+req.path);
  try {
    const html=await fs.readFile(path.join(__dirname,'index.html'),'utf8');
    res.setHeader('Cache-Control','no-store, max-age=0');
    return res.type('html').send(html);
  } catch(err) {
    console.error('Error serving index.html:',err);
    return res.status(500).type('text/plain').send('No se pudo cargar la aplicación.');
  }
});

app.listen(PORT,'0.0.0.0',()=>console.log(`Server running on http://0.0.0.0:${PORT}`));
