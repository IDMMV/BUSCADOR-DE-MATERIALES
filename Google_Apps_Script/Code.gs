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
      const materials = readMaterialsFromSheets_();
      const data = Object.assign({}, backup || {});

      // Google Sheets es la fuente oficial del stock compartido.
      if (stock.stockRows && stock.stockRows.length) {
        data.stockRows = stock.stockRows;
        data.stockMeta = stock.stockMeta;
      }

      // Las imágenes se guardan como archivos reales en Drive y su URL se registra
      // en Sheets. Esto evita depender de data:image/... guardados en el navegador.
      if (materials.length) {
        if (!data.app) data.app = {};
        if (Array.isArray(data.app.materials) && data.app.materials.length) {
          const imageMap = {};
          materials.forEach(m => { imageMap[m.code] = m.image || ''; });
          data.app.materials = data.app.materials.map(m => {
            const driveImage = imageMap[m.code];
            if (driveImage) return Object.assign({}, m, { image: driveImage });
            if (Object.prototype.hasOwnProperty.call(imageMap, m.code) && !driveImage) {
              return Object.assign({}, m, { image: '' });
            }
            return m;
          });
        } else {
          data.app.materials = materials;
        }
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

        // Primero guardamos las imágenes en Drive y convertimos sus data URI
        // locales en URLs compartibles. Luego el respaldo JSON ya queda liviano
        // y portable entre computadoras.
        writeSheets_(data);
        saveBackup_(data);
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
    const json=JSON.stringify(data);
    const old=folder.getFilesByName(name);
    while(old.hasNext()) old.next().setTrashed(true);
    folder.createFile(name, json, MimeType.PLAIN_TEXT);
    const it=folder.getFoldersByName('respaldos');
    const backups=it.hasNext()?it.next():folder.createFolder('respaldos');
    const dated='respaldo_'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd_HHmmss')+'.json';
    backups.createFile(dated,json,MimeType.PLAIN_TEXT);
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

function readMaterialsFromSheets_() {
  const ss=getSpreadsheet_();
  const sh=ss.getSheetByName('Materiales');
  const materials=[];
  if (!sh || sh.getLastRow()<=1) return materials;

  const vals=sh.getRange(2,1,sh.getLastRow()-1,8).getValues();
  vals.forEach(r=>{
    const code=String(r[0]||'').replace(/\.0$/,'').trim();
    if (!code) return;
    const aliases=String(r[4]||'').split('|').map(x=>x.trim()).filter(Boolean);
    const image=String(r[6]||'').trim();
    materials.push({
      code:code,
      description:String(r[1]||''),
      unit:String(r[2]||'UND'),
      priority:String(r[3]||''),
      aliases:aliases,
      image:image && image!=='SIN IMAGEN' && image!=='En respaldo JSON' ? image : '',
      source:'GOOGLE_DRIVE'
    });
  });
  return materials;
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
  const materials=(data.app&&Array.isArray(data.app.materials))?data.app.materials:[];
  let imgMap = {};
  try {
    imgMap = saveImages_(materials);
  } catch(err) {
    Logger.log('Error general guardando imágenes: ' + err);
  }

  // Sustituir data:image/... por una URL central de Drive antes de guardar
  // el respaldo JSON. El navegador seguirá mostrando la imagen usando esa URL.
  materials.forEach(m=>{
    if (!m || !m.code) return;
    const imgInfo=imgMap[m.code];
    if (imgInfo && imgInfo.url) m.image=imgInfo.url;
    else if (m.image && String(m.image).startsWith('data:image/') && !imgInfo) m.image='';
  });

  writeTable_(ss,'Materiales',['MATRICULA','DESCRIPCION','UNIDAD','PRIORIDAD','ALIAS','IMAGEN_ESTADO','LINK_IMAGEN_DRIVE','ACTUALIZADO'],materials.map(m=>{
    const image=String(m.image||'').trim();
    const hasImage=!!image;
    const link=hasImage?image:'SIN IMAGEN';
    return [m.code,m.description,m.unit,m.priority||'',(m.aliases||[]).join(' | '),hasImage?'SI':'NO',link,new Date()];
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

function imageHash_(bytes) {
  const digest=Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes);
  return digest.map(b=>('0'+(b&0xff).toString(16)).slice(-2)).join('');
}

function cleanupImageFiles_(imgs, code, keepName) {
  const prefix=String(code)+'__';
  const candidates=imgs.getFiles();
  while(candidates.hasNext()) {
    const f=candidates.next();
    const name=f.getName();
    if ((name.indexOf(prefix)===0 || name===String(code)+'.webp' || name===String(code)+'.jpg') && name!==keepName) {
      try { f.setTrashed(true); } catch(_) {}
    }
  }
}

function saveImages_(materials) {
  const folder=getFolder_();
  const it=folder.getFoldersByName('imagenes_materiales');
  const imgs=it.hasNext()?it.next():folder.createFolder('imagenes_materiales');
  const imgMap = {};

  // Procesar todas las imágenes, no solo las primeras 20. Cada imagen se identifica
  // por hash para no volver a subirla si no cambió.
  materials.forEach(m=>{
    if (!m || !m.code) return;
    try {
      const image=String(m.image||'');

      if (!image) {
        cleanupImageFiles_(imgs,m.code,'');
        return;
      }

      if (!image.startsWith('data:image/')) {
        imgMap[m.code]={url:image};
        return;
      }

      const comma=image.indexOf(',');
      if (comma<0) throw new Error('Imagen data URI inválida');
      const header=image.slice(0,comma);
      const payload=image.slice(comma+1);
      const mimeMatch=header.match(/data:(.*?);/);
      if (!mimeMatch) throw new Error('MIME de imagen no identificado');
      const mime=mimeMatch[1];
      const bytes=Utilities.base64Decode(payload);
      const hash=imageHash_(bytes);
      const ext=mime.indexOf('png')>=0?'png':mime.indexOf('jpeg')>=0?'jpg':mime.indexOf('gif')>=0?'gif':'webp';
      const name=String(m.code)+'__'+hash+'.'+ext;

      const same=imgs.getFilesByName(name);
      let file;
      if (same.hasNext()) {
        file=same.next();
      } else {
        file=imgs.createFile(Utilities.newBlob(bytes,mime,name));
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      }

      cleanupImageFiles_(imgs,m.code,name);
      // getUrl() abre Drive; para <img> necesitamos una URL de visualización del archivo.
      const viewUrl='https://drive.google.com/uc?export=view&id='+file.getId();
      imgMap[m.code]={name:name,url:viewUrl,id:file.getId()};
    } catch(err) {
      Logger.log('Error guardando imagen de ' + m.code + ': ' + err);
    }
  });
  return imgMap;
}

function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
