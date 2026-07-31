const CONFIG = {
  ACCESS_TOKEN: 'CAMBIA_ESTA_CLAVE',
  FOLDER_NAME: 'Buscador Materiales SAP',
  SPREADSHEET_NAME: 'Base Buscador Materiales SAP'
};

function doGet(e) {
  try {
    validateToken_(e.parameter.token);
    const action = e.parameter.action || 'ping';
    if (action === 'getAll') return json_({ok:true, data:readLatestBackup_()});
    return json_({ok:true, message:'Apps Script activo', now:new Date().toISOString()});
  } catch (err) { return json_({ok:false,error:String(err.message||err)}); }
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents || '{}');
    validateToken_(req.token);
    if (req.action === 'syncAll') {
      const data = req.data || {};
      saveBackup_(data);
      writeSheets_(data);
      saveImages_(data.app && data.app.materials || []);
      return json_({ok:true, savedAt:new Date().toISOString()});
    }
    throw new Error('Acción no reconocida');
  } catch (err) { return json_({ok:false,error:String(err.message||err)}); }
}

function setup() {
  const folder = getFolder_();
  const files = folder.getFilesByName(CONFIG.SPREADSHEET_NAME);
  if (!files.hasNext()) {
    const ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
    const file = DriveApp.getFileById(ss.getId());
    folder.addFile(file); DriveApp.getRootFolder().removeFile(file);
  }
  return 'Configuración creada: ' + folder.getUrl();
}

function validateToken_(token) {
  if (!token || token !== CONFIG.ACCESS_TOKEN) throw new Error('Clave de acceso incorrecta');
}

function getFolder_() {
  const it = DriveApp.getFoldersByName(CONFIG.FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.FOLDER_NAME);
}

function getSpreadsheet_() {
  const folder=getFolder_(), files=folder.getFilesByName(CONFIG.SPREADSHEET_NAME);
  if (files.hasNext()) return SpreadsheetApp.open(files.next());
  setup(); return getSpreadsheet_();
}

function saveBackup_(data) {
  const folder=getFolder_(), name='respaldo_actual.json';
  const old=folder.getFilesByName(name); while(old.hasNext()) old.next().setTrashed(true);
  folder.createFile(name, JSON.stringify(data), MimeType.PLAIN_TEXT);
  const dated='respaldos/respaldo_'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd_HHmmss')+'.json';
  let backups; const it=folder.getFoldersByName('respaldos'); backups=it.hasNext()?it.next():folder.createFolder('respaldos');
  backups.createFile(dated.split('/').pop(),JSON.stringify(data),MimeType.PLAIN_TEXT);
}

function readLatestBackup_() {
  const files=getFolder_().getFilesByName('respaldo_actual.json');
  if (!files.hasNext()) return {};
  return JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
}

function writeSheets_(data) {
  const ss=getSpreadsheet_();
  writeTable_(ss,'Materiales',['MATRICULA','DESCRIPCION','UNIDAD','PRIORIDAD','ALIAS','IMAGEN_ARCHIVO','ACTUALIZADO'],(data.app&&data.app.materials||[]).map(m=>[m.code,m.description,m.unit,m.priority||'',(m.aliases||[]).join(' | '),m.image?'SI':'',new Date()]));
  const initials=(data.app&&data.app.supervisorInitials)||{};
  writeTable_(ss,'Supervisores',['NOMBRE','INICIALES'],(data.app&&data.app.supervisors||[]).map(x=>[x,initials[x]||'']));
  writeTable_(ss,'Unidades',['UNIDAD'],(data.app&&data.app.units||[]).map(x=>[x]));
  writeTable_(ss,'Pendientes',['MATRICULA','DESCRIPCION','SOLICITADO','PENDIENTE','CENTRO','OTRO_CENTRO','STOCK_CENTRO','STOCK_OTRO','SUPERVISOR','FECHA','MOTIVO','ESTADO'],(data.pending||[]).map(x=>[x.code,x.description,x.requested,x.pendingQty,x.center,x.other,x.availableCurrent,x.availableOther,x.supervisor,x.date,x.reason,x.status]));
  writeTable_(ss,'StockMeta',['FECHA_STOCK','ARCHIVO','CARGADO_EN','REGISTROS'],[[data.stockMeta&&data.stockMeta.date||'',data.stockMeta&&data.stockMeta.file||'',data.stockMeta&&data.stockMeta.loadedAt||'',(data.stockRows||[]).length]]);
  writeTable_(ss,'Stock',['MATERIAL','CENTRO','ALMACEN','LOTE','LIBRE','UNIDAD','TEXTO'],(data.stockRows||[]).map(x=>[x.material,x.centro,x.almacen,x.lote,x.libre,x.unidad,x.texto]));
  writeTable_(ss,'Historial',['PEDIDO','FECHA','SUPERVISOR','OM','CENTRO','UNIDAD_RECOJO','MOVIMIENTO','CANTIDAD_TOTAL','MATERIALES','CREADO_EN'],(data.app&&data.app.orderHistory||[]).map(x=>[x.id,x.fecha,x.supervisor,x.om||'',x.centro,x.unidadRecojo,x.movimiento,x.total,(x.items||[]).map(i=>i.code+' x '+i.qty).join(' | '),x.createdAt]));
}

function writeTable_(ss,name,headers,rows) {
  let sh=ss.getSheetByName(name); if(!sh) sh=ss.insertSheet(name);
  sh.clearContents(); sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#d9eaf7');
  if(rows.length) sh.getRange(2,1,rows.length,headers.length).setValues(rows);
  sh.setFrozenRows(1); sh.autoResizeColumns(1,headers.length);
}

function saveImages_(materials) {
  const folder=getFolder_(); let imgs; const it=folder.getFoldersByName('imagenes_materiales'); imgs=it.hasNext()?it.next():folder.createFolder('imagenes_materiales');
  materials.filter(m=>m.image&&String(m.image).startsWith('data:image/')).forEach(m=>{
    const parts=m.image.split(','), mime=parts[0].match(/data:(.*?);/)[1], bytes=Utilities.base64Decode(parts[1]), ext=mime.indexOf('webp')>=0?'webp':'jpg', name=m.code+'.'+ext;
    const olds=imgs.getFilesByName(name); while(olds.hasNext()) olds.next().setTrashed(true);
    imgs.createFile(Utilities.newBlob(bytes,mime,name));
  });
}

function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
