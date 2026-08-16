import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const DRIVE_TIMEOUT_MS = 12000;
const CONFIG_TIMEOUT_MS = 5000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname, {
  index: false,
  fallthrough: true,
  extensions: false,
  setHeaders: (res, filePath) => {
    const lower = filePath.toLowerCase();
    if (/\.(js|mjs|css|json|webmanifest|png|jpe?g|gif|svg|ico|webp|xlsx|txt|map)$/.test(lower)) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  }
}));

function fetchWithTimeout(url, options = {}, timeoutMs = DRIVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

const BOOT_DRIVE_GUARD = String.raw`<script>
(() => {
  'use strict';
  const originalFetch = window.fetch.bind(window);
  let unlocked = false;

  const unlock = () => { unlocked = true; window.__BM_DRIVE_UNLOCKED__ = true; };
  ['pointerdown','touchstart','keydown','input','change','submit'].forEach(type => {
    document.addEventListener(type, unlock, { capture: true, passive: true });
  });

  const withTimeout = (promise, ms, label) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timeout after ' + ms + 'ms')), ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  };

  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isConfig = /\/api\/config(?:[?#]|$)/i.test(url);
    const isDrive = /\/api\/drive\/(?:get|sync)(?:[?#]|$)/i.test(url);

    if (isDrive && !unlocked && !window.__BM_DRIVE_UNLOCKED__) {
      console.warn('[BM] Bloqueada una sincronización automática de Drive durante el arranque. Se habilitará tras la primera interacción.');
      return Promise.reject(new Error('Drive bloqueado durante el arranque automático'));
    }

    const request = originalFetch(input, init);
    return withTimeout(request, isConfig ? ${CONFIG_TIMEOUT_MS} : (isDrive ? ${DRIVE_TIMEOUT_MS} : 15000), isConfig ? 'Config' : (isDrive ? 'Drive' : 'Request'));
  };

  window.__BM_BOOT_GUARD__ = true;
})();
</script>`;

app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.json({
    scriptUrl: process.env.GOOGLE_APPS_SCRIPT_URL || '',
    scriptToken: process.env.GOOGLE_APPS_SCRIPT_TOKEN || ''
  });
});

app.post('/api/drive/sync', async (req, res) => {
  try {
    const envUrl = (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
    const envToken = (process.env.GOOGLE_APPS_SCRIPT_TOKEN || '').trim();

    const targetUrl = (envUrl || req.body?.targetUrl || req.body?.url || '').trim();
    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en el servidor o en la app.' });
    }

    const payload = req.body?.payload ? { ...req.body.payload } : { ...req.body };
    delete payload.targetUrl;
    delete payload.url;

    if (envToken) {
      payload.token = envToken;
    } else if (!payload.token && req.body?.token) {
      payload.token = req.body.token;
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
    const timeout = err?.name === 'AbortError';
    console.error('Error in /api/drive/sync proxy:', err);
    return res.status(timeout ? 504 : 500).json({
      ok: false,
      error: timeout
        ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS / 1000} segundos.`
        : 'Error de conexión con Google Apps Script: ' + (err?.message || err)
    });
  }
});

app.get('/api/drive/get', async (req, res) => {
  try {
    const envUrl = (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
    const envToken = (process.env.GOOGLE_APPS_SCRIPT_TOKEN || '').trim();

    const targetUrl = (envUrl || req.query?.url || '').trim();
    const token = envToken || req.query?.token || '';
    const action = req.query?.action || 'getAll';

    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en el servidor o en la app.' });
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
    const timeout = err?.name === 'AbortError';
    console.error('Error in /api/drive/get proxy:', err);
    return res.status(timeout ? 504 : 500).json({
      ok: false,
      error: timeout
        ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS / 1000} segundos.`
        : 'Error al consultar Google Apps Script: ' + (err?.message || err)
    });
  }
});

app.get('*', async (req, res) => {
  if (/\.[a-z0-9]+$/i.test(req.path)) {
    return res.status(404).type('text/plain').send('Recurso no encontrado: ' + req.path);
  }

  try {
    const file = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
    let injected = file;
    if (!injected.includes('window.__BM_BOOT_GUARD__')) {
      injected = injected.replace(/<head>/i, `<head>${BOOT_DRIVE_GUARD}`);
    }
    if (!injected.includes('/client-stability.js')) {
      injected = injected.replace('</body>', '<script src="/client-stability.js" defer></script></body>');
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.type('html').send(injected);
  } catch (err) {
    console.error('Error serving index.html:', err);
    return res.status(500).type('text/plain').send('No se pudo cargar la aplicación.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
