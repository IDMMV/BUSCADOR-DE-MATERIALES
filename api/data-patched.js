const BASE_DATA_URL = 'https://raw.githubusercontent.com/IDMMV/BUSCADOR-DE-MATERIALES/main/data.js';

const V45_PATCH = String.raw`
/* ===== V45: corrección de sincronización multi-PC (2026-08-13) ===== */
(function installV45SyncSafetyPatch(){
  'use strict';
  if (typeof window === 'undefined') return;
  setTimeout(function applyV45Patch(){
    if (window.__BM_V45_SYNC_PATCHED__) return;
    if (typeof window.syncToDrive !== 'function' || typeof window.restoreFromDrive !== 'function' || typeof window.queueSync !== 'function') {
      setTimeout(applyV45Patch, 0);
      return;
    }
    window.__BM_V45_SYNC_PATCHED__ = true;
    var syncTimer = null;

    function cfgRead(){
      try { return JSON.parse(localStorage.getItem('bm_sync_v19') || '{}'); }
      catch (_) { return {}; }
    }
    function cfgWrite(cfg){
      localStorage.setItem('bm_sync_v19', JSON.stringify(cfg || {}));
      try { if (typeof renderSyncState === 'function') renderSyncState(); } catch (_) {}
    }

    window.queueSync = function(type, schedule, incrementRevision){
      if (type === undefined) type = 'app';
      if (schedule === undefined) schedule = true;
      if (incrementRevision === undefined) incrementRevision = true;
      var cfg = cfgRead();
      cfg.pending = true;
      cfg.pendingType = type;
      if (incrementRevision) cfg.localRevision = (Number(cfg.localRevision) || 0) + 1;
      cfgWrite(cfg);
      if (schedule && navigator.onLine) {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(function(){
          try {
            var current = (typeof syncConfig === 'function') ? syncConfig() : cfgRead();
            if (current.pending && current.url) window.syncToDrive({ isManual:false });
          } catch (e) { console.warn('V45 auto-sync:', e); }
        }, 1200);
      }
    };

    window.syncToDrive = async function(options){
      options = options || {};
      var isManual = (typeof options === 'object' && options !== null && 'isManual' in options) ? !!options.isManual : (options === true);
      var btn = document.getElementById('syncNow');
      try {
        if (typeof ensureConfigReady === 'function') await ensureConfigReady();
        var cfg = (typeof syncConfig === 'function') ? syncConfig() : cfgRead();
        var startRevision = Number(cfg.localRevision) || 0;
        var inputUrl = document.getElementById('scriptUrl')?.value.trim();
        var inputToken = document.getElementById('scriptToken')?.value.trim();
        var url = inputUrl || cfg.url || '';
        var token = inputToken || cfg.token || '';
        if (url) { cfg.url = url; localStorage.setItem('bm_saved_script_url', url); }
        if (token) { cfg.token = token; localStorage.setItem('bm_saved_script_token', token); }
        cfgWrite(cfg);

        if (!url) {
          if (isManual && typeof msg === 'function') msg('Configura la URL de Google Apps Script en Administración > Google Drive o en Vercel.', true, '#adminStatus');
          return false;
        }
        if (!navigator.onLine) {
          window.queueSync('app', false, false);
          if (isManual && typeof msg === 'function') msg('Sin conexión a internet. Los cambios quedan guardados localmente.', true, '#adminStatus');
          return false;
        }

        if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando...'; }
        var box = document.getElementById('syncState');
        if (box) box.value = 'Sincronizando...';

        var writeId = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        var updatedAt = new Date().toISOString();
        var appForCloud = { ...state };
        delete appForCloud.syncToken;
        delete appForCloud.syncUrl;
        var payload = {
          action:'syncAll', token:token,
          data:{ app:appForCloud, pending:pendingItems, stockMeta:stockMeta, stockRows:stockRows, updatedAt:updatedAt, syncWriteId:writeId }
        };

        var saved = await callGoogleScript('syncAll', 'POST', payload);
        var verify = await callGoogleScript('getAll', 'GET');
        if (!verify?.data || verify.data.syncWriteId !== writeId) {
          throw new Error('Drive no confirmó la última escritura. Los cambios siguen pendientes para evitar pérdida de datos.');
        }

        var latest = (typeof syncConfig === 'function') ? syncConfig() : cfgRead();
        var noNewerChange = (Number(latest.localRevision) || 0) === startRevision;
        latest.lastSync = verify.data.updatedAt || saved.savedAt || new Date().toISOString();
        if (noNewerChange) { latest.pending = false; latest.pendingType = ''; }
        else latest.pending = true;
        cfgWrite(latest);

        if (!noNewerChange) {
          clearTimeout(syncTimer);
          syncTimer = setTimeout(function(){ window.syncToDrive({ isManual:false }); }, 350);
        }
        if (isManual && typeof msg === 'function') {
          msg(noNewerChange ? '✅ Guardado confirmado en Google Drive. Ya puede abrirse desde otra PC.' : '✅ Guardado recibido; existe un cambio más reciente y también se está enviando.', false, '#adminStatus');
        }
        return noNewerChange;
      } catch (e) {
        window.queueSync('app', false, false);
        if (isManual && typeof msg === 'function') msg('No se pudo sincronizar: ' + (e?.message || e), true, '#adminStatus');
        else console.warn('V45 sincronización pendiente:', e?.message || e);
        return false;
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sincronizar ahora'; }
      }
    };

    var originalRestore = window.restoreFromDrive;
    window.restoreFromDrive = async function(options){
      options = options || {};
      try { if (typeof ensureConfigReady === 'function') await ensureConfigReady(); } catch (_) {}
      var cfg = (typeof syncConfig === 'function') ? syncConfig() : cfgRead();
      var silent = !!options.silent;
      var stockOnly = !!options.stockOnly;
      if (cfg.pending && !stockOnly && !options.force) {
        if (!silent && typeof msg === 'function') msg('Hay cambios locales pendientes. Primero sincroniza; no se recuperará una copia anterior de Drive para evitar perderlos.', true, '#adminStatus');
        try { if (typeof renderSyncState === 'function') renderSyncState(); } catch (_) {}
        return false;
      }
      return originalRestore.call(window, options);
    };

    try { queueSync = window.queueSync; } catch (_) {}
    try { syncToDrive = window.syncToDrive; } catch (_) {}
    try { restoreFromDrive = window.restoreFromDrive; } catch (_) {}
    console.info('V45 sincronización multi-PC activa');
  }, 0);
})();
`;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const response = await fetch(BASE_DATA_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('No se pudo leer data.js base');
    const base = await response.text();
    return res.status(200).send(base + '\n' + V45_PATCH);
  } catch (error) {
    console.error('V45 data patch:', error);
    return res.status(502).send("console.error('No se pudo cargar el catálogo base.');");
  }
}
