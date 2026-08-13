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
      saveBackup_(data);
      writeSheets_(data);
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

    throw new Error('Acción no reconocida: ' + (req.action || 'vacío'));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
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

function writeSheets_(data) {
  const ss=getSpreadsheet_();
  let imgMap = {};
  try {
    imgMap = saveImages_(data.app && data.app.materials || []);
  } catch(_) {}

  writeTable_(ss,'Materiales',['MATRICULA','DESCRIPCION','UNIDAD','PRIORIDAD','ALIAS','IMAGEN_ESTADO','LINK_IMAGEN_DRIVE','ACTUALIZADO'],(data.app&&data.app.materials||[]).map(m=>{
    const imgInfo = imgMap[m.code] || {};
    const link = imgInfo.url ? imgInfo.url : (m.image ? 'En respaldo JSON' : 'SIN IMAGEN');
    return [m.code,m.description,m.unit,m.priority||'',(m.aliases||[]).join(' | '),m.image?'SI':'NO',link,new Date()];
  }));
  const initials=(data.app&&data.app.supervisorInitials)||{};
  writeTable_(ss,'Supervisores',['NOMBRE','INICIALES'],(data.app&&data.app.supervisors||[]).map(x=>[x,initials[x]||'']));
  writeTable_(ss,'Unidades',['UNIDAD'],(data.app&&data.app.units||[]).map(x=>[x]));
  writeTable_(ss,'StockMeta',['FECHA_STOCK','ARCHIVO','CARGADO_EN','REGISTROS','REVISION'],[[data.stockMeta&&data.stockMeta.date||'',data.stockMeta&&data.stockMeta.file||'',data.stockMeta&&data.stockMeta.loadedAt||'',(data.stockRows||[]).length,data.stockMeta&&data.stockMeta.revision||'']]);
  writeTable_(ss,'Stock',['MATERIAL','CENTRO','ALMACEN','LOTE','LIBRE','UNIDAD','TEXTO'],(data.stockRows||[]).map(x=>[x.material,x.centro,x.almacen,x.lote,x.libre,x.unidad,x.texto]));
  const history=(data.app&&data.app.orderHistory||[]);
  const detailRows=[];
  history.forEach(x=>(x.items||[]).forEach(i=>detailRows.push([
    x.id,x.om||'',x.fecha,x.supervisor,i.code||'',i.description||'',i.qty||0,i.unit||'',
    x.centro,i.warehouse||'',i.lot||'',x.unidadRecojo||'',x.alimentador||'',x.distrito||'',
    x.movimiento||'',x.createdAt||''
  ])));
  writeTable_(ss,'HistorialMateriales',['PEDIDO','OM','FECHA','RETIRADO_POR','MATRICULA','DESCRIPCION','CANTIDAD','UNIDAD','CENTRO','ALMACEN','LOTE','UNIDAD_RECOJO','ALIMENTADOR','DISTRITO_DESTINO','MOVIMIENTO','CREADO_EN'],detailRows);
  writeTable_(ss,'ControlSolicitudes',['PEDIDO','OM','FECHA','SUPERVISOR','CENTRO','UNIDAD_RECOJO','ALIMENTADOR','DISTRITO','MOVIMIENTO','CANTIDAD_TOTAL','ESTADO','CREADO_EN'],history.map(x=>[x.id,x.om||'',x.fecha,x.supervisor,x.centro,x.unidadRecojo||'',x.alimentador||'',x.distrito||'',x.movimiento||'',x.total||0,'FINALIZADO',x.createdAt||'']));
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

function saveImages_(materials) {
  const folder=getFolder_();
  const it=folder.getFoldersByName('imagenes_materiales');
  const imgs=it.hasNext()?it.next():folder.createFolder('imagenes_materiales');
  const imgMap = {};
  const matsWithImage = materials.filter(m=>m&&m.image&&String(m.image).startsWith('data:image/'));
  // Guardar hasta 20 imágenes por lote para no exceder cuota de tiempo
  matsWithImage.slice(0, 20).forEach(m=>{
    try {
      const parts=m.image.split(','), mime=parts[0].match(/data:(.*?);/)[1], bytes=Utilities.base64Decode(parts[1]), ext=mime.indexOf('webp')>=0?'webp':'jpg', name=m.code+'.'+ext;
      const olds=imgs.getFilesByName(name);
      if (olds.hasNext()) {
        const existing = olds.next();
        imgMap[m.code] = { name: name, url: existing.getUrl() };
        return;
      }
      const file = imgs.createFile(Utilities.newBlob(bytes,mime,name));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      imgMap[m.code] = { name: name, url: file.getUrl() };
    } catch(err) {
      Logger.log('Error guardando imagen de ' + m.code + ': ' + err);
    }
  });
  return imgMap;
}

function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
