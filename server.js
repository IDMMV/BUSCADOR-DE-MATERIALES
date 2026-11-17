import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

const CONFIG_FILE = path.join(__dirname, 'data', 'server-config.json');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const SECRET_FILE = path.join(__dirname, 'data', 'auth-secret.txt');
const AUTH_COOKIE_NAME = 'bm_auth_token';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DRIVE_TIMEOUT_MS = 25000;

function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getSigningSecret() {
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.trim().length >= 16) {
    return process.env.AUTH_SECRET.trim();
  }
  ensureDataDir();
  if (fs.existsSync(SECRET_FILE)) {
    const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (saved.length >= 32) return saved;
  }
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, fresh, { mode: 0o600, encoding: 'utf8' });
  } catch (_) {}
  return fresh;
}

const SIGNING_SECRET = getSigningSecret();

function hashSecretServer(secret, salt) {
  return crypto.createHash('sha256').update(`${String(salt || '')}::${String(secret || '')}`, 'utf8').digest('hex');
}

function makeSalt() {
  return crypto.randomBytes(12).toString('hex');
}

function safeEqualHex(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || sa.length !== sb.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sa, 'utf8'), Buffer.from(sb, 'utf8'));
  } catch (_) {
    return false;
  }
}

function verifyPasswordServer(user, plainPass) {
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

function sanitizeUser(u) {
  if (!u || typeof u !== 'object') return null;
  const copy = { ...u };
  copy.hasPassword = Boolean(u.passwordHash);
  delete copy.passwordHash;
  delete copy.passwordSalt;
  delete copy.provisionalHash;
  delete copy.provisionalSalt;
  return copy;
}

function sanitizeUsersList(list) {
  return (Array.isArray(list) ? list : []).map(sanitizeUser).filter(Boolean);
}

function signSessionToken(user) {
  const now = Date.now();
  const payload = {
    id: String(user.id || ''),
    username: String(user.username || '').trim().toUpperCase(),
    role: user.role === 'admin' ? 'admin' : 'user',
    iat: now,
    exp: now + SESSION_TTL_MS
  };
  const bodyB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(bodyB64).digest('base64url');
  return `${bodyB64}.${sig}`;
}

function verifySessionToken(token) {
  const raw = String(token || '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const bodyB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', SIGNING_SECRET).update(bodyB64).digest('base64url');
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

function extractTokenFromReq(req) {
  const auth = String(req.headers?.authorization || '').trim();
  if (/^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const cookies = parseCookies(req);
  return cookies[AUTH_COOKIE_NAME] || '';
}

function setAuthCookie(res, req, token) {
  const isHttps = Boolean(req.secure || String(req.headers?.['x-forwarded-proto'] || '').includes('https'));
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

function clearAuthCookie(res, req) {
  const isHttps = Boolean(req.secure || String(req.headers?.['x-forwarded-proto'] || '').includes('https'));
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

function getDeviceLabel(req) {
  const ua = String(req.headers?.['user-agent'] || '');
  const plat = /Android/i.test(ua) ? 'Android' : (/iPhone|iPad/i.test(ua) ? 'iOS' : (/Windows/i.test(ua) ? 'Windows' : (/Mac/i.test(ua) ? 'Mac' : 'Web')));
  const br = /Edg\//i.test(ua) ? 'Edge' : (/Chrome\//i.test(ua) ? 'Chrome' : (/Firefox\//i.test(ua) ? 'Firefox' : (/Safari\//i.test(ua) ? 'Safari' : 'Browser')));
  return `${br} / ${plat}`;
}

function getClientIp(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket?.remoteAddress || 'local';
}

// Rate limiter en memoria contra fuerza bruta (máx 5 fallos / 10 min -> bloqueo 60s)
const loginFailureMap = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 60 * 1000;

function getRateLimitStatus(ip, identifier) {
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

function recordLoginFailure(key) {
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

function clearLoginFailures(key) {
  loginFailureMap.delete(key);
}

function mergeUsersLists(existingUsers = [], incomingUsers = [], deletedIds = []) {
  const deletedSet = new Set((Array.isArray(deletedIds) ? deletedIds : []).map(String));
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
    const uname = String(u.username).trim().toUpperCase();
    const id = String(u.id || ('usr-' + uname));
    if (deletedSet.has(id)) return;
    const prev = byId.get(id) || byUsername.get(uname);
    if (!prev) {
      const clean = {
        ...u,
        id,
        username: uname,
        email: String(u.email || '').trim().toLowerCase(),
        passwordHash: u.passwordHash || '',
        passwordSalt: u.passwordSalt || ''
      };
      byId.set(id, clean);
      byUsername.set(uname, clean);
      return;
    }

    const useNextProfile = String(u.updatedAt || '') >= String(prev.updatedAt || '');
    const profileSrc = useNextProfile ? u : prev;
    const credsSrc = pickCredsSource(prev, u);
    const lastLoginA = String(prev.lastLoginAt || '');
    const lastLoginB = String(u.lastLoginAt || '');

    const merged = {
      ...prev,
      ...profileSrc,
      id,
      username: uname,
      email: String(profileSrc.email !== undefined ? profileSrc.email : (prev.email || '')).trim().toLowerCase(),
      passwordHash: credsSrc.passwordHash || prev.passwordHash || u.passwordHash || '',
      passwordSalt: credsSrc.passwordSalt || prev.passwordSalt || u.passwordSalt || '',
      provisionalHash: credsSrc.provisionalHash || '',
      provisionalSalt: credsSrc.provisionalSalt || '',
      passwordUpdatedAt: credsSrc.passwordUpdatedAt || prev.passwordUpdatedAt || u.passwordUpdatedAt || '',
      isDefaultSeed: Boolean(credsSrc.isDefaultSeed),
      mustChangePassword: Boolean(credsSrc.mustChangePassword),
      lastLoginAt: lastLoginB > lastLoginA ? lastLoginB : lastLoginA
    };
    if (prev.id !== id) byId.delete(prev.id);
    byId.set(id, merged);
    byUsername.set(uname, merged);
  };

  (Array.isArray(existingUsers) ? existingUsers : []).forEach(applyUser);
  (Array.isArray(incomingUsers) ? incomingUsers : []).forEach(applyUser);
  return Array.from(byId.values()).filter(u => !deletedSet.has(String(u.id)));
}

function mergeAuthLogs(existingLogs = [], incomingLogs = []) {
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

function normalizeAuthSettings(rawAuth = {}, currentAuth = {}) {
  const merged = { ...currentAuth, ...rawAuth };
  const mins = Number(merged.sessionTimeoutMinutes);
  return {
    ...merged,
    requireLogin: true,
    allowGuest: false,
    sessionTimeoutMinutes: Number.isFinite(mins) && mins >= 0 ? Math.min(480, mins) : 30
  };
}

function readSavedUsers() {
  ensureDataDir();
  if (fs.existsSync(USERS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      const authSettings = normalizeAuthSettings(parsed?.authSettings || {});
      return {
        userAccounts: Array.isArray(parsed?.userAccounts) ? parsed.userAccounts : [],
        deletedUserIds: Array.isArray(parsed?.deletedUserIds) ? parsed.deletedUserIds : [],
        authSettings,
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

function writeSavedUsers(payload) {
  ensureDataDir();
  const current = readSavedUsers();
  const incomingDeleted = Array.isArray(payload?.deletedUserIds) ? payload.deletedUserIds : [];
  const deletedUserIds = Array.from(new Set([...(current.deletedUserIds || []), ...incomingDeleted].map(String))).slice(-200);
  const incomingUsers = Array.isArray(payload?.userAccounts) ? payload.userAccounts : [];
  const userAccounts = payload?.replaceAll
    ? incomingUsers.filter(u => u && !deletedUserIds.includes(String(u.id)))
    : mergeUsersLists(current.userAccounts, incomingUsers, deletedUserIds);
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
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not save users file:', e.message);
  }
  return data;
}

function appendServerAuditLog(dataObj, event, userOrName, detail = '', actor = '', req = null) {
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
  const nextLogs = [entry, ...(Array.isArray(dataObj.authLogs) ? dataObj.authLogs : [])].slice(0, 500);
  dataObj.authLogs = nextLogs;
  return entry;
}

function ensureDefaultAdminInStore() {
  const store = readSavedUsers();
  const hasActiveAdmin = (store.userAccounts || []).some(u => u && u.active !== false && u.role === 'admin');
  if (hasActiveAdmin) return store;
  const salt = makeSalt();
  const hash = hashSecretServer('1234', salt);
  const now = new Date().toISOString();
  const rootAdmin = {
    id: 'usr-admin-root',
    username: 'ADMIN',
    email: '',
    fullName: 'Administrador Principal',
    role: 'admin',
    active: true,
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
    username: 'ADMIN',
    fullName: 'Administrador Principal',
    role: 'admin',
    detail: 'Cuenta maestra inicial generada automáticamente (requiere cambio de clave al ingresar)',
    actor: 'SISTEMA',
    device: 'Servidor'
  });
  return writeSavedUsers({
    replaceAll: true,
    userAccounts: [rootAdmin, ...(store.userAccounts || []).filter(u => u.id !== 'usr-admin-root' && u.username !== 'ADMIN')],
    deletedUserIds: store.deletedUserIds.filter(id => id !== 'usr-admin-root'),
    authSettings: store.authSettings,
    authLogs: nextLogs
  });
}

function cleanConfigUrl(u) {
  const s = String(u || '').trim();
  if (!s || /TU_SCRIPT_ID/i.test(s)) return '';
  return s;
}

function cleanConfigToken(t) {
  const s = String(t || '').trim();
  if (!s || /^TU_CLAVE_SECRETA_AQUI$/i.test(s)) return '';
  return s;
}

function readSavedConfig() {
  ensureDataDir();
  let fileCfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (_) {}
  }
  return {
    scriptUrl: cleanConfigUrl(process.env.GOOGLE_APPS_SCRIPT_URL) || cleanConfigUrl(fileCfg.scriptUrl),
    scriptToken: cleanConfigToken(process.env.GOOGLE_APPS_SCRIPT_TOKEN) || cleanConfigToken(fileCfg.scriptToken)
  };
}

function writeSavedConfig(url, token) {
  ensureDataDir();
  const cur = readSavedConfig();
  const nextUrl = cleanConfigUrl(url) || cur.scriptUrl || '';
  const nextToken = cleanConfigToken(token) || cur.scriptToken || '';
  if (!nextUrl && !nextToken) return cur;
  const data = {
    scriptUrl: nextUrl,
    scriptToken: nextToken,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not save server config to file:', e.message);
  }
  return data;
}

function fetchWithTimeout(url, options = {}, timeoutMs = DRIVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

let driveHydratedOnce = false;
let hydrateInFlight = null;
let lastDriveHydrateAt = 0;
async function hydrateUsersFromDrive(force = false, timeoutMs = 10000) {
  const cur = readSavedUsers();
  if (!force && driveHydratedOnce && cur.userAccounts && cur.userAccounts.length > 0) return cur;
  if (hydrateInFlight) return hydrateInFlight;
  const cfg = readSavedConfig();
  if (!cfg.scriptUrl) {
    driveHydratedOnce = true;
    return ensureDefaultAdminInStore();
  }

  hydrateInFlight = (async () => {
    const cleanBase = cfg.scriptUrl.replace(/\?.*$/, '');
    for (const action of ['getUsersAndAuth', 'getAll']) {
      try {
        const url = `${cleanBase}?action=${encodeURIComponent(action)}&token=${encodeURIComponent(cfg.scriptToken || '')}&_=${Date.now()}`;
        const r = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'follow' }, timeoutMs);
        const text = await r.text();
        const json = JSON.parse(text);
        if (json && json.ok) {
          driveHydratedOnce = true;
          lastDriveHydrateAt = Date.now();
          const src = action === 'getAll' ? (json.data?.app || {}) : json;
          if (Array.isArray(src.userAccounts) || Array.isArray(src.authLogs)) {
            writeSavedUsers({
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
    driveHydratedOnce = true;
    return ensureDefaultAdminInStore();
  })().finally(() => {
    hydrateInFlight = null;
  });

  return hydrateInFlight;
}

let driveSyncQueue = Promise.resolve();
function runSerializedDriveSync(fn) {
  const next = driveSyncQueue.then(fn, fn);
  driveSyncQueue = next.catch(() => false);
  return next;
}

async function syncUsersToDriveServer() {
  return runSerializedDriveSync(async () => {
    const cfg = readSavedConfig();
    if (!cfg.scriptUrl) return false;
    const store = readSavedUsers();
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
        writeSavedUsers({
          userAccounts: json.userAccounts || [],
          deletedUserIds: json.deletedUserIds || [],
          authSettings: json.authSettings || {},
          authLogs: json.authLogs || []
        });
        return true;
      }
    } catch (_) {}
    return false;
  });
}

function attachAuthUser(req, _res, next) {
  req.authUser = null;
  const token = extractTokenFromReq(req);
  if (!token) return next();
  const payload = verifySessionToken(token);
  if (!payload) return next();
  const store = readSavedUsers();
  const matched = (store.userAccounts || []).find(
    u => u && u.active !== false && (u.id === payload.id || String(u.username || '').toUpperCase() === payload.username)
  );
  if (matched) {
    req.authUser = matched;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.authUser) {
    return res.status(401).json({ ok: false, error: 'Sesión requerida o expirada. Inicia sesión nuevamente.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.authUser) {
    return res.status(401).json({ ok: false, error: 'Sesión de administrador requerida.' });
  }
  if (req.authUser.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Permisos insuficientes. Se requiere rol de Administrador.' });
  }
  next();
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(attachAuthUser);

app.use('/data', (_req, res) => res.status(404).end());
app.use(express.static(__dirname, {
  index: false,
  fallthrough: true,
  extensions: false,
  setHeaders: (res, filePath) => {
    if (/\.(js|mjs|css|json|webmanifest|png|jpe?g|gif|svg|ico|webp|xlsx|txt|map)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  }
}));

app.get('/api/config', (req, res) => {
  const cfg = readSavedConfig();
  res.json({
    scriptUrl: cfg.scriptUrl,
    scriptToken: cfg.scriptToken
  });
});

app.post('/api/config', (req, res) => {
  const url = (req.body?.scriptUrl || req.body?.url || '').trim();
  const token = (req.body?.scriptToken || req.body?.token || '').trim();
  const saved = writeSavedConfig(url, token);
  res.json({ ok: true, config: saved });
});

// =========================================================
// AUTENTICACIÓN SEGURA EN SERVIDOR
// =========================================================
app.get('/api/auth/me', async (req, res) => {
  if (!req.authUser) {
    return res.json({ ok: false, authenticated: false });
  }
  const store = readSavedUsers();
  return res.json({
    ok: true,
    authenticated: true,
    user: sanitizeUser(req.authUser),
    authSettings: store.authSettings
  });
});

app.post('/api/auth/login', async (req, res) => {
  const identifier = String(req.body?.identifier || req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!identifier || !password) {
    return res.status(400).json({ ok: false, error: 'Ingresa tu usuario o correo y tu contraseña.' });
  }

  const clientIp = getClientIp(req);
  const rl = getRateLimitStatus(clientIp, identifier);
  if (rl.blocked) {
    return res.status(429).json({
      ok: false,
      error: `Demasiados intentos fallidos. Espera ${rl.remainingSec} segundos antes de volver a intentar.`,
      lockedSeconds: rl.remainingSec
    });
  }

  let store = await hydrateUsersFromDrive(false);
  const idUpper = identifier.toUpperCase();
  const idLower = identifier.toLowerCase();

  const findUserInStore = (st) => (st.userAccounts || []).find(u =>
    String(u.username || '').toUpperCase() === idUpper ||
    (u.email && String(u.email).trim().toLowerCase() === idLower)
  );

  let user = findUserInStore(store);

  // Solo consultar Drive de forma síncrona si no existe o no coincide la clave local (p.ej. clave cambiada desde otra PC)
  if (!user || !verifyPasswordServer(user, password)) {
    if (Date.now() - lastDriveHydrateAt > 5000) {
      store = await hydrateUsersFromDrive(true, 4500);
      user = findUserInStore(store);
    }
  }

  if (!user) {
    recordLoginFailure(rl.key);
    appendServerAuditLog(store, 'INTENTO_FALLIDO', idUpper, 'Usuario no registrado', idUpper, req);
    writeSavedUsers(store);
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
  }

  if (user.active === false) {
    recordLoginFailure(rl.key);
    appendServerAuditLog(store, 'INTENTO_FALLIDO', user, 'Cuenta deshabilitada intentó ingresar', user.username, req);
    writeSavedUsers(store);
    return res.status(403).json({ ok: false, error: 'Esta cuenta está deshabilitada. Contacta al Administrador.' });
  }

  if (!verifyPasswordServer(user, password)) {
    recordLoginFailure(rl.key);
    appendServerAuditLog(store, 'INTENTO_FALLIDO', user, 'Contraseña incorrecta', user.username, req);
    writeSavedUsers(store);
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
  }

  clearLoginFailures(rl.key);
  const now = new Date().toISOString();
  user.lastLoginAt = now;
  appendServerAuditLog(store, 'INICIO_SESION', user, 'Ingreso autorizado desde pantalla de inicio', user.username, req);
  const saved = writeSavedUsers(store);

  const token = signSessionToken(user);
  setAuthCookie(res, req, token);
  // Respaldo a Drive en segundo plano para respuesta inmediata al usuario
  syncUsersToDriveServer().catch(() => {});

  return res.json({
    ok: true,
    user: sanitizeUser(user),
    token,
    authSettings: saved.authSettings,
    authLogs: saved.authLogs
  });
});

app.post('/api/auth/logout', async (req, res) => {
  const reason = String(req.body?.reason || 'manual');
  if (req.authUser) {
    const store = readSavedUsers();
    const ev = reason === 'inactivity' ? 'CIERRE_INACTIVIDAD' : 'CIERRE_SESION';
    const detail = reason === 'inactivity' ? 'Cierre automático por inactividad' : 'Cierre de sesión manual';
    appendServerAuditLog(store, ev, req.authUser, detail, req.authUser.username, req);
    writeSavedUsers(store);
    syncUsersToDriveServer().catch(() => {});
  }
  clearAuthCookie(res, req);
  return res.json({ ok: true });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const curPass = String(req.body?.currentPassword || '');
  const newPass = String(req.body?.newPassword || '');
  if (!newPass.trim() || newPass.length < 4) {
    return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
  }
  const store = await hydrateUsersFromDrive(true);
  const user = (store.userAccounts || []).find(
    u => u.id === req.authUser.id || String(u.username || '').toUpperCase() === String(req.authUser.username).toUpperCase()
  );
  if (!user) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
  }
  if (!req.body?.forcedFirstChange || curPass) {
    if (!verifyPasswordServer(user, curPass)) {
      return res.status(401).json({ ok: false, error: 'La contraseña actual es incorrecta.' });
    }
  } else if (!user.mustChangePassword) {
    return res.status(401).json({ ok: false, error: 'Ingresa tu contraseña actual.' });
  }

  const now = new Date().toISOString();
  const salt = makeSalt();
  user.passwordSalt = salt;
  user.passwordHash = hashSecretServer(newPass, salt);
  user.provisionalHash = '';
  user.provisionalSalt = '';
  user.mustChangePassword = false;
  user.isDefaultSeed = false;
  user.passwordUpdatedAt = now;
  user.updatedAt = now;

  const clientIp = getClientIp(req);
  clearLoginFailures(`${clientIp}::${String(user.username || '').trim().toUpperCase()}`);
  if (user.email) clearLoginFailures(`${clientIp}::${String(user.email || '').trim().toUpperCase()}`);

  appendServerAuditLog(store, 'CAMBIO_CLAVE', user, 'El usuario actualizó su contraseña personal', user.username, req);
  const saved = writeSavedUsers(store);
  const token = signSessionToken(user);
  setAuthCookie(res, req, token);
  const syncedToDrive = await syncUsersToDriveServer().catch(() => false);

  return res.json({
    ok: true,
    syncedToDrive: Boolean(syncedToDrive),
    token,
    user: sanitizeUser(user),
    userAccounts: sanitizeUsersList(saved.userAccounts),
    authLogs: saved.authLogs
  });
});

app.post('/api/auth/elevate-admin', requireAuth, async (req, res) => {
  const pass = String(req.body?.password || '');
  if (!pass) return res.json({ ok: false });
  const store = await hydrateUsersFromDrive(true);
  const admins = (store.userAccounts || []).filter(u => u && u.active !== false && u.role === 'admin');
  const matched = admins.some(a => verifyPasswordServer(a, pass));
  return res.json({ ok: matched });
});

// =========================================================
// GESTIÓN DE USUARIOS (SIN EXPONER HASHES)
// =========================================================
app.get('/api/users', async (req, res) => {
  const store = await hydrateUsersFromDrive(false);
  const users = store.userAccounts || [];
  const onlyRootSeed = users.length === 1 && users[0]?.username === 'ADMIN' && Boolean(users[0]?.isDefaultSeed);
  res.json({
    ok: true,
    userAccounts: sanitizeUsersList(users),
    deletedUserIds: store.deletedUserIds,
    authSettings: store.authSettings,
    authLogs: req.authUser ? store.authLogs : [],
    onlyRootSeed,
    updatedAt: store.updatedAt
  });
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const op = String(body.op || '').trim();
  const store = await hydrateUsersFromDrive(true);
  const actor = req.authUser.username;

  if (op === 'create') {
    const username = String(body.username || '').trim().toUpperCase();
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const pass = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'user';
    const defaultCenter = ['1003', '1004'].includes(String(body.defaultCenter || '')) ? String(body.defaultCenter) : '';
    const defaultSupervisor = String(body.defaultSupervisor || '').trim().toUpperCase();
    const mustChangePassword = Boolean(body.mustChangePassword);

    if (!username || !fullName) {
      return res.status(400).json({ ok: false, error: 'Completa el Usuario y Nombre completo.' });
    }
    if (!pass.trim() || pass.length < 4) {
      return res.status(400).json({ ok: false, error: 'Asigna una contraseña de al menos 4 caracteres.' });
    }
    if ((store.userAccounts || []).some(u => String(u.username || '').toUpperCase() === username || (email && u.email && String(u.email).toLowerCase() === email))) {
      return res.status(409).json({ ok: false, error: 'Ya existe un usuario con ese código o correo.' });
    }

    const salt = makeSalt();
    const now = new Date().toISOString();
    const newUser = {
      id: 'usr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      username,
      email,
      fullName,
      role,
      active: true,
      mustChangePassword,
      isDefaultSeed: false,
      defaultCenter,
      defaultSupervisor,
      passwordSalt: salt,
      passwordHash: hashSecretServer(pass, salt),
      passwordUpdatedAt: now,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: ''
    };
    store.userAccounts.unshift(newUser);
    appendServerAuditLog(store, 'CREAR_USUARIO', newUser, `Cuenta creada (${role === 'admin' ? 'Administrador' : 'Usuario estándar'})`, actor, req);
    const saved = writeSavedUsers(store);
    await syncUsersToDriveServer().catch(() => {});
    return res.json({
      ok: true,
      user: sanitizeUser(newUser),
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  if (op === 'update') {
    const uid = String(body.id || '');
    const user = (store.userAccounts || []).find(u => u.id === uid);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const role = body.role === 'admin' ? 'admin' : 'user';
    const newPass = String(body.password || '');
    const defaultCenter = ['1003', '1004'].includes(String(body.defaultCenter || '')) ? String(body.defaultCenter) : '';
    const defaultSupervisor = String(body.defaultSupervisor || '').trim().toUpperCase();
    const mustChangePassword = Boolean(body.mustChangePassword);

    if (!fullName) return res.status(400).json({ ok: false, error: 'El nombre completo es obligatorio.' });
    if (email && (store.userAccounts || []).some(u => u.id !== uid && u.email && String(u.email).toLowerCase() === email)) {
      return res.status(409).json({ ok: false, error: 'Ese correo ya pertenece a otro usuario.' });
    }
    if (newPass && (!newPass.trim() || newPass.length < 4)) {
      return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
    }
    if (user.role === 'admin' && role !== 'admin') {
      const otherAdmins = (store.userAccounts || []).filter(u => u.id !== uid && u.active !== false && u.role === 'admin');
      if (!otherAdmins.length) {
        return res.status(400).json({ ok: false, error: 'Debe existir al menos un Administrador activo en el sistema.' });
      }
    }

    const now = new Date().toISOString();
    user.fullName = fullName;
    user.email = email;
    user.role = role;
    user.defaultCenter = defaultCenter;
    user.defaultSupervisor = defaultSupervisor;
    user.mustChangePassword = mustChangePassword;
    if (newPass) {
      const salt = makeSalt();
      user.passwordSalt = salt;
      user.passwordHash = hashSecretServer(newPass, salt);
      user.provisionalHash = '';
      user.provisionalSalt = '';
      user.isDefaultSeed = false;
      user.passwordUpdatedAt = now;
      const clientIp = getClientIp(req);
      clearLoginFailures(`${clientIp}::${String(user.username || '').trim().toUpperCase()}`);
      if (user.email) clearLoginFailures(`${clientIp}::${String(user.email || '').trim().toUpperCase()}`);
    }
    user.updatedAt = now;
    appendServerAuditLog(store, newPass ? 'CAMBIO_CLAVE' : 'ACTUALIZAR_USUARIO', user, newPass ? 'Administrador asignó nueva contraseña y actualizó cuenta' : 'Administrador actualizó datos/rol/perfil', actor, req);
    const saved = writeSavedUsers(store);
    const syncedToDrive = await syncUsersToDriveServer().catch(() => false);
    return res.json({
      ok: true,
      syncedToDrive: Boolean(syncedToDrive),
      user: sanitizeUser(user),
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  if (op === 'toggle') {
    const uid = String(body.id || '');
    const user = (store.userAccounts || []).find(u => u.id === uid);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
    const nextActive = user.active === false;
    if (!nextActive && user.role === 'admin') {
      const otherAdmins = (store.userAccounts || []).filter(u => u.id !== uid && u.active !== false && u.role === 'admin');
      if (!otherAdmins.length) {
        return res.status(400).json({ ok: false, error: 'No puedes desactivar al único Administrador activo.' });
      }
    }
    user.active = nextActive;
    user.updatedAt = new Date().toISOString();
    appendServerAuditLog(store, 'ACTUALIZAR_USUARIO', user, nextActive ? 'Cuenta activada' : 'Cuenta deshabilitada', actor, req);
    const saved = writeSavedUsers(store);
    await syncUsersToDriveServer().catch(() => {});
    return res.json({
      ok: true,
      user: sanitizeUser(user),
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  if (op === 'delete') {
    const uid = String(body.id || '');
    const user = (store.userAccounts || []).find(u => u.id === uid);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
    if (user.role === 'admin') {
      const otherAdmins = (store.userAccounts || []).filter(u => u.id !== uid && u.active !== false && u.role === 'admin');
      if (!otherAdmins.length) {
        return res.status(400).json({ ok: false, error: 'No puedes eliminar al único Administrador activo.' });
      }
    }
    store.deletedUserIds = Array.from(new Set([...(store.deletedUserIds || []), uid])).slice(-200);
    store.userAccounts = (store.userAccounts || []).filter(u => u.id !== uid);
    appendServerAuditLog(store, 'ELIMINAR_USUARIO', user, 'Usuario eliminado por administrador', actor, req);
    const saved = writeSavedUsers({ ...store, replaceAll: true });
    await syncUsersToDriveServer().catch(() => {});
    return res.json({
      ok: true,
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  if (op === 'settings') {
    const mins = Number(body.sessionTimeoutMinutes);
    store.authSettings = normalizeAuthSettings({ sessionTimeoutMinutes: Number.isFinite(mins) ? mins : 30 }, store.authSettings);
    appendServerAuditLog(store, 'CONFIG_SEGURIDAD', actor, `Tiempo de cierre por inactividad configurado a ${store.authSettings.sessionTimeoutMinutes} min`, actor, req);
    const saved = writeSavedUsers(store);
    await syncUsersToDriveServer().catch(() => {});
    return res.json({
      ok: true,
      userAccounts: sanitizeUsersList(saved.userAccounts),
      deletedUserIds: saved.deletedUserIds,
      authSettings: saved.authSettings,
      authLogs: saved.authLogs
    });
  }

  // Fallback legacy merge (preserves existing server hashes)
  const saved = writeSavedUsers(body);
  return res.json({
    ok: true,
    userAccounts: sanitizeUsersList(saved.userAccounts),
    deletedUserIds: saved.deletedUserIds,
    authSettings: saved.authSettings,
    authLogs: saved.authLogs
  });
});

// =========================================================
// PROXY GOOGLE DRIVE (PRESERVA HASHES EN DRIVE SIN EXPONERLOS AL BROWSER)
// =========================================================
app.post('/api/drive/sync', async (req, res) => {
  try {
    const cfg = readSavedConfig();
    const reqUrl = (req.body?.targetUrl || req.body?.url || req.body?.scriptUrl || '').trim();
    const reqToken = (req.body?.token || req.body?.scriptToken || '').trim();

    if (reqUrl) {
      writeSavedConfig(reqUrl, reqToken);
    }

    const targetUrl = (cfg.scriptUrl || reqUrl).trim();
    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en el servidor ni en la app.' });
    }
    const payload = req.body?.payload ? { ...req.body.payload } : { ...req.body };
    delete payload.targetUrl;
    delete payload.url;

    // Preservar hashes autoritativos hidratando desde Drive antes de enviar syncAll/syncUsersAndAuth
    const serverUsers = await hydrateUsersFromDrive(true);
    if (payload.action === 'syncUsersAndAuth') {
      payload.userAccounts = serverUsers.userAccounts;
      payload.deletedUserIds = serverUsers.deletedUserIds;
      payload.authSettings = serverUsers.authSettings;
      payload.authLogs = mergeAuthLogs(serverUsers.authLogs, payload.authLogs);
    } else if (payload.action === 'syncAll' && payload.data && payload.data.app) {
      payload.data = {
        ...payload.data,
        app: {
          ...payload.data.app,
          userAccounts: serverUsers.userAccounts,
          deletedUserIds: serverUsers.deletedUserIds,
          authSettings: serverUsers.authSettings,
          authLogs: mergeAuthLogs(serverUsers.authLogs, payload.data.app.authLogs)
        }
      };
    }

    if (cfg.scriptToken) {
      payload.token = cfg.scriptToken;
    } else if (!payload.token && reqToken) {
      payload.token = reqToken;
    }

    const response = await fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
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

    if (data && data.ok && Array.isArray(data.userAccounts)) {
      const merged = writeSavedUsers({
        userAccounts: data.userAccounts,
        deletedUserIds: data.deletedUserIds,
        authSettings: data.authSettings,
        authLogs: data.authLogs
      });
      data.userAccounts = sanitizeUsersList(merged.userAccounts);
      data.authLogs = merged.authLogs;
      data.authSettings = merged.authSettings;
    }

    return res.json(data);
  } catch (err) {
    console.error('Error in /api/drive/sync proxy:', err);
    return res.status(err?.name === 'AbortError' ? 504 : 500).json({
      ok: false,
      error: err?.name === 'AbortError'
        ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS / 1000} segundos.`
        : 'Error de conexión con Google Apps Script: ' + (err?.message || err)
    });
  }
});

app.get('/api/drive/get', async (req, res) => {
  try {
    const cfg = readSavedConfig();
    const reqUrl = (req.query?.url || '').trim();
    const reqToken = (req.query?.token || '').trim();

    if (reqUrl) {
      writeSavedConfig(reqUrl, reqToken);
    }

    const targetUrl = (cfg.scriptUrl || reqUrl).trim();
    const token = cfg.scriptToken || reqToken;
    const action = req.query?.action || 'getAll';

    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: 'URL de Google Apps Script no configurada en el servidor ni en la app.' });
    }

    const cleanBase = targetUrl.replace(/\?.*$/, '');
    const urlWithParams = `${cleanBase}?action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}&_=${Date.now()}`;

    const response = await fetchWithTimeout(urlWithParams, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow'
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return res.status(502).json({ ok: false, error: 'Respuesta no válida de Google Apps Script: ' + text.slice(0, 200) });
    }

    // Guardar usuarios/hashes entrantes en servidor y sanitizar respuesta al navegador
    if (data && data.ok) {
      if (action === 'getAll' && data.data && data.data.app) {
        if (Array.isArray(data.data.app.userAccounts) || Array.isArray(data.data.app.authLogs)) {
          const merged = writeSavedUsers({
            userAccounts: data.data.app.userAccounts || [],
            deletedUserIds: data.data.app.deletedUserIds || [],
            authSettings: data.data.app.authSettings || {},
            authLogs: data.data.app.authLogs || []
          });
          data.data.app.userAccounts = sanitizeUsersList(merged.userAccounts);
          data.data.app.deletedUserIds = merged.deletedUserIds;
          data.data.app.authSettings = merged.authSettings;
          data.data.app.authLogs = req.authUser ? merged.authLogs : [];
        }
      } else if (action === 'getUsersAndAuth') {
        const merged = writeSavedUsers({
          userAccounts: data.userAccounts || [],
          deletedUserIds: data.deletedUserIds || [],
          authSettings: data.authSettings || {},
          authLogs: data.authLogs || []
        });
        data.userAccounts = sanitizeUsersList(merged.userAccounts);
        data.deletedUserIds = merged.deletedUserIds;
        data.authSettings = merged.authSettings;
        data.authLogs = req.authUser ? merged.authLogs : [];
      }
    }

    return res.json(data);
  } catch (err) {
    console.error('Error in /api/drive/get proxy:', err);
    return res.status(err?.name === 'AbortError' ? 504 : 500).json({
      ok: false,
      error: err?.name === 'AbortError'
        ? `Google Apps Script no respondió en ${DRIVE_TIMEOUT_MS / 1000} segundos.`
        : 'Error al consultar Google Apps Script: ' + (err?.message || err)
    });
  }
});

app.get('*', async (req, res) => {
  if (/\.[a-z0-9]+$/i.test(req.path)) {
    return res.status(404).type('text/plain').send('Recurso no encontrado: ' + req.path);
  }
  try {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.sendFile(path.join(__dirname, 'index.html'));
  } catch (err) {
    console.error('Error sirviendo index.html:', err);
    return res.status(500).type('text/plain').send('No se pudo cargar la aplicación.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  hydrateUsersFromDrive(true).catch(() => ensureDefaultAdminInStore());
});
