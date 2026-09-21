import fs from 'fs';
import path from 'path';

const TMP_CONFIG_FILE = '/tmp/server-config.json';

function getMemoryConfig() {
  let fileCfg = {};
  if (fs.existsSync(TMP_CONFIG_FILE)) {
    try { fileCfg = JSON.parse(fs.readFileSync(TMP_CONFIG_FILE, 'utf8')) || {}; } catch (_) {}
  }
  return {
    scriptUrl: (process.env.GOOGLE_APPS_SCRIPT_URL || fileCfg.scriptUrl || '').trim(),
    scriptToken: (process.env.GOOGLE_APPS_SCRIPT_TOKEN || fileCfg.scriptToken || '').trim()
  };
}

function saveMemoryConfig(url, token) {
  const cur = getMemoryConfig();
  const nextUrl = (url || cur.scriptUrl || '').trim();
  const nextToken = (token || cur.scriptToken || '').trim();
  const data = {
    scriptUrl: nextUrl,
    scriptToken: nextToken,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(TMP_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not save tmp config:', e.message);
  }
  return data;
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) {}
    }
    const url = (body?.scriptUrl || body?.url || '').trim();
    const token = (body?.scriptToken || body?.token || '').trim();
    const saved = saveMemoryConfig(url, token);
    return res.status(200).json({ ok: true, config: saved });
  }

  const cfg = getMemoryConfig();
  return res.status(200).json({
    scriptUrl: cfg.scriptUrl,
    scriptToken: cfg.scriptToken
  });
}
