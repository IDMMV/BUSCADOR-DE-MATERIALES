const CONFIG = {
  ACCESS_TOKEN: 'CAMBIA_ESTA_CLAVE',
  FOLDER_NAME: 'Buscador Materiales SAP',
  SPREADSHEET_NAME: 'Base Buscador Materiales SAP'
};

function doGet(e) {
  try {
    e = e || { parameter: {} };
    const params = e.parameter || {};
    validateToken_(params.token);
    const action = params.action || 'ping';

    if (action === 'getAll') {
      const backup = readLatestBackup_();
      const stock = readStockFromSheets_();
      const data = Object.assign({}, backup || {});
      // Google Sheets es la fuente oficial del stock compartido.
      if (stock.stockRows && stock.stockRows.length) {
        data.stockRows = stock.stockRows;
        data.stockMeta = stock.stockMeta;
      }
      return json_({ ok: true, data: data, serverTime: new Date().toISOString() });
    }

    if (action === 'getStock') {
      return json_({ ok: true, data: readStockFromSheets_(), serverTime: new Date().toISOString() });
    }

    return json_({ ok: true, message: 'Google Apps Script activo y conectado', now: new Date().toISOString() });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    try {
      let req = {};
      if (e && e.postData && e.postData.contents) {
        try {
          req = JSON.parse(e.postData.contents);
        } catch (pe) {
          req = {};
        }
      } else if (e && e.parameter && e.parameter.data) {
        try {
          req = JSON.parse(e.parameter.data);
        } catch (_) {}
      }

      validateToken_(req.token);

      if (req.action === 'replaceStock') {
        const rows = Array.isArray(req.stockRows) ? req.stockRows : [];
        const meta = req.stockMeta || {};
        replaceStock_(rows, meta);
        SpreadsheetApp.flush();
        const verified = readStockFromSheets_();
        return json_({
          ok: true,
          savedAt: new Date().toISOString(),
          stockRows: verified.stockRows.length,
          stockDate: verified.stockMeta.date || '',
          stockFile: verified.stockMeta.file || '',
          stockRevision: verified.stockMeta.revision || ''
        });
      }

      if (req.action === 'saveImage') {
        const code = String(req.code || '').trim();
        const dataUrl = String(req.image || '').trim();
        if (!code || !dataUrl.startsWith('data:image/')) {
          throw new Error('Código de material o imagen inválida.');
        }
        const savedImg = saveSingleImageToDrive_(code, dataUrl);
        updateMaterialImageInBackupAndSheet_(code, dataUrl, savedImg);
        return json_({
          ok: true,
          savedAt: new Date().toISOString(),
          code: code,
          fileId: savedImg.fileId,
          name: savedImg.name,
          url: savedImg.url,
          directUrl: savedImg.directUrl
        });
      }

      if (req.action === 'deleteImage') {
        const code = String(req.code || '').trim();
        if (!code) throw new Error('Código de material requerido.');
        deleteMaterialImageFromDrive_(code);
        updateMaterialImageInBackupAndSheet_(code, '', null);
        return json_({
          ok: true,
          savedAt: new Date().toISOString(),
          code: code
        });
      }

      if (req.action === 'syncAll') {
        const data = req.data || {};
        // Si no vienen stockRows o vienen vacíos, conservar el stock existente en Sheets
        if (!Array.isArray(data.stockRows) || data.stockRows.length === 0) {
          const existingStock = readStockFromSheets_();
          if (existingStock.stockRows && existingStock.stockRows.length) {
            data.stockRows = existingStock.stockRows;
            data.stockMeta = existingStock.stockMeta;
          } else {
            data.stockRows = [];
          }
        }
        const imgMap = saveImages_(data.app && data.app.materials || []);
        if (data.app && Array.isArray(data.app.materials)) {
          data.app.materials.forEach(m => {
            if (!m) return;
            const info = imgMap[String(m.code || '').trim()];
            if (info) {
              m.driveFileId = info.fileId || m.driveFileId || '';
              m.driveUrl = info.directUrl || m.driveUrl || '';
              m._imagePendingDrive = false;
            }
          });
        }
        saveBackup_(data);
        writeSheets_(data, imgMap);
        SpreadsheetApp.flush();
        const verified = readStockFromSheets_();
        return json_({
          ok: true,
          savedAt: new Date().toISOString(),
          stockRows: verified.stockRows.length,
          stockDate: verified.stockMeta.date || '',
          stockFile: verified.stockMeta.file || '',
          stockRevision: verified.stockMeta.revision || '',
          imagesSynced: Object.keys(imgMap).length
        });
      }

      throw new Error('Acción no reconocida: ' + (req.action || 'vacío'));
    } catch (err) {
      return json_({ ok: false, error: String(err.message || err) });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function setup() {
  const props = PropertiesService.getScriptProperties();
  const currentId = props.getProperty('SPREADSHEET_ID');
  if (currentId) {
    try {
      const current = SpreadsheetApp.openById(currentId);
      return 'Base vinculada: ' + current.getUrl();
    } catch (_) {
      props.deleteProperty('SPREADSHEET_ID');
    }
  }
  const folder = getFolder_();
  const files = folder.getFilesByName(CONFIG.SPREADSHEET_NAME);
  let chosen = null;
  while (files.hasNext()) {
    const file = files.next();
    if (!chosen || file.getLastUpdated().getTime() > chosen.getLastUpdated().getTime()) chosen = file;
  }
  if (chosen) {
    props.setProperty('SPREADSHEET_ID', chosen.getId());
    return 'Base vinculada: ' + SpreadsheetApp.openById(chosen.getId()).getUrl();
  }
  const ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
  const file = DriveApp.getFileById(ss.getId());
  folder.addFile(file);
  try { DriveApp.getRootFolder().removeFile(file); } catch (_) {}
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return 'Configuración creada: ' + ss.getUrl();
}

function validateToken_(token) {
  const expected = CONFIG.ACCESS_TOKEN;
  if (!token) {
    throw new Error('Falta la clave de acceso (token).');
  }
  if (token !== expected) {
    throw new Error('Clave de acceso incorrecta.');
  }
}

function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('FOLDER_ID');
  if (saved) {
    try { return DriveApp.getFolderById(saved); } catch (_) { props.deleteProperty('FOLDER_ID'); }
  }
  const it = DriveApp.getFoldersByName(CONFIG.FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (_) { props.deleteProperty('SPREADSHEET_ID'); }
  }
  setup();
  const newId = props.getProperty('SPREADSHEET_ID');
  if (!newId) throw new Error('No se pudo vincular la base central de Google Sheets');
  return SpreadsheetApp.openById(newId);
}

function replaceStock_(rows, meta) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSpreadsheet_();
    writeTable_(ss,'StockMeta',['FECHA_STOCK','ARCHIVO','CARGADO_EN','REGISTROS','REVISION'],[[
      meta.date || '', meta.file || '', meta.loadedAt || new Date().toISOString(), rows.length, meta.revision || ''
    ]]);
    writeTable_(ss,'Stock',['MATERIAL','CENTRO','ALMACEN','LOTE','LIBRE','UNIDAD','TEXTO'],rows.map(x=>[
      x.material,x.centro,x.almacen,x.lote,Number(x.libre)||0,x.unidad,x.texto
    ]));
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function saveBackup_(data) {
  try {
    const folder=getFolder_(), name='respaldo_actual.json';
    const old=folder.getFilesByName(name);
    while(old.hasNext()) old.next().setTrashed(true);
    folder.createFile(name, JSON.stringify(data), MimeType.PLAIN_TEXT);
    const it=folder.getFoldersByName('respaldos');
    const backups=it.hasNext()?it.next():folder.createFolder('respaldos');
    const dated='respaldo_'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd_HHmmss')+'.json';
    backups.createFile(dated,JSON.stringify(data),MimeType.PLAIN_TEXT);
  } catch (e) {
    Logger.log('Error en saveBackup_: ' + e);
  }
}

function readLatestBackup_() {
  try {
    const files=getFolder_().getFilesByName('respaldo_actual.json');
    if (!files.hasNext()) return {};
    return JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
  } catch(e) {
    Logger.log('Error leyendo respaldo: ' + e);
    return {};
  }
}

function readStockFromSheets_() {
  const ss=getSpreadsheet_();
  const stockSheet=ss.getSheetByName('Stock');
  const metaSheet=ss.getSheetByName('StockMeta');
  const stockRows=[];
  let stockMeta={};
  if (stockSheet && stockSheet.getLastRow()>1) {
    const vals=stockSheet.getRange(2,1,stockSheet.getLastRow()-1,7).getValues();
    vals.forEach(r=>{
      if (!r[0]) return;
      stockRows.push({
        material:String(r[0]).replace(/\.0$/,''),
        centro:String(r[1]),
        almacen:String(r[2]),
        lote:String(r[3]),
        libre:Number(r[4])||0,
        unidad:String(r[5]),
        texto:String(r[6])
      });
    });
  }
  if (metaSheet && metaSheet.getLastRow()>1) {
    const r=metaSheet.getRange(2,1,1,5).getValues()[0];
    stockMeta={
      date:normalizeDate_(r[0]),
      file:String(r[1]||''),
      loadedAt:normalizeDateTime_(r[2]),
      records:Number(r[3])||stockRows.length,
      revision:String(r[4]||''),
      source:'GOOGLE_DRIVE'
    };
  }
  return {stockRows:stockRows,stockMeta:stockMeta};
}

function normalizeDate_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'America/Lima', 'yyyy-MM-dd');
  }
  const text=String(value).trim();
  const iso=text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1]+'-'+iso[2]+'-'+iso[3];
  const latam=text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (latam) return latam[3]+'-'+latam[2].padStart(2,'0')+'-'+latam[1].padStart(2,'0');
  return text;
}

function normalizeDateTime_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'America/Lima', "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  return String(value);
}

function writeSheets_(data, precomputedImgMap) {
  const ss=getSpreadsheet_();
  let imgMap = precomputedImgMap || {};
  if (!precomputedImgMap) {
    try {
      imgMap = saveImages_(data.app && data.app.materials || []);
    } catch(_) {}
  }

  writeTable_(ss,'Materiales',['MATRICULA','DESCRIPCION','UNIDAD','PRIORIDAD','ALIAS','IMAGEN_ESTADO','LINK_IMAGEN_DRIVE','ACTUALIZADO'],(data.app&&data.app.materials||[]).map(m=>{
    const imgInfo = imgMap[m.code] || {};
    const hasImg = Boolean((m.image && String(m.image).length > 20) || m.driveUrl || imgInfo.url);
    const link = imgInfo.url ? imgInfo.url : (m.driveUrl ? m.driveUrl : (m.image ? 'En respaldo JSON' : 'SIN IMAGEN'));
    return [m.code,m.description,m.unit,m.priority||'',(m.aliases||[]).join(' | '),hasImg?'SI':'NO',link,new Date()];
  }));
  const initials=(data.app&&data.app.supervisorInitials)||{};
  writeTable_(ss,'Supervisores',['NOMBRE','INICIALES'],(data.app&&data.app.supervisors||[]).map(x=>[x,initials[x]||'']));
  writeTable_(ss,'Unidades',['UNIDAD'],(data.app&&data.app.units||[]).map(x=>[x]));
  writeTable_(ss,'StockMeta',['FECHA_STOCK','ARCHIVO','CARGADO_EN','REGISTROS','REVISION'],[[data.stockMeta&&data.stockMeta.date||'',data.stockMeta&&data.stockMeta.file||'',data.stockMeta&&data.stockMeta.loadedAt||'',(data.stockRows||[]).length,data.stockMeta&&data.stockMeta.revision||'']]);
  writeTable_(ss,'Stock',['MATERIAL','CENTRO','ALMACEN','LOTE','LIBRE','UNIDAD','TEXTO'],(data.stockRows||[]).map(x=>[x.material,x.centro,x.almacen,x.lote,x.libre,x.unidad,x.texto]));
  const history=(data.app&&data.app.orderHistory||[]);
  const controlEdits = (data.app && data.app.controlEdits) || {};
  const isFinalized_ = (x) => Boolean(x && (x.guardadoEnHistorial || x.reservaGuardada));

  const detailRows=[];
  history.forEach(x=>{
    if (!isFinalized_(x)) return;
    const resVal = String(x.reserva || '').trim();
    const condVal = String(x.conductor || '').trim();
    (x.items||[]).forEach(i=>detailRows.push([
      x.id, (i.reserva || resVal || ''), x.om||'', x.fecha, x.supervisor, condVal, i.code||'', i.description||'', i.qty||0, i.unit||'',
      x.centro, i.warehouse||'', i.lot||'', x.unidadRecojo||'', x.alimentador||'', x.distrito||'',
      x.movimiento||'', x.unidadRecupero||'', x.status||'', x.createdAt||''
    ]));
  });
  writeTable_(ss,'HistorialMateriales',['PEDIDO','RESERVA','OM','FECHA','RETIRADO_POR','CONDUCTOR','MATRICULA','DESCRIPCION','CANTIDAD','UNIDAD','CENTRO','ALMACEN','LOTE','UNIDAD_RECOJO','ALIMENTADOR','DISTRITO_DESTINO','MOVIMIENTO','UNIDAD_RECUPERO','STATUS','CREADO_EN'],detailRows);

  writeTable_(ss,'ControlSolicitudes',['PEDIDO','RESERVA','OM','FECHA','SUPERVISOR','CONDUCTOR','CENTRO','UNIDAD_RECOJO','ALIMENTADOR','DISTRITO','MOVIMIENTO','UNIDAD_RECUPERO','STATUS','CANTIDAD_TOTAL','ESTADO','CREADO_EN'],history.filter(isFinalized_).map(x=>[
    x.id, x.reserva||'', x.om||'', x.fecha, x.supervisor, x.conductor||'', x.centro, x.unidadRecojo||'', x.alimentador||'', x.distrito||'', x.movimiento||'', x.unidadRecupero||'', x.status||'', x.total||0, 'FINALIZADO', x.createdAt||''
  ]));

  const reservasEdits = (data.app && data.app.reservasEdits) || {};
  const reservasRows = [];
  history.forEach((order, orderIdx) => {
    const mov = String(order.movimiento || '').toUpperCase();
    if (mov === 'DEVOLUCION' || isFinalized_(order)) return;
    const orderKey = String(order.id || (order.om ? (order.om + '_' + String(order.centro || '') + '_' + String(order.createdAt || '')) : ('order_' + orderIdx)));
    const orderEdit = controlEdits[orderKey] || {};
    const orderReserva = orderEdit.reserva !== undefined ? orderEdit.reserva : (order.reserva || '');
    const orderRecojo = orderEdit.unidadRecojo !== undefined ? orderEdit.unidadRecojo : (order.unidadRecojo || '');
    const orderConductor = orderEdit.conductor !== undefined ? orderEdit.conductor : (order.conductor || '');
    const orderStatus = orderEdit.status !== undefined ? orderEdit.status : (order.status || (mov === 'RECUPERO' ? 'RECUPERO' : 'PROGRAMADO'));
    const orderRecupero = orderEdit.unidadRecupero !== undefined ? orderEdit.unidadRecupero : (order.unidadRecupero || (mov === 'RECUPERO' ? (order.unidadRecojo || '') : ''));
    const items = Array.isArray(order.items) && order.items.length ? order.items : [{
      code: '', description: mov === 'RECUPERO' ? 'Recupero' : (mov === 'PEDIDO' ? 'Pedido' : 'Reserva general'), qty: order.total || 0, unit: 'UND', reserva: orderReserva
    }];

    items.forEach((item, itemIdx) => {
      const itemKey = `${orderKey}_item_${itemIdx}_${item.code || item.MATRICULA || 'mat'}`;
      const itemEdit = reservasEdits[itemKey] || {};
      const reservaVal = itemEdit.reserva !== undefined ? itemEdit.reserva : (orderReserva || item.reserva || '');
      const qtyVal = itemEdit.qty !== undefined ? Number(itemEdit.qty) : Number(item.qty || item.CANT || 0);
      reservasRows.push([
        reservaVal,
        String(order.centro || '').replace(/[^0-9]/g, '') || String(order.centro || ''),
        order.supervisor || '',
        order.om || '',
        order.fecha || '',
        orderRecojo,
        orderConductor,
        String(order.alimentador || '').toUpperCase(),
        String(order.distrito || '').toUpperCase(),
        orderStatus,
        orderRecupero,
        item.code || item.MATRICULA || '',
        item.description || item.DESCRIPCION || '',
        qtyVal,
        item.unit || item.UNIDAD || 'UND',
        mov,
        order.createdAt || ''
      ]);
    });
  });
  writeTable_(ss, 'ControlReservas', ['RESERVA', 'ALMACEN', 'ENCARGADO', 'OM', 'FECHA PEDIDO', 'UNIDAD (RECOJO)', 'CONDUCTOR', 'ALIM.', 'DISTRITO', 'STATUS', 'UNIDAD (RECUPERO)', 'MATRÍCULA', 'DESCRIPCIÓN', 'CANTIDAD', 'UNIDAD', 'MOVIMIENTO', 'CREADO_EN'], reservasRows);
}

function writeTable_(ss,name,headers,rows) {
  let sh=ss.getSheetByName(name);
  if(!sh) sh=ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#d9eaf7');
  if(rows && rows.length) {
    sh.getRange(2,1,rows.length,headers.length).setValues(rows);
  }
  sh.setFrozenRows(1);
}

function getImagesFolder_() {
  const folder = getFolder_();
  const it = folder.getFoldersByName('imagenes_materiales');
  return it.hasNext() ? it.next() : folder.createFolder('imagenes_materiales');
}

function saveSingleImageToDrive_(code, dataUrl) {
  const imgs = getImagesFolder_();
  const parts = String(dataUrl).split(',');
  const mimeMatch = parts[0].match(/data:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/webp';
  const bytes = Utilities.base64Decode(parts[1]);
  const ext = mime.indexOf('webp') >= 0 ? 'webp' : (mime.indexOf('png') >= 0 ? 'png' : 'jpg');
  const name = code + '.' + ext;

  // Eliminar copias anteriores del mismo código para evitar duplicados u obsoletas
  ['webp', 'jpg', 'jpeg', 'png'].forEach(oldExt => {
    const olds = imgs.getFilesByName(code + '.' + oldExt);
    while (olds.hasNext()) {
      try { olds.next().setTrashed(true); } catch(_) {}
    }
  });

  const file = imgs.createFile(Utilities.newBlob(bytes, mime, name));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(_) {}
  const fileId = file.getId();
  return {
    name: name,
    fileId: fileId,
    url: file.getUrl(),
    directUrl: 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1000'
  };
}

function deleteMaterialImageFromDrive_(code) {
  const imgs = getImagesFolder_();
  ['webp', 'jpg', 'jpeg', 'png'].forEach(ext => {
    const olds = imgs.getFilesByName(code + '.' + ext);
    while (olds.hasNext()) {
      try { olds.next().setTrashed(true); } catch(_) {}
    }
  });
}

function updateMaterialImageInBackupAndSheet_(code, dataUrl, savedImg) {
  try {
    const backup = readLatestBackup_();
    if (backup && backup.app && Array.isArray(backup.app.materials)) {
      const m = backup.app.materials.find(x => String(x.code || '').trim() === code);
      if (m) {
        m.image = dataUrl || '';
        m.driveFileId = savedImg ? savedImg.fileId : '';
        m.driveUrl = savedImg ? savedImg.directUrl : '';
        m._imagePendingDrive = false;
        backup.updatedAt = new Date().toISOString();
        saveBackup_(backup);
      }
    }
  } catch (e) {
    Logger.log('Error actualizando backup con imagen: ' + e);
  }
}

function saveImages_(materials) {
  const imgs = getImagesFolder_();
  const imgMap = {};

  // Indexar archivos existentes en imagenes_materiales en una sola lectura
  const existingByCode = {};
  try {
    const allFiles = imgs.getFiles();
    while (allFiles.hasNext()) {
      const f = allFiles.next();
      const fname = f.getName();
      const baseCode = fname.replace(/\.(webp|jpg|jpeg|png)$/i, '');
      existingByCode[baseCode] = f;
    }
  } catch(_) {}

  const list = Array.isArray(materials) ? materials : [];
  let uploadedCount = 0;

  list.forEach(m => {
    if (!m || !m.code) return;
    const code = String(m.code).trim();
    const existing = existingByCode[code];

    if (m.image && String(m.image).startsWith('data:image/')) {
      const needsUpload = Boolean(m._imagePendingDrive) || !existing;
      if (!needsUpload && existing) {
        const fid = existing.getId();
        imgMap[code] = {
          name: existing.getName(),
          fileId: fid,
          url: existing.getUrl(),
          directUrl: 'https://drive.google.com/thumbnail?id=' + fid + '&sz=w1000'
        };
        return;
      }
      if (uploadedCount < 25) {
        try {
          imgMap[code] = saveSingleImageToDrive_(code, m.image);
          uploadedCount++;
        } catch (err) {
          Logger.log('Error guardando imagen de ' + code + ': ' + err);
        }
      }
    } else if (existing) {
      const fid = existing.getId();
      imgMap[code] = {
        name: existing.getName(),
        fileId: fid,
        url: existing.getUrl(),
        directUrl: 'https://drive.google.com/thumbnail?id=' + fid + '&sz=w1000'
      };
    } else if (m.driveUrl) {
      imgMap[code] = {
        name: code + '.webp',
        fileId: m.driveFileId || '',
        url: m.driveUrl,
        directUrl: m.driveUrl
      };
    }
  });
  return imgMap;
}

function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
