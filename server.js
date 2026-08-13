import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

app.get('/api/config', (req, res) => {
  res.json({
    scriptUrl: process.env.GOOGLE_APPS_SCRIPT_URL || '',
    scriptToken: process.env.GOOGLE_APPS_SCRIPT_TOKEN || ''
  });
});

app.post('/api/drive/sync', async (req, res) => {
  try {
    const targetUrl = (req.body?.targetUrl || req.body?.url || process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada.' });
    }
    const payload = req.body?.payload || req.body;
    // Remove proxy wrapper keys if present
    delete payload.targetUrl;
    delete payload.url;

    const response = await fetch(targetUrl, {
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
    return res.status(500).json({ ok: false, error: 'Error de conexión con Google Apps Script: ' + (err?.message || err) });
  }
});

app.get('/api/drive/get', async (req, res) => {
  try {
    const targetUrl = (req.query?.url || process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
    const token = req.query?.token || process.env.GOOGLE_APPS_SCRIPT_TOKEN || '';
    const action = req.query?.action || 'getAll';

    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada.' });
    }

    const cleanBase = targetUrl.replace(/\?.*$/, '');
    const urlWithParams = `${cleanBase}?action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}&_=${Date.now()}`;

    const response = await fetch(urlWithParams, {
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
    return res.status(500).json({ ok: false, error: 'Error al consultar Google Apps Script: ' + (err?.message || err) });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

