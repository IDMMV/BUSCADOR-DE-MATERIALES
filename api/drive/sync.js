const DRIVE_TIMEOUT_MS = 12000;
function fetchWithTimeout(url, options = {}, timeoutMs = DRIVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) {}
    }

    const envUrl = (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
    const envToken = (process.env.GOOGLE_APPS_SCRIPT_TOKEN || '').trim();

    const targetUrl = (envUrl || body?.targetUrl || body?.url || '').trim();
    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en Vercel o en la app.' });
    }

    const payload = body?.payload ? { ...body.payload } : { ...body };
    delete payload.targetUrl;
    delete payload.url;

    // Priorizar el token configurado en Vercel/servidor para que cualquier equipo se conecte sin ingresar clave
    if (envToken) {
      payload.token = envToken;
    } else if (!payload.token && body?.token) {
      payload.token = body.token;
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
    return res.status(200).json(data);
  } catch (err) {
    console.error('Error in /api/drive/sync serverless function:', err);
    return res.status(err?.name==='AbortError'?504:500).json({ ok: false, error: err?.name==='AbortError' ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS/1000} segundos.` : 'Error de conexión con Google Apps Script: ' + (err?.message || err) });
  }
}
