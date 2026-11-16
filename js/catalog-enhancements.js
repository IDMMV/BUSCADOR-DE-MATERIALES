(function () {
  'use strict';

  function escHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function extractMaterialSpecs(m) {
    if (!m) return [];
    const desc = String(m.description || '').toUpperCase();
    const badges = [];
    const seen = new Set();

    function pushBadge(label, tone) {
      const clean = String(label || '').trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      badges.push({ label: clean, tone: tone || 'neutral' });
    }

    // 1. Amperaje (Fusibles, Cutouts, Seccionadores)
    const ampMatch = desc.match(/\b(\d{1,4})\s*A\b/);
    if (ampMatch && /FUSIB|CUT|SECC|EXPUL/.test(desc)) {
      pushBadge(ampMatch[1] + ' A', 'amber');
    }

    // 2. Tensión nominal (kV / V)
    const kvMatch = desc.match(/\b(\d+(?:[.,]\d+)?)\s*KV\b/);
    if (kvMatch) {
      pushBadge(kvMatch[1].replace(',', '.') + ' kV', 'blue');
    } else {
      const vMatch = desc.match(/\b(600|750|1000)\s*V\b/);
      if (vMatch) pushBadge(vMatch[1] + ' V', 'blue');
    }

    // 3. Sección / Rango de conductor (MM2 / AWG)
    const rangeMm2 = desc.match(/\b(\d+\s*[-–/]\s*\d+(?:\s*\/\s*\d+\s*[-–]\s*\d+)?)\s*MM2\b/);
    if (rangeMm2) {
      pushBadge(rangeMm2[1].replace(/\s+/g, '') + ' mm²', 'teal');
    } else {
      const singleMm2 = desc.match(/\b(?:1X)?(\d{2,3})\s*MM2\b/);
      if (singleMm2) pushBadge(singleMm2[1] + ' mm²', 'teal');
    }

    // 4. Longitud en pies (Crucetas y Ménsulas)
    const ftMatch = desc.match(/\b(\d+(?:[.,]\d+)?)\s*PIES?\b/);
    if (ftMatch) {
      pushBadge(ftMatch[1].replace(',', '.') + ' pies', 'brown');
    }

    // 5. Medidas de pernos, tirafondos, varillas, arandelas, diagonales
    const inchPair = desc.match(/\b(\d+\/\d+"\s*X\s*(?:\d+\.)?\d+(?:\/\d+)?\"?)/);
    if (inchPair && /PERNO|TIRAFONDO|ARANDELA|OJAL/.test(desc)) {
      pushBadge(inchPair[1].replace(/\s+/g, ' '), 'slate');
    } else {
      const varillaLen = desc.match(/\b(\d{3,4})\s*MML?\b/);
      if (varillaLen && /VARILLA|CANALETA|GRAPA|AISLADOR/.test(desc)) {
        pushBadge(varillaLen[1] + ' mm', 'slate');
      }
      const diagLen = desc.match(/\b(\d+[.,]\d+)\s*M\b/);
      if (diagLen && /DIAGONAL/.test(desc)) {
        pushBadge(diagLen[1].replace(',', '.') + ' m', 'slate');
      }
    }

    // 6. Talla / Color (Guantes, Cintas, Preformados)
    const sizeMatch = desc.match(/\bTALLA\s+(XS|S|M|L|XL|XXL)\b/);
    if (sizeMatch) pushBadge('Talla ' + sizeMatch[1], 'purple');

    const colorMatch = desc.match(/\bCOLOR\s+(BLANCO|NEGRO|ROJO|VERDE|GRIS|AMARILLO)\b|\b(MARRON|ROJO|NARANJA)\b/);
    if (colorMatch) {
      const c = colorMatch[1] || colorMatch[2];
      const toneMap = { ROJO: 'red', VERDE: 'green', NEGRO: 'dark', GRIS: 'slate', NARANJA: 'amber', MARRON: 'brown', BLANCO: 'light' };
      pushBadge(c, toneMap[c] || 'neutral');
    }

    return badges.slice(0, 3);
  }

  window.bmGetMaterialSpecBadges = extractMaterialSpecs;

  window.bmRenderMaterialSpecHtml = function (m) {
    const badges = extractMaterialSpecs(m);
    if (!badges.length) return '';
    return '<div class="v47-spec-chips">' +
      badges.map(function (b) {
        return '<span class="v47-spec-chip tone-' + escHtml(b.tone) + '">' + escHtml(b.label) + '</span>';
      }).join('') +
      '</div>';
  };

  window.bmGetCrossStockAlert = function (code, selectedCenter, requiredQty) {
    try {
      if (typeof stockRows === 'undefined' || !Array.isArray(stockRows) || !stockRows.length) return null;
      if (typeof totalStock !== 'function') return null;

      const s3 = Number(totalStock(code, '1003')) || 0;
      const s4 = Number(totalStock(code, '1004')) || 0;
      const mode = String(selectedCenter || '1003');
      const need = Number(requiredQty) || 0;

      if (s3 <= 0 && s4 <= 0) {
        return {
          level: 'out',
          msg: 'Sin stock disponible en 1003 ni 1004'
        };
      }

      if (mode === '1003' && (s3 <= 0 || (need > 0 && s3 < need))) {
        if (s4 > 0) {
          return {
            level: 'transfer',
            altCenter: '1004',
            altQty: s4,
            msg: (s3 <= 0 ? 'Sin stock en 1003' : 'Stock insuficiente en 1003 (' + s3 + ')') + ' · Hay ' + s4 + ' en 1004 Vitarte'
          };
        }
      }

      if (mode === '1004' && (s4 <= 0 || (need > 0 && s4 < need))) {
        if (s3 > 0) {
          return {
            level: 'transfer',
            altCenter: '1003',
            altQty: s3,
            msg: (s4 <= 0 ? 'Sin stock en 1004' : 'Stock insuficiente en 1004 (' + s4 + ')') + ' · Hay ' + s3 + ' en 1003 San Juan'
          };
        }
      }

      return null;
    } catch (_) {
      return null;
    }
  };

  window.bmSummarizeTemplateStock = function (tpl, globalCenter) {
    try {
      if (!tpl || !Array.isArray(tpl.items) || !tpl.items.length) return '';
      if (typeof stockRows === 'undefined' || !Array.isArray(stockRows) || !stockRows.length) return '';
      if (typeof totalStock !== 'function') return '';
      const cen = String(globalCenter || '1003') === '1004' ? '1004' : '1003';
      const other = cen === '1003' ? '1004' : '1003';
      let lowOrZero = 0;
      let altAvailable = 0;
      tpl.items.forEach(function (it) {
        const target = (it.centerMode === '1003' || it.centerMode === '1004' || it.centerMode === 'both') ? it.centerMode : cen;
        const need = Number(it.qty) || 1;
        const s3 = Number(totalStock(it.code, '1003')) || 0;
        const s4 = Number(totalStock(it.code, '1004')) || 0;
        const avail = target === 'both' ? (s3 + s4) : (target === '1004' ? s4 : s3);
        if (avail < need) {
          lowOrZero++;
          const otherStock = target === '1004' ? s3 : s4;
          if (otherStock >= need) altAvailable++;
        }
      });
      if (!lowOrZero) {
        return '<span class="v47-tpl-stock ok">✓ Stock completo en ' + escHtml(cen) + '</span>';
      }
      return '<span class="v47-tpl-stock warn">⚠ ' + lowOrZero + ' mat. con quiebre en ' + escHtml(cen) +
        (altAvailable ? ' (' + altAvailable + ' disp. en ' + escHtml(other) + ')' : '') + '</span>';
    } catch (_) {
      return '';
    }
  };
})();
