(function () {
  'use strict';

  function escHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  window.bmGetCurrentOperator = function () {
    try {
      const raw = sessionStorage.getItem('bm_user_session_v1') || localStorage.getItem('bm_user_session_v1');
      if (raw) {
        const u = JSON.parse(raw);
        if (u && u.username) {
          return {
            username: String(u.username).trim().toUpperCase(),
            fullName: String(u.fullName || u.username).trim(),
            role: u.role === 'admin' ? 'admin' : 'user'
          };
        }
      }
    } catch (_) {}
    return { username: 'SISTEMA', fullName: 'Sistema', role: 'user' };
  };

  window.bmFormatOperatorBadge = function (username, fullName) {
    const u = String(username || '').trim();
    if (!u) return '<span style="color:var(--muted)">---</span>';
    const title = fullName ? ' title="' + escHtml(fullName) + '"' : '';
    return '<span class="v47-op-badge"' + title + '>' + escHtml(u) + '</span>';
  };

  // Estado de filtros de auditoría
  const auditFilter = {
    query: '',
    event: 'ALL',
    from: '',
    to: ''
  };

  function getFilteredAuditLogs(logs) {
    const list = Array.isArray(logs) ? logs : [];
    const q = String(auditFilter.query || '').trim().toLowerCase();
    const ev = String(auditFilter.event || 'ALL');
    const from = String(auditFilter.from || '').trim();
    const to = String(auditFilter.to || '').trim();

    return list.filter(function (l) {
      if (!l) return false;
      if (ev !== 'ALL' && String(l.event || '') !== ev) return false;
      const day = String(l.timestamp || '').slice(0, 10);
      if (from && day && day < from) return false;
      if (to && day && day > to) return false;
      if (q) {
        const hay = [l.username, l.fullName, l.event, l.detail, l.actor, l.device]
          .map(function (x) { return String(x || '').toLowerCase(); })
          .join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  window.bmExportAuditLogsExcel = function (logs) {
    const filtered = getFilteredAuditLogs(logs);
    if (!window.XLSX) {
      if (typeof window.msg === 'function') window.msg('No se cargó el generador de Excel.', true);
      return;
    }
    if (!filtered.length) {
      if (typeof window.msg === 'function') window.msg('No hay eventos de acceso para exportar con los filtros actuales.', true);
      return;
    }
    const rows = filtered.map(function (l) {
      return {
        'FECHA Y HORA': l.timestamp ? new Date(l.timestamp).toLocaleString('es-PE') : '',
        'EVENTO': l.event || '',
        'USUARIO': l.username || '',
        'NOMBRE': l.fullName || '',
        'ROL': l.role || '',
        'DETALLE': l.detail || '',
        'EJECUTADO POR': l.actor || '',
        'DISPOSITIVO': l.device || ''
      };
    });
    const headers = ['FECHA Y HORA', 'EVENTO', 'USUARIO', 'NOMBRE', 'ROL', 'DETALLE', 'EJECUTADO POR', 'DISPOSITIVO'];
    const ws = window.XLSX.utils.json_to_sheet(rows, { header: headers });
    ws['!cols'] = [22, 20, 16, 24, 14, 40, 18, 22].map(function (wch) { return { wch: wch }; });
    ws['!autofilter'] = { ref: 'A1:H' + (rows.length + 1) };
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'HISTORIAL ACCESOS');
    window.XLSX.writeFile(wb, 'Historial_Accesos_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    if (typeof window.msg === 'function') window.msg('✅ Historial de accesos exportado a Excel (' + rows.length + ' eventos).');
  };

  window.bmRenderAuditLogsSection = function (logs) {
    const all = Array.isArray(logs) ? logs : [];
    const filtered = getFilteredAuditLogs(all);
    const events = [
      'INICIO_SESION', 'INTENTO_FALLIDO', 'CIERRE_SESION', 'CIERRE_INACTIVIDAD',
      'CREAR_USUARIO', 'ACTUALIZAR_USUARIO', 'CAMBIO_CLAVE', 'ELIMINAR_USUARIO', 'CONFIG_SEGURIDAD'
    ];

    const rowsHtml = filtered.length
      ? filtered.slice(0, 150).map(function (l) {
          const when = l.timestamp ? new Date(l.timestamp).toLocaleString('es-PE') : '';
          const ev = String(l.event || '');
          const evBadge = ev === 'INICIO_SESION'
            ? '<span class="v46-status-pill ok">🔓 INICIO SESIÓN</span>'
            : (ev === 'INTENTO_FALLIDO' || ev === 'CIERRE_INACTIVIDAD'
              ? '<span class="v46-status-pill off">⚠️ ' + escHtml(ev) + '</span>'
              : '<span class="v46-status-pill warn">📝 ' + escHtml(ev) + '</span>');
          return '<tr>' +
            '<td class="small" style="white-space:nowrap">' + escHtml(when) + '</td>' +
            '<td>' + evBadge + '</td>' +
            '<td><strong>' + escHtml(l.username || '') + '</strong>' + (l.fullName ? '<div class="small" style="color:var(--muted)">' + escHtml(l.fullName) + '</div>' : '') + '</td>' +
            '<td class="small">' + escHtml(l.detail || '') + '</td>' +
            '<td class="small">' + escHtml(l.actor || '') + '</td>' +
            '<td class="small" style="color:var(--muted)">' + escHtml(l.device || '') + '</td>' +
          '</tr>';
        }).join('')
      : '<tr><td colspan="6" style="text-align:center;padding:18px;color:var(--muted)">No hay eventos que coincidan con los filtros seleccionados.</td></tr>';

    return '<div class="v46-card-panel" style="margin-bottom:0">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
        '<h3 style="margin:0">📜 Historial de Inicios de Sesión y Cambios (Google Drive) <span class="badge">' + filtered.length + ' / ' + all.length + '</span></h3>' +
        '<button type="button" class="btn secondary" id="v47ExportAuditExcelBtn" style="font-weight:700">📊 Exportar accesos a Excel</button>' +
      '</div>' +
      '<div class="v47-audit-filters">' +
        '<input type="search" id="v47AuditSearch" placeholder="🔍 Filtrar por usuario, nombre, detalle o dispositivo..." value="' + escHtml(auditFilter.query) + '"/>' +
        '<select id="v47AuditEvent">' +
          '<option value="ALL"' + (auditFilter.event === 'ALL' ? ' selected' : '') + '>Todos los eventos</option>' +
          events.map(function (ev) {
            return '<option value="' + escHtml(ev) + '"' + (auditFilter.event === ev ? ' selected' : '') + '>' + escHtml(ev) + '</option>';
          }).join('') +
        '</select>' +
        '<input type="date" id="v47AuditFrom" value="' + escHtml(auditFilter.from) + '" title="Fecha desde"/>' +
        '<input type="date" id="v47AuditTo" value="' + escHtml(auditFilter.to) + '" title="Fecha hasta"/>' +
        ((auditFilter.query || auditFilter.event !== 'ALL' || auditFilter.from || auditFilter.to)
          ? '<button type="button" class="btn secondary" id="v47AuditClearBtn">🧹 Limpiar</button>'
          : '') +
      '</div>' +
      '<div class="v46-users-table-wrap" style="max-height:340px;overflow-y:auto">' +
        '<table class="v46-users-table">' +
          '<thead><tr><th>Fecha y hora</th><th>Evento</th><th>Usuario</th><th>Detalle</th><th>Ejecutado por</th><th>Dispositivo</th></tr></thead>' +
          '<tbody>' + rowsHtml + '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';
  };

  window.bmBindAuditFilterEvents = function (onRerender, getLogs) {
    const qEl = document.getElementById('v47AuditSearch');
    const evEl = document.getElementById('v47AuditEvent');
    const fromEl = document.getElementById('v47AuditFrom');
    const toEl = document.getElementById('v47AuditTo');
    const clearEl = document.getElementById('v47AuditClearBtn');
    const expEl = document.getElementById('v47ExportAuditExcelBtn');

    if (qEl) {
      qEl.addEventListener('input', function (e) {
        auditFilter.query = e.target.value;
        const pos = e.target.selectionStart || 0;
        onRerender();
        const next = document.getElementById('v47AuditSearch');
        if (next) {
          next.focus();
          try { next.setSelectionRange(pos, pos); } catch (_) {}
        }
      });
    }
    if (evEl) evEl.addEventListener('change', function (e) { auditFilter.event = e.target.value; onRerender(); });
    if (fromEl) fromEl.addEventListener('change', function (e) { auditFilter.from = e.target.value; onRerender(); });
    if (toEl) toEl.addEventListener('change', function (e) { auditFilter.to = e.target.value; onRerender(); });
    if (clearEl) {
      clearEl.addEventListener('click', function () {
        auditFilter.query = '';
        auditFilter.event = 'ALL';
        auditFilter.from = '';
        auditFilter.to = '';
        onRerender();
      });
    }
    if (expEl) {
      expEl.addEventListener('click', function () {
        window.bmExportAuditLogsExcel(typeof getLogs === 'function' ? getLogs() : []);
      });
    }
  };

  // Control automático de cierre por inactividad
  let inactivityTimer = null;
  let warningTimer = null;
  let lastActivityAt = Date.now();
  let watcherInitialized = false;
  let timeoutMinutes = 30;
  let onTimeoutCallback = null;

  function clearInactivityTimers() {
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    if (warningTimer) { clearTimeout(warningTimer); warningTimer = null; }
  }

  function scheduleInactivityTimers() {
    clearInactivityTimers();
    if (!document.body.classList.contains('bm-authenticated')) return;
    const mins = Number(timeoutMinutes) || 0;
    if (mins <= 0) return;
    const totalMs = mins * 60 * 1000;
    if (totalMs > 70000) {
      warningTimer = setTimeout(function () {
        if (document.body.classList.contains('bm-authenticated') && typeof window.msg === 'function') {
          window.msg('⏳ Sesión inactiva: se cerrará en 1 minuto por seguridad.', true);
        }
      }, totalMs - 60000);
    }
    inactivityTimer = setTimeout(function () {
      if (document.body.classList.contains('bm-authenticated') && typeof onTimeoutCallback === 'function') {
        onTimeoutCallback();
      }
    }, totalMs);
  }

  function recordActivity() {
    const now = Date.now();
    if (now - lastActivityAt < 4000) return;
    lastActivityAt = now;
    scheduleInactivityTimers();
  }

  window.bmConfigureInactivityWatcher = function (minutes, onTimeout) {
    timeoutMinutes = Math.max(0, Number(minutes) || 0);
    if (typeof onTimeout === 'function') onTimeoutCallback = onTimeout;
    if (!watcherInitialized) {
      watcherInitialized = true;
      ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (evName) {
        window.addEventListener(evName, recordActivity, { passive: true, capture: true });
      });
    }
    lastActivityAt = Date.now();
    scheduleInactivityTimers();
  };
})();
