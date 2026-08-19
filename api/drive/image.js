const IMAGE_TIMEOUT_MS = 15000;

function fetchWithTimeout(url, options = {}, timeoutMs = IMAGE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Método no permitido.' });

  const fileId = String(req.query?.fileId || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) {
    return res.status(400).json({ ok: false, error: 'fileId inválido.' });
  }

  const targetUrl = (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
  const token = (process.env.GOOGLE_APPS_SCRIPT_TOKEN || '').trim();
  if (!targetUrl || !token) {
    return res.status(500).json({ ok: false, error: 'Faltan GOOGLE_APPS_SCRIPT_URL o GOOGLE_APPS_SCRIPT_TOKEN en Vercel.' });
  }

  try {
    const cleanBase = targetUrl.replace(/\?.*$/, '');
    const url = `${cleanBase}?action=getImage&token=${encodeURIComponent(token)}&fileId=${encodeURIComponent(fileId)}&_=${Date.now()}`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      redirect: 'follow'
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { return res.status(502).json({ ok: false, error: 'Google Apps Script devolvió una respuesta no válida.' }); }

    if (!response.ok || !data?.ok || !data?.data?.base64) {
      return res.status(response.ok ? 404 : response.status).json({ ok: false, error: data?.error || 'No se pudo recuperar la imagen de Drive.' });
    }

    const mime = String(data.data.mime || 'image/jpeg').toLowerCase();
    if (!mime.startsWith('image/')) {
      return res.status(415).json({ ok: false, error: 'El archivo de Drive no es una imagen.' });
    }

    const bytes = Buffer.from(data.data.base64, 'base64');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).send(bytes);
  } catch (err) {
    console.error('Error in /api/drive/image:', err);
    return res.status(err?.name === 'AbortError' ? 504 : 500).json({ ok: false, error: err?.name === 'AbortError' ? 'Google Apps Script tardó demasiado en entregar la imagen.' : 'Error al recuperar imagen: ' + (err?.message || err) });
  }
}
