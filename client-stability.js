/* Client stability guard: bound Drive waits and suppress duplicate automatic restores. */
(function () {
  'use strict';

  const state = window.__BM_CLIENT_STABILITY__ = window.__BM_CLIENT_STABILITY__ || {
    restoreInFlight: null,
    syncInFlight: null,
    lastAutoRestore: 0,
    lastAutoSync: 0,
    installed: false
  };

  if (state.installed) return;
  state.installed = true;

  const MANUAL_IDS = new Set([
    'restoreDrive',
    'driveBackup',
    'driveBackup2',
    'v27RefreshDrive',
    'syncNow'
  ]);

  const isManual = (options, sync) => {
    const activeId = document.activeElement && document.activeElement.id;
    if (MANUAL_IDS.has(activeId)) return true;
    return !!(options && typeof options === 'object' && options.isManual === true) ||
      (sync && options === true);
  };

  const withTimeout = (promise, ms, label) => {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[${label}] timeout after ${ms}ms`);
        resolve(false);
      }, ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  };

  function installRestoreGuard() {
    const original = window.restoreFromDrive;
    if (typeof original !== 'function' || original.__bmClientGuardWrapped) return;

    const wrapped = function (options = {}) {
      const manual = isManual(options, false);

      if (!manual) {
        const now = Date.now();
        if (now - state.lastAutoRestore < 30000) return Promise.resolve(false);
        state.lastAutoRestore = now;
      }

      if (state.restoreInFlight) return state.restoreInFlight;

      let result;
      try {
        result = original.call(this, { ...(options || {}), isManual: manual });
      } catch (error) {
        console.error('Drive restore start failed:', error);
        return Promise.resolve(false);
      }

      state.restoreInFlight = withTimeout(result, 12000, 'Drive restore')
        .catch((error) => {
          console.error('Drive restore failed:', error);
          return false;
        })
        .finally(() => {
          state.restoreInFlight = null;
        });

      return state.restoreInFlight;
    };

    wrapped.__bmClientGuardWrapped = true;
    window.restoreFromDrive = wrapped;
  }

  function installSyncGuard() {
    const original = window.syncToDrive;
    if (typeof original !== 'function' || original.__bmClientGuardWrapped) return;

    const wrapped = function (options = {}) {
      const manual = isManual(options, true);

      if (!manual) {
        const now = Date.now();
        if (now - state.lastAutoSync < 30000) return Promise.resolve(false);
        state.lastAutoSync = now;
      }

      if (state.syncInFlight) return state.syncInFlight;

      let result;
      try {
        result = original.call(this, manual ? { ...(options || {}), isManual: true } : (options || {}));
      } catch (error) {
        console.error('Drive sync start failed:', error);
        return Promise.resolve(false);
      }

      state.syncInFlight = withTimeout(result, 12000, 'Drive sync')
        .catch((error) => {
          console.error('Drive sync failed:', error);
          return false;
        })
        .finally(() => {
          state.syncInFlight = null;
        });

      return state.syncInFlight;
    };

    wrapped.__bmClientGuardWrapped = true;
    window.syncToDrive = wrapped;
  }

  installRestoreGuard();
  installSyncGuard();

  // The page defines these functions before this injected script, but keep a
  // small retry window in case a future refactor moves their definitions later.
  let attempts = 0;
  const timer = setInterval(() => {
    installRestoreGuard();
    installSyncGuard();
    attempts += 1;
    if (attempts >= 20) clearInterval(timer);
  }, 100);
})();
