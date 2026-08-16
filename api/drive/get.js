export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const envUrl = (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
    const envToken = (process.env.GOOGLE_APPS_SCRIPT_TOKEN || '').trim();

    const targetUrl = (envUrl || req.query?.url || '').trim();
    const token = envToken || req.query?.token || '';
    const action = req.query?.action || 'getAll';

    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en Vercel o en la app.' });
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
    return res.status(200).json(data);
  } catch (err) {
    console.error('Error in /api/drive/get serverless function:', err);
    return res.status(500).json({ ok: false, error: 'Error al consultar Google Apps Script: ' + (err?.message || err) });
  }
}

