const IMAGE_TIMEOUT_MS = 15000;

function fetchWithTimeout(url, options = {}, timeoutMs = IMAGE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchDriveThumbnail(fileId) {
  const url = `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1200`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
    redirect: 'follow'
  });
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!response.ok || !contentType.startsWith('image/')) {
    throw new Error(`Drive thumbnail no disponible (${response.status}, ${contentType || 'sin content-type'})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, mime: contentType.split(';')[0] || 'image/jpeg' };
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

  // Primera opción: Apps Script entrega el archivo usando la cuenta autorizada.
  if (targetUrl && token) {
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
      try { data = JSON.parse(text); } catch (_) { data = null; }

      if (response.ok && data?.ok && data?.data?.base64) {
        const mime = String(data.data.mime || 'image/jpeg').toLowerCase();
        if (mime.startsWith('image/')) {
          const bytes = Buffer.from(data.data.base64, 'base64');
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Length', String(bytes.length));
          res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
          return res.status(200).send(bytes);
        }
      }
    } catch (err) {
      console.warn('Apps Script getImage falló; se intentará thumbnail público de Drive:', err?.message || err);
    }
  }

  // Segunda opción: las imágenes guardadas por Code.gs se comparten como
  // ANYONE_WITH_LINK y usan thumbnail de Drive. Esto evita depender de que
  // el deployment de Apps Script tenga todavía la acción getImage publicada.
  try {
    const { bytes, mime } = await fetchDriveThumbnail(fileId);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).send(bytes);
  } catch (err) {
    console.error('Error recuperando imagen de Drive:', err);
    return res.status(502).json({
      ok: false,
      error: 'No se pudo recuperar la imagen de Drive. Verifica que el archivo tenga acceso "Cualquier persona con el enlace".'
    });
  }
}
