import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const AUTH_COOKIE_NAME = 'bm_auth_token';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const DRIVE_TIMEOUT_MS = 25000;

const TMP_CONFIG_FILE = '/tmp/server-config.json';
const TMP_USERS_FILE = '/tmp/users.json';
const BUNDLED_CONFIG_FILE = path.join(process.cwd(), 'data', 'server-config.json');

export function corsHeaders(res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

export function cleanConfigUrl(u) {
  const s = String(u || '').trim();
  if (!s || /TU_SCRIPT_ID/i.test(s)) return '';
  return s;
}

export function cleanConfigToken(t) {
  const s = String(t || '').trim();
  if (!s || /^TU_CLAVE_SECRETA_AQUI$/i.test(s)) return '';
  return s;
}

export function getSavedConfig() {
  let tmpCfg = {};
  let bundledCfg = {};
  if (fs.existsSync(TMP_CONFIG_FILE)) {
    try { tmpCfg = JSON.parse(fs.readFileSync(TMP_CONFIG_FILE, 'utf8')) || {}; } catch (_) {}
  }
  if (fs.existsSync(BUNDLED_CONFIG_FILE)) {
    try { bundledCfg = JSON.parse(fs.readFileSync(BUNDLED_CONFIG_FILE, 'utf8')) || {}; } catch (_) {}
  }
  return {
    scriptUrl: cleanConfigUrl(process.env.GOOGLE_APPS_SCRIPT_URL) || cleanConfigUrl(tmpCfg.scriptUrl) || cleanConfigUrl(bundledCfg.scriptUrl),
    scriptToken: cleanConfigToken(process.env.GOOGLE_APPS_SCRIPT_TOKEN) || cleanConfigToken(tmpCfg.scriptToken) || cleanConfigToken(bundledCfg.scriptToken)
  };
}

export function saveConfig(url, token) {
  const cur = getSavedConfig();
  const nextUrl = cleanConfigUrl(url) || cur.scriptUrl || '';
  const nextToken = cleanConfigToken(token) || cur.scriptToken || '';
  const data = {
    scriptUrl: nextUrl,
    scriptToken: nextToken,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(TMP_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
  return data;
}

function getSigningSecret() {
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.trim().length >= 16) {
    return process.env.AUTH_SECRET.trim();
  }
  const cfg = getSavedConfig();
  const seed = `${cfg.scriptToken || 'bm-token'}::${cfg.scriptUrl || 'bm-url'}::buscador-materiales-sap-hmac-v1`;
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
}

export function hashSecretServer(secret, salt) {
  return crypto.createHash('sha256').update(`${String(salt || '')}::${String(secret || '')}`, 'utf8').digest('hex');
}

export function makeSalt() {
  return crypto.randomBytes(12).toString('hex');
}

export function safeEqualHex(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || sa.length !== sb.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sa, 'utf8'), Buffer.from(sb, 'utf8'));
  } catch (_) {
    return false;
  }
}

export function verifyPasswordServer(user, plainPass) {
  if (!user || !plainPass) return false;
  const pass = String(plainPass);
  if (user.passwordHash) {
    const computed = hashSecretServer(pass, user.passwordSalt || '');
    if (safeEqualHex(computed, user.passwordHash)) return true;
  }
  if (user.provisionalHash) {
    const computedProv = hashSecretServer(pass, user.provisionalSalt || '');
    if (safeEqualHex(computedProv, user.provisionalHash)) return true;
  }
  return false;
}

export function sanitizeUser(u) {
  if (!u || typeof u !== 'object') return null;
  const copy = { ...u };
  copy.hasPassword = Boolean(u.passwordHash);
  delete copy.passwordHash;
  delete copy.passwordSalt;
  delete copy.provisionalHash;
  delete copy.provisionalSalt;
  return copy;
}

export function sanitizeUsersList(list) {
  return (Array.isArray(list) ? list : []).map(sanitizeUser).filter(Boolean);
}

export function signSessionToken(user) {
  const now = Date.now();
  const payload = {
    id: String(user.id || ''),
    username: String(user.username || '').trim().toUpperCase(),
    role: user.role === 'admin' ? 'admin' : 'user',
    iat: now,
    exp: now + SESSION_TTL_MS
  };
  const bodyB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSigningSecret()).update(bodyB64).digest('base64url');
  return `${bodyB64}.${sig}`;
}

export function verifySessionToken(token) {
  const raw = String(token || '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const bodyB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', getSigningSecret()).update(bodyB64).digest('base64url');
  if (!safeEqualHex(sig, expectedSig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    if (!payload || !payload.username || !payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const header = String(req.headers?.cookie || '');
  if (!header) return out;
  header.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
    }
  });
  return out;
}

export function extractTokenFromReq(req) {
  const auth = String(req.headers?.authorization || '').trim();
  if (/^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const cookies = parseCookies(req);
  return cookies[AUTH_COOKIE_NAME] || '';
}

export function setAuthCookie(res, req, token) {
  const proto = String(req.headers?.['x-forwarded-proto'] || '');
  const isHttps = proto.includes('https') || Boolean(req.connection?.encrypted);
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    isHttps ? 'SameSite=None' : 'SameSite=Lax'
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearAuthCookie(res, req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || '');
  const isHttps = proto.includes('https') || Boolean(req.connection?.encrypted);
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    isHttps ? 'SameSite=None' : 'SameSite=Lax'
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) || {}; } catch (_) { return {}; }
  }
  return req.body;
}

export function getDeviceLabel(req) {
  const ua = String(req.headers?.['user-agent'] || '');
  const plat = /Android/i.test(ua) ? 'Android' : (/iPhone|iPad/i.test(ua) ? 'iOS' : (/Windows/i.test(ua) ? 'Windows' : (/Mac/i.test(ua) ? 'Mac' : 'Web')));
  const br = /Edg\//i.test(ua) ? 'Edge' : (/Chrome\//i.test(ua) ? 'Chrome' : (/Firefox\//i.test(ua) ? 'Firefox' : (/Safari\//i.test(ua) ? 'Safari' : 'Browser')));
  return `${br} / ${plat}`;
}

export function getClientIp(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket?.remoteAddress || 'local';
}

const loginFailureMap = globalThis.__bmLoginFailureMap || (globalThis.__bmLoginFailureMap = new Map());
const MAX_FAILED_ATTEMPTS = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 60 * 1000;

export function getRateLimitStatus(ip, identifier) {
  const key = `${ip}::${String(identifier || '').trim().toUpperCase()}`;
  const rec = loginFailureMap.get(key);
  if (!rec) return { blocked: false, key };
  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { blocked: true, key, remainingSec: Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000)) };
  }
  if (now - rec.firstAttemptAt > FAILURE_WINDOW_MS) {
    loginFailureMap.delete(key);
    return { blocked: false, key };
  }
  return { blocked: false, key, rec };
}

export function recordLoginFailure(key) {
  const now = Date.now();
  const prev = loginFailureMap.get(key);
  if (!prev || now - prev.firstAttemptAt > FAILURE_WINDOW_MS) {
    loginFailureMap.set(key, { count: 1, firstAttemptAt: now, lockedUntil: 0 });
    return;
  }
  prev.count += 1;
  if (prev.count >= MAX_FAILED_ATTEMPTS) {
    prev.lockedUntil = now + LOCKOUT_MS;
    prev.count = 0;
  }
  loginFailureMap.set(key, prev);
}

export function clearLoginFailures(key) {
  loginFailureMap.delete(key);
}

export const MASTER_ADMIN_ID = 'usr-admin-root';
export const MASTER_ADMIN_EMAIL = 'tualiadoenusaforms@gmail.com';
export const MASTER_ADMIN_USERNAME = 'JHUGO';

export function isProtectedMasterAdmin(user) {
  if (!user || typeof user !== 'object') return false;
  const id = String(user.id || '').trim();
  const email = String(user.email || '').trim().toLowerCase();
  const uname = String(user.username || '').trim().toUpperCase();
  return Boolean(
    user.isMasterAdmin === true ||
    id === MASTER_ADMIN_ID ||
    email === MASTER_ADMIN_EMAIL ||
    uname === MASTER_ADMIN_USERNAME
  );
}

export function normalizeMasterAdminFields(u) {
  if (!isProtectedMasterAdmin(u)) return u;
  const next = { ...u };
  if (next.id === MASTER_ADMIN_ID || String(next.email || '').trim().toLowerCase() === MASTER_ADMIN_EMAIL) {
    if (!next.username || String(next.username).trim().toUpperCase() === 'ADMIN') {
      next.username = MASTER_ADMIN_USERNAME;
    }
    if (!next.email) {
      next.email = MASTER_ADMIN_EMAIL;
    }
  }
  next.isMasterAdmin = true;
  next.role = 'admin';
  next.active = true;
  return next;
}

export function mergeUsersLists(existingUsers = [], incomingUsers = [], deletedIds = []) {
  const deletedSet = new Set(
    (Array.isArray(deletedIds) ? deletedIds : [])
      .map(String)
      .filter(id => id && id !== MASTER_ADMIN_ID)
  );
  const byId = new Map();
  const byUsername = new Map();

  const pickCredsSource = (prev, u) => {
    if (!prev) return u;
    const prevSeed = Boolean(prev.isDefaultSeed);
    const nextSeed = Boolean(u.isDefaultSeed);
    if (!prevSeed && nextSeed) return prev;
    if (prevSeed && !nextSeed) return u;
    const prevCredTs = String(prev.passwordUpdatedAt || prev.updatedAt || '');
    const nextCredTs = String(u.passwordUpdatedAt || u.updatedAt || '');
    if (nextCredTs >= prevCredTs && (u.passwordHash || !prev.passwordHash)) return u;
    if (!prev.passwordHash && u.passwordHash) return u;
    return prev;
  };

  const applyUser = (u) => {
    if (!u || !u.username) return;
    let uname = String(u.username).trim().toUpperCase();
    const id = String(u.id || ('usr-' + uname));
    if (id === MASTER_ADMIN_ID || String(u.email || '').trim().toLowerCase() === MASTER_ADMIN_EMAIL) {
      if (uname === 'ADMIN') uname = MASTER_ADMIN_USERNAME;
    }
    if (deletedSet.has(id) && !isProtectedMasterAdmin(u)) return;
    const prev = byId.get(id) || byUsername.get(uname);
    if (!prev) {
      const clean = normalizeMasterAdminFields({
        ...u,
        id,
        username: uname,
        email: String(u.email || '').trim().toLowerCase(),
        passwordHash: u.passwordHash || '',
        passwordSalt: u.passwordSalt || ''
      });
      byId.set(id, clean);
      byUsername.set(clean.username, clean);
      return;
    }

    const useNextProfile = String(u.updatedAt || '') >= String(prev.updatedAt || '');
    const profileSrc = useNextProfile ? u : prev;
    const credsSrc = pickCredsSource(prev, u);
    const lastLoginA = String(prev.lastLoginAt || '');
    const lastLoginB = String(u.lastLoginAt || '');

    const merged = normalizeMasterAdminFields({
      ...prev,
      ...profileSrc,
      id,
      username: useNextProfile ? uname : prev.username,
      email: String(profileSrc.email !== undefined ? profileSrc.email : (prev.email || '')).trim().toLowerCase(),
      passwordHash: credsSrc.passwordHash || prev.passwordHash || u.passwordHash || '',
      passwordSalt: credsSrc.passwordSalt || prev.passwordSalt || u.passwordSalt || '',
      provisionalHash: credsSrc.provisionalHash || '',
      provisionalSalt: credsSrc.provisionalSalt || '',
      passwordUpdatedAt: credsSrc.passwordUpdatedAt || prev.passwordUpdatedAt || u.passwordUpdatedAt || '',
      isDefaultSeed: Boolean(credsSrc.isDefaultSeed),
      mustChangePassword: Boolean(credsSrc.mustChangePassword),
      isMasterAdmin: Boolean(prev.isMasterAdmin || profileSrc.isMasterAdmin || isProtectedMasterAdmin(prev) || isProtectedMasterAdmin(profileSrc)),
      lastLoginAt: lastLoginB > lastLoginA ? lastLoginB : lastLoginA
    });
    if (prev.id !== id) byId.delete(prev.id);
    if (prev.username && prev.username !== merged.username) byUsername.delete(prev.username);
    byId.set(id, merged);
    byUsername.set(merged.username, merged);
  };

  (Array.isArray(existingUsers) ? existingUsers : []).forEach(applyUser);
  (Array.isArray(incomingUsers) ? incomingUsers : []).forEach(applyUser);
  return Array.from(byId.values()).filter(u => isProtectedMasterAdmin(u) || !deletedSet.has(String(u.id)));
}

export function mergeAuthLogs(existingLogs = [], incomingLogs = []) {
  const byId = new Map();
  [...(Array.isArray(existingLogs) ? existingLogs : []), ...(Array.isArray(incomingLogs) ? incomingLogs : [])]
    .forEach(log => {
      if (!log) return;
      const id = String(log.id || `${log.timestamp || ''}_${log.event || ''}_${log.username || ''}`);
      if (!byId.has(id)) byId.set(id, { ...log, id });
    });
  return Array.from(byId.values())
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, 500);
}

export function normalizeAuthSettings(rawAuth = {}, currentAuth = {}) {
  const merged = { ...currentAuth, ...rawAuth };
  const mins = Number(merged.sessionTimeoutMinutes);
  return {
    ...merged,
    requireLogin: true,
    allowGuest: false,
    sessionTimeoutMinutes: Number.isFinite(mins) && mins >= 0 ? Math.min(480, mins) : 30
  };
}

export function readTmpUsers() {
  if (fs.existsSync(TMP_USERS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(TMP_USERS_FILE, 'utf8'));
      const rawUsers = Array.isArray(parsed?.userAccounts) ? parsed.userAccounts.map(normalizeMasterAdminFields) : [];
      const protectedIds = new Set(rawUsers.filter(isProtectedMasterAdmin).map(u => String(u.id)));
      protectedIds.add(MASTER_ADMIN_ID);
      const rawDeleted = (Array.isArray(parsed?.deletedUserIds) ? parsed.deletedUserIds : []).filter(id => !protectedIds.has(String(id)));
      return {
        userAccounts: rawUsers,
        deletedUserIds: rawDeleted,
        authSettings: normalizeAuthSettings(parsed?.authSettings || {}),
        authLogs: Array.isArray(parsed?.authLogs) ? parsed.authLogs : [],
        updatedAt: parsed?.updatedAt || ''
      };
    } catch (_) {}
  }
  return {
    userAccounts: [],
    deletedUserIds: [],
    authSettings: { requireLogin: true, allowGuest: false, sessionTimeoutMinutes: 30 },
    authLogs: [],
    updatedAt: ''
  };
}

export function writeTmpUsers(payload) {
  const current = readTmpUsers();
  const protectedIds = new Set(
    [...(current.userAccounts || []), ...(Array.isArray(payload?.userAccounts) ? payload.userAccounts : [])]
      .filter(isProtectedMasterAdmin)
      .map(u => String(u.id))
  );
  protectedIds.add(MASTER_ADMIN_ID);
  const incomingDeleted = Array.isArray(payload?.deletedUserIds) ? payload.deletedUserIds : [];
  const deletedUserIds = Array.from(new Set([...(current.deletedUserIds || []), ...incomingDeleted].map(String)))
    .filter(id => !protectedIds.has(id))
    .slice(-200);
  const incomingUsers = Array.isArray(payload?.userAccounts) ? payload.userAccounts : [];
  let userAccounts = payload?.replaceAll
    ? incomingUsers.map(normalizeMasterAdminFields).filter(u => u && (isProtectedMasterAdmin(u) || !deletedUserIds.includes(String(u.id))))
    : mergeUsersLists(current.userAccounts, incomingUsers, deletedUserIds);
  const currentMaster = (current.userAccounts || []).find(isProtectedMasterAdmin);
  if (currentMaster && !userAccounts.some(isProtectedMasterAdmin)) {
    userAccounts.unshift(normalizeMasterAdminFields(currentMaster));
  }
  const authLogs = mergeAuthLogs(current.authLogs, payload?.authLogs);
  const authSettings = normalizeAuthSettings(payload?.authSettings || {}, current.authSettings);
  const data = {
    userAccounts,
    deletedUserIds,
    authSettings,
    authLogs,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(TMP_USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
  return data;
}

export function appendServerAuditLog(dataObj, event, userOrName, detail = '', actor = '', req = null) {
  const isObj = userOrName && typeof userOrName === 'object';
  const username = String(isObj ? userOrName.username : (userOrName || '')).trim().toUpperCase();
  const fullName = String(isObj ? (userOrName.fullName || username) : '').trim();
  const role = String(isObj ? (userOrName.role || 'user') : '').trim();
  const entry = {
    id: 'log-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toISOString(),
    event: String(event || 'EVENTO'),
    username,
    fullName,
    role,
    detail: String(detail || ''),
    actor: String(actor || username || 'SISTEMA').toUpperCase(),
    device: req ? getDeviceLabel(req) : 'Servidor'
  };
  dataObj.authLogs = [entry, ...(Array.isArray(dataObj.authLogs) ? dataObj.authLogs : [])].slice(0, 500);
  return entry;
}

export function ensureDefaultAdminInStore() {
  const store = readTmpUsers();
  const hasActiveAdmin = (store.userAccounts || []).some(u => u && u.active !== false && u.role === 'admin');
  if (hasActiveAdmin) return store;
  const salt = makeSalt();
  const hash = hashSecretServer('1234', salt);
  const now = new Date().toISOString();
  const rootAdmin = {
    id: MASTER_ADMIN_ID,
    username: MASTER_ADMIN_USERNAME,
    email: MASTER_ADMIN_EMAIL,
    fullName: 'Administrador Principal',
    role: 'admin',
    active: true,
    isMasterAdmin: true,
    mustChangePassword: true,
    isDefaultSeed: true,
    defaultCenter: '',
    defaultSupervisor: '',
    passwordSalt: salt,
    passwordHash: hash,
    createdBy: 'SISTEMA',
    createdAt: now,
    updatedAt: now,
    lastLoginAt: ''
  };
  const nextLogs = [...(store.authLogs || [])];
  nextLogs.unshift({
    id: 'log-seed-' + Date.now(),
    timestamp: now,
    event: 'CREAR_USUARIO',
    username: MASTER_ADMIN_USERNAME,
    fullName: 'Administrador Principal',
    role: 'admin',
    detail: 'Cuenta maestra inicial generada automáticamente (requiere cambio de clave al ingresar)',
    actor: 'SISTEMA',
    device: 'Servidor'
  });
  return writeTmpUsers({
    replaceAll: true,
    userAccounts: [rootAdmin, ...(store.userAccounts || []).filter(u => u.id !== MASTER_ADMIN_ID && u.username !== 'ADMIN' && u.username !== MASTER_ADMIN_USERNAME)],
    deletedUserIds: store.deletedUserIds.filter(id => id !== MASTER_ADMIN_ID),
    authSettings: store.authSettings,
    authLogs: nextLogs
  });
}

export function fetchWithTimeout(url, options = {}, timeoutMs = DRIVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function hydrateUsersFromDrive(force = true) {
  const cur = readTmpUsers();
  if (!force && cur.userAccounts && cur.userAccounts.length > 0) return cur;
  const cfg = getSavedConfig();
  if (!cfg.scriptUrl) {
    return ensureDefaultAdminInStore();
  }
  const cleanBase = cfg.scriptUrl.replace(/\?.*$/, '');
  for (const action of ['getUsersAndAuth', 'getAll']) {
    try {
      const url = `${cleanBase}?action=${encodeURIComponent(action)}&token=${encodeURIComponent(cfg.scriptToken || '')}&_=${Date.now()}`;
      const r = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'follow' }, 10000);
      const text = await r.text();
      const json = JSON.parse(text);
      if (json && json.ok) {
        const src = action === 'getAll' ? (json.data?.app || {}) : json;
        if (Array.isArray(src.userAccounts) || Array.isArray(src.authLogs)) {
          writeTmpUsers({
            userAccounts: src.userAccounts || [],
            deletedUserIds: src.deletedUserIds || [],
            authSettings: src.authSettings || {},
            authLogs: src.authLogs || []
          });
          return ensureDefaultAdminInStore();
        }
      }
    } catch (_) {}
  }
  return ensureDefaultAdminInStore();
}

export async function syncUsersToDriveServer() {
  const cfg = getSavedConfig();
  if (!cfg.scriptUrl) return false;
  const store = readTmpUsers();
  const payload = {
    action: 'syncUsersAndAuth',
    token: cfg.scriptToken || '',
    userAccounts: store.userAccounts,
    deletedUserIds: store.deletedUserIds,
    authSettings: store.authSettings,
    authLogs: store.authLogs
  };
  try {
    const response = await fetchWithTimeout(cfg.scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }, 15000);
    const json = JSON.parse(await response.text());
    if (json && json.ok) {
      writeTmpUsers({
        userAccounts: json.userAccounts || [],
        deletedUserIds: json.deletedUserIds || [],
        authSettings: json.authSettings || {},
        authLogs: json.authLogs || []
      });
      return true;
    }
  } catch (_) {}
  return false;
}

export async function resolveAuthUser(req) {
  const token = extractTokenFromReq(req);
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const store = await hydrateUsersFromDrive(true);
  const matched = (store.userAccounts || []).find(
    u => u && u.active !== false && (u.id === payload.id || String(u.username || '').toUpperCase() === payload.username)
  );
  return matched || null;
}
