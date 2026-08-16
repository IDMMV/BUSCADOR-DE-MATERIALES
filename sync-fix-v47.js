/* V47 stability patch: synchronization, multi-PC safety and order UI. */
(function () {
  'use strict';

  const stateStore = {
    revision: Number(window.__bmSyncRevision || 0),
    inFlight: null,
    rerun: false,
    failed: false,
    lastCompletedRevision: -1,
    originalSync: window.syncToDrive,
    originalRestore: window.restoreFromDrive,
    originalSave: window.save,
    originalQueue: window.queueSync
  };
  window.__bmSyncRevision = stateStore.revision;
  window.__bmSyncV47 = true;

  const readCfg = () => {
    try { return typeof window.syncConfig === 'function' ? window.syncConfig() : {}; }
    catch (_) { return {}; }
  };

  const markRevision = () => {
    stateStore.revision += 1;
    window.__bmSyncRevision = stateStore.revision;
    return stateStore.revision;
  };

  if (typeof stateStore.originalSave === 'function') {
    window.save = function patchedSave(...args) {
      const result = stateStore.originalSave.apply(this, args);
      markRevision();
      return result;
    };
  }

  if (typeof stateStore.originalQueue === 'function') {
    window.queueSync = function patchedQueueSync(...args) {
      const result = stateStore.originalQueue.apply(this, args);
      markRevision();
      return result;
    };
  }

  if (typeof stateStore.originalSync === 'function') {
    window.syncToDrive = function patchedSyncToDrive(options = {}) {
      if (stateStore.inFlight) {
        stateStore.rerun = true;
        return stateStore.inFlight;
      }

      const startRevision = stateStore.revision;
      stateStore.failed = false;
      stateStore.inFlight = (async () => {
        try {
          const result = await stateStore.originalSync.call(this, options);
          if (result === false) stateStore.failed = true;
          return result;
        } catch (error) {
          stateStore.failed = true;
          throw error;
        } finally {
          stateStore.lastCompletedRevision = startRevision;
          const changedDuringSync = stateStore.revision > startRevision;
          const shouldRetry = !stateStore.failed && (stateStore.rerun || changedDuringSync);
          stateStore.rerun = false;
          stateStore.inFlight = null;
          if (shouldRetry) {
            setTimeout(() => {
              const latest = readCfg();
              if (latest.url && latest.pending && navigator.onLine) {
                window.syncToDrive({ isManual: false });
              }
            }, 350);
          }
        }
      })();

      return stateStore.inFlight;
    };
  }

  if (typeof stateStore.originalRestore === 'function') {
    window.restoreFromDrive = async function patchedRestoreFromDrive(options = {}) {
      const cfg = readCfg();
      const forced = options && options.force === true;
      const unsafePending = cfg.pending === true && !forced;
      const changedAfterSync = stateStore.lastCompletedRevision >= 0 && stateStore.revision > stateStore.lastCompletedRevision;

      if (!forced && (stateStore.failed || stateStore.inFlight || unsafePending || changedAfterSync)) {
        return false;
      }

      return stateStore.originalRestore.call(this, options);
    };
  }

  function byText(root, text) {
    const wanted = text.toLowerCase();
    return Array.from((root || document).querySelectorAll('button, a, input[type="button"], input[type="submit"]'))
      .filter(el => (el.textContent || el.value || '').trim().toLowerCase().includes(wanted));
  }

  function arrangeOrderView() {
    const orderView = document.getElementById('orderView');
    if (!orderView) return;

    const back = byText(orderView, 'volver a buscar materiales')[0];
    const saveBtn = byText(orderView, 'grabar pedido')[0];
    const clearBtn = byText(orderView, 'borrar pedidos')[0];
    if (!back || (!saveBtn && !clearBtn)) return;

    const table = orderView.querySelector('table');
    const tableWrap = table?.closest('.tablewrap, .v29-table-wrap, .table-container, .order-table-wrap') || table?.parentElement;

    if (back) {
      let backRow = orderView.querySelector('[data-v47-back-row]');
      if (!backRow) {
        backRow = document.createElement('div');
        backRow.dataset.v47BackRow = '1';
        backRow.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;gap:8px;margin:0 0 10px 0;';
        back.parentElement?.insertBefore(backRow, back);
        backRow.appendChild(back);
      }
      if (tableWrap) {
        const host = tableWrap.parentElement || orderView;
        if (backRow.parentElement !== host) host.insertBefore(backRow, tableWrap);
      }
    }

    if (saveBtn || clearBtn) {
      let actionRow = orderView.querySelector('[data-v47-order-actions]');
      if (!actionRow) {
        actionRow = document.createElement('div');
        actionRow.dataset.v47OrderActions = '1';
        actionRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:10px;';
        const left = document.createElement('div');
        const right = document.createElement('div');
        left.dataset.v47Left = '1';
        right.dataset.v47Right = '1';
        left.style.cssText = 'display:flex;gap:8px;align-items:center;';
        right.style.cssText = 'display:flex;gap:8px;align-items:center;';
        actionRow.append(left, right);
        if (tableWrap) tableWrap.insertAdjacentElement('afterend', actionRow);
        else orderView.appendChild(actionRow);
      }

      const left = actionRow.querySelector('[data-v47-left]');
      const right = actionRow.querySelector('[data-v47-right]');
      if (clearBtn && left && !left.contains(clearBtn)) left.appendChild(clearBtn);
      if (saveBtn && right && !right.contains(saveBtn)) right.appendChild(saveBtn);
    }
  }

  function bindMultiSaveReset() {
    byText(document, 'guardar todos al pedido').forEach(btn => {
      if (btn.dataset.v47Bound === '1') return;
      btn.dataset.v47Bound = '1';
      btn.addEventListener('click', () => {
        setTimeout(() => {
          const multiToolbar = btn.closest('.v36-multi-toolbar');
          const parent = multiToolbar?.parentElement || document;
          const inputs = parent.querySelectorAll('input[type="search"], input[placeholder*="Buscar" i], input[id="q"], input[id="searchInput"]');
          inputs.forEach(input => {
            if (input.value) {
              input.value = '';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
          markRevision();
        }, 120);
      });
    });
  }

  function start() {
    arrangeOrderView();
    bindMultiSaveReset();
    const observer = new MutationObserver(() => {
      arrangeOrderView();
      bindMultiSaveReset();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(arrangeOrderView, 300);
    setTimeout(arrangeOrderView, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
