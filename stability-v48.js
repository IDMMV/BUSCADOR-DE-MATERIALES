/* V48 stability patch: prevent duplicate startup restores and avoid indefinite config waits. */
(function(){
  'use strict';

  const state = window.__bmV48 = window.__bmV48 || {
    restoreInFlight: null,
    lastAutoRestoreAt: 0,
    configWrapped: false
  };

  // Never let /api/config block app startup forever.
  if (!state.configWrapped && window.fetchServerConfigPromise && typeof window.fetchServerConfigPromise.then === 'function') {
    state.configWrapped = true;
    const original = window.fetchServerConfigPromise;
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve(null), 5000);
    });
    window.fetchServerConfigPromise = Promise.race([original.catch(() => null), timeout]);
  }

  const originalRestore = typeof window.restoreFromDrive === 'function'
    ? window.restoreFromDrive
    : null;

  if (originalRestore && !window.__bmRestoreV48Wrapped) {
    window.__bmRestoreV48Wrapped = true;

    window.restoreFromDrive = function(options){
      const opts = (options && typeof options === 'object') ? options : {};
      const activeId = document.activeElement && document.activeElement.id;
      const manual = opts.isManual === true ||
        activeId === 'restoreDrive' ||
        activeId === 'driveBackup' ||
        activeId === 'driveBackup2' ||
        activeId === 'v27RefreshDrive';

      // Startup/focus code can call restore several times. Only allow one automatic
      // restore per 30 seconds. Manual button clicks always remain available.
      if (!manual) {
        const now = Date.now();
        if (now - state.lastAutoRestoreAt < 30000) return Promise.resolve(false);
        state.lastAutoRestoreAt = now;
      }

      if (state.restoreInFlight) return state.restoreInFlight;

      let result;
      try {
        result = originalRestore.call(this, { ...opts, isManual: manual });
      } catch (error) {
        console.error('V48 restore error:', error);
        return Promise.resolve(false);
      }

      state.restoreInFlight = Promise.resolve(result)
        .catch((error) => {
          console.error('V48 restore rejected:', error);
          return false;
        })
        .finally(() => {
          state.restoreInFlight = null;
        });

      return state.restoreInFlight;
    };
  }

  // Make explicit UI buttons manual after all existing handlers are installed.
  function markManualButton(id){
    const el = document.getElementById(id);
    if (!el || el.dataset.v48Manual === '1') return;
    el.dataset.v48Manual = '1';
    el.addEventListener('click', function(){
      // The wrapper uses activeElement, so this listener only documents the intent.
      // It deliberately does not call restore again.
    }, { passive: true });
  }

  function start(){
    ['restoreDrive','driveBackup','driveBackup2','v27RefreshDrive'].forEach(markManualButton);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
