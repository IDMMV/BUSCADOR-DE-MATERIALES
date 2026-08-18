const url = process.env.PREVIEW_URL;
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

if (!url) throw new Error('PREVIEW_URL is not configured.');
if (!bypassSecret) throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET is not configured.');

const headers = {
  'x-vercel-protection-bypass': bypassSecret,
  'x-vercel-set-bypass-cookie': 'true',
  'accept': 'application/json'
};

async function getJson(path) {
  const response = await fetch(new URL(path, url), {
    headers,
    redirect: 'follow'
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${path}, received: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

function findArray(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    const found = findArray(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

(async () => {
  console.log(`Opening API health checks for ${url}`);

  const config = await getJson('/api/config');
  if (!config || typeof config !== 'object') {
    throw new Error('API config response is not an object.');
  }
  if (!String(config.scriptUrl || '').trim()) {
    throw new Error('Google Apps Script URL is not configured in the Vercel Preview environment.');
  }
  console.log('Google Apps Script configuration: PASS');

  // Read-only check. This does not create, edit or delete any Drive data.
  const drive = await getJson('/api/drive/get?action=getAll');
  if (!drive || typeof drive !== 'object') {
    throw new Error('Google Drive API returned an invalid response object.');
  }
  if (drive.ok === false || drive.success === false || drive.error) {
    throw new Error(`Google Drive read failed: ${String(drive.error || 'remote service reported failure')}`);
  }

  const rows = findArray(drive);
  if (!rows || rows.length < 1) {
    throw new Error('Google Drive read completed but no material data array was returned.');
  }

  console.log(`Google Drive read: PASS (${rows.length} row/item(s) found)`);
  console.log('Drive persistence smoke check: PASS');
})().catch(error => {
  console.error(`HUGO DRIVE QA: FAIL - ${error.message}`);
  process.exit(1);
});
