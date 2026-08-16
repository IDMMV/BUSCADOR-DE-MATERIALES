(function () {
  'use strict';

  const ORDER_TABLE = '#orderPanel .tablewrap table';
  const SAVE_ROW = '#v26SaveRow';

  function addStyles() {
    if (document.getElementById('v455UiStyles')) return;
    const style = document.createElement('style');
    style.id = 'v455UiStyles';
    style.textContent = `
      #orderPanel .v438-back-row{display:grid !important;grid-template-columns:105px 390px 110px 110px minmax(0,1fr) !important;gap:10px !important;align-items:center !important;margin:0 0 12px !important;}
      #orderPanel .v438-back-btn{grid-column:4 !important;width:100% !important;white-space:nowrap !important;}
      #orderPanel .order-save-row{display:grid !important;grid-template-columns:105px 390px 110px 110px minmax(0,1fr) !important;gap:10px !important;align-items:center !important;width:100% !important;margin:12px 0 16px !important;}
      #orderPanel .order-save-row #v449ClearAllOrdersBtn{grid-column:1 !important;}
      #orderPanel .order-save-row #v31FinalizeOrder{grid-column:4 !important;}
      #orderPanel .v455-qty-wrap{display:flex !important;align-items:center !important;gap:7px !important;flex-wrap:nowrap !important;min-width:175px !important;}
      #orderPanel .v455-qty-wrap .qty{width:85px !important;flex:0 0 85px !important;}
      #orderPanel .v455-remove{min-width:82px !important;min-height:40px !important;padding:8px 10px !important;flex:0 0 auto !important;}
      @media (max-width:760px){
        #orderPanel .v438-back-row{grid-template-columns:1fr !important;}
        #orderPanel .v438-back-btn{grid-column:1 !important;}
        #orderPanel .order-save-row{grid-template-columns:1fr 1fr !important;}
        #orderPanel .order-save-row #v449ClearAllOrdersBtn{grid-column:1 !important;}
        #orderPanel .order-save-row #v31FinalizeOrder{grid-column:2 !important;}
        #orderPanel .v455-qty-wrap{min-width:0 !important;flex-wrap:wrap !important;}
      }
    `;
    document.head.appendChild(style);
  }

  function normalizeOrderButtons() {
    const panel = document.getElementById('orderPanel');
    const tableWrap = panel?.querySelector('.tablewrap');
    const saveRow = document.querySelector(SAVE_ROW);
    const preview = panel?.querySelector('.sap-preview-wrap');

    if (tableWrap && saveRow && saveRow.previousElementSibling !== tableWrap) {
      tableWrap.parentNode.insertBefore(saveRow, tableWrap.nextSibling);
    } else if (!tableWrap && preview && saveRow && saveRow.parentNode !== preview.parentNode) {
      preview.parentNode.insertBefore(saveRow, preview);
    }

    if (saveRow) {
      const clear = saveRow.querySelector('#v449ClearAllOrdersBtn');
      const finalize = saveRow.querySelector('#v31FinalizeOrder');
      if (clear) clear.style.gridColumn = '1';
      if (finalize) finalize.style.gridColumn = '4';
    }
  }

  function normalizeOrderTable() {
    const table = document.querySelector(ORDER_TABLE);
    if (!table) return;

    const head = table.querySelector('thead tr');
    if (head) {
      const headers = Array.from(head.children);
      if (headers.length >= 6) headers.slice(4).forEach(cell => cell.remove());
      if (head.children.length === 4) {
        head.children[0].textContent = 'Matrícula';
        head.children[1].textContent = 'Descripción';
        head.children[2].textContent = 'Cant.';
        head.children[3].textContent = 'Unidad';
      }
    }

    table.querySelectorAll('tbody tr').forEach(row => {
      const cells = Array.from(row.children);
      if (cells.length < 4) return;
      const qtyCell = cells[2];
      const removeButton = row.querySelector('[data-rm]');
      if (!removeButton) return;
      cells.slice(4).forEach(cell => cell.remove());

      let wrap = qtyCell.querySelector('.v455-qty-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'v455-qty-wrap';
        const input = qtyCell.querySelector('[data-qty]');
        if (!input) return;
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
      }
      removeButton.classList.add('v455-remove');
      removeButton.textContent = 'Quitar';
      if (removeButton.parentNode !== wrap) wrap.appendChild(removeButton);
      qtyCell.appendChild(wrap);
    });
  }

  function clearMultiFilterWhenComplete(codes) {
    const query = document.getElementById('q');
    if (!query || !Array.isArray(codes) || !codes.length) return;
    setTimeout(() => {
      const orderCodes = new Set(Array.from(document.querySelectorAll('#orderPanel #cart tr td:first-child b'))
        .map(el => String(el.textContent || '').trim()).filter(Boolean));
      const allAdded = codes.every(code => orderCodes.has(String(code)));
      if (!allAdded) return;
      query.value = '';
      query.dispatchEvent(new Event('input', { bubbles: true }));
      try { window.renderResults?.(); } catch (_) {}
    }, 120);
  }

  function hookMultiAdd() {
    if (document.documentElement.dataset.v455MultiHook === '1') return;
    document.documentElement.dataset.v455MultiHook = '1';
    document.addEventListener('click', event => {
      const button = event.target.closest?.('#btnSaveAllMulti');
      if (!button) return;
      const codes = Array.from(document.querySelectorAll('#results [data-v36-qty]'))
        .map(el => el.getAttribute('data-v36-qty')).filter(Boolean);
      clearMultiFilterWhenComplete(codes);
    }, true);
  }

  function wrapRenderCart() {
    if (typeof window.renderCart !== 'function' || window.renderCart.__v455) return;
    const original = window.renderCart;
    const wrapped = function () {
      const result = original.apply(this, arguments);
      try { normalizeOrderTable(); normalizeOrderButtons(); } catch (_) {}
      return result;
    };
    wrapped.__v455 = true;
    window.renderCart = wrapped;
  }

  function showVersion() {
    document.title = 'Buscador de Materiales SAP V45.5';
  }

  function apply() {
    addStyles();
    wrapRenderCart();
    normalizeOrderButtons();
    normalizeOrderTable();
    hookMultiAdd();
    showVersion();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
  window.addEventListener('pageshow', () => setTimeout(apply, 50));
  setInterval(() => { normalizeOrderButtons(); normalizeOrderTable(); }, 1200);
})();
