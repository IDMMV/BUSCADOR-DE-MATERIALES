import { corsHeaders, getSavedConfig, saveConfig, parseBody } from './_auth-lib.js';

export default function handler(req, res) {
  corsHeaders(res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const url = (body?.scriptUrl || body?.url || '').trim();
    const token = (body?.scriptToken || body?.token || '').trim();
    const saved = saveConfig(url, token);
    return res.status(200).json({ ok: true, config: saved });
  }

  const cfg = getSavedConfig();
  return res.status(200).json({
    scriptUrl: cfg.scriptUrl,
    scriptToken: cfg.scriptToken
  });
}
