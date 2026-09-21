import fs from 'fs';

const DRIVE_TIMEOUT_MS = 12000;
const TMP_CONFIG_FILE = '/tmp/server-config.json';

function fetchWithTimeout(url, options = {}, timeoutMs = DRIVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function getTmpConfig() {
  let cfg = {};
  if (fs.existsSync(TMP_CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(TMP_CONFIG_FILE, 'utf8')) || {}; } catch (_) {}
  }
  return {
    url: (process.env.GOOGLE_APPS_SCRIPT_URL || cfg.scriptUrl || '').trim(),
    token: (process.env.GOOGLE_APPS_SCRIPT_TOKEN || cfg.scriptToken || '').trim()
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const tmpCfg = getTmpConfig();
    const reqUrl = (req.query?.url || '').trim();
    const targetUrl = (tmpCfg.url || reqUrl).trim();
    const token = tmpCfg.token || req.query?.token || '';
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
    return res.status(200).json(data);
  } catch (err) {
    console.error('Error in /api/drive/get serverless function:', err);
    return res.status(err?.name==='AbortError'?504:500).json({ ok: false, error: err?.name==='AbortError' ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS/1000} segundos.` : 'Error al consultar Google Apps Script: ' + (err?.message || err) });
  }
}
