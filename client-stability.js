/* Client stability guard: manual Drive sync only; never auto-restore at startup/focus. */
(function () {
  'use strict';

  const state = window.__BM_CLIENT_STABILITY__ = window.__BM_CLIENT_STABILITY__ || {
    restoreInFlight: null,
    syncInFlight: null,
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

      // Critical rule: automatic startup/focus refresh is disabled.
      // Drive recovery happens only after an explicit user action.
      if (!manual) {
        console.info('[Drive restore] automatic restore blocked by client stability guard');
        return Promise.resolve(false);
      }

      if (state.restoreInFlight) return state.restoreInFlight;

      let result;
      try {
        result = original.call(this, { ...(options || {}), isManual: true });
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

      // Automatic sync is also disabled. This prevents startup pending-state
      // cascades from starting another Drive operation.
      if (!manual) {
        console.info('[Drive sync] automatic sync blocked by client stability guard');
        return Promise.resolve(false);
      }

      if (state.syncInFlight) return state.syncInFlight;

      let result;
      try {
        result = original.call(this, { ...(options || {}), isManual: true });
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

  let attempts = 0;
  const timer = setInterval(() => {
    installRestoreGuard();
    installSyncGuard();
    attempts += 1;
    if (attempts >= 20) clearInterval(timer);
  }, 100);
})();
