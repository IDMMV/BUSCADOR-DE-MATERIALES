export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ configured: false, error: 'Método no permitido' });

  const scriptUrl = (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
  const scriptToken = (process.env.GOOGLE_APPS_SCRIPT_TOKEN || '').trim();

  // Las credenciales se quedan en Vercel. El navegador solo necesita saber si el proxy está listo.
  return res.status(200).json({ configured: Boolean(scriptUrl && scriptToken), proxyOnly: true });
}
