/* V48.2 stability patch: startup restore guard, bounded config wait and proxy-only Drive calls. */
(function(){
  'use strict';
  const state = window.__bmV48 = window.__bmV48 || {restoreInFlight:null,lastAutoRestoreAt:0,configWrapped:false,proxyWrapped:false};

  if(!state.configWrapped && window.fetchServerConfigPromise && typeof window.fetchServerConfigPromise.then==='function'){
    state.configWrapped=true;
    const original=window.fetchServerConfigPromise;
    const timeout=new Promise(resolve=>setTimeout(()=>resolve(null),5000));
    window.fetchServerConfigPromise=Promise.race([original.catch(()=>null),timeout]);
  }

  if(!state.proxyWrapped && typeof window.callGoogleScript==='function'){
    state.proxyWrapped=true;
    window.callGoogleScript=async function(action,method='GET',payload=null){
      const cfg=typeof window.syncConfig==='function'?window.syncConfig():{};
      const url=String(cfg?.url||'').trim();
      const token=String(cfg?.token||'').trim();
      if(!url) throw new Error('URL de Google Apps Script no configurada.');
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),20000);
      try{
        let endpoint,init={cache:'no-store',signal:controller.signal};
        if(String(method).toUpperCase()==='POST'){
          endpoint='/api/drive/sync';
          const postBody={targetUrl:url,...(payload||{action,token})};
          if(!postBody.token&&token)postBody.token=token;
          if(!postBody.action)postBody.action=action;
          init.method='POST';
          init.headers={'Content-Type':'application/json'};
          init.body=JSON.stringify(postBody);
        }else{
          const qs=new URLSearchParams({url,...(token?{token}:{}),action:action||'getAll'});
          endpoint='/api/drive/get?'+qs.toString();
          init.method='GET';
          init.headers={Accept:'application/json'};
        }
        const response=await fetch(endpoint,init);
        const text=await response.text();
        let data=null;
        try{data=text?JSON.parse(text):null}catch(_){throw new Error(`Respuesta inválida del proxy Vercel (HTTP ${response.status}).`)}
        if(!response.ok)throw new Error(data?.error||`HTTP ${response.status}`);
        return data;
      }catch(error){
        if(error?.name==='AbortError')throw new Error('Tiempo de espera agotado al sincronizar con Google Drive.');
        throw error;
      }finally{clearTimeout(timer)}
    };
  }

  const originalRestore=typeof window.restoreFromDrive==='function'?window.restoreFromDrive:null;
  if(originalRestore&&!window.__bmRestoreV48Wrapped){
    window.__bmRestoreV48Wrapped=true;
    window.restoreFromDrive=function(options){
      const opts=(options&&typeof options==='object')?options:{};
      const activeId=document.activeElement&&document.activeElement.id;
      const manual=opts.isManual===true||opts.force===true||activeId==='restoreDrive'||activeId==='driveBackup'||activeId==='driveBackup2'||activeId==='v27RefreshDrive';
      if(!manual){
        const now=Date.now();
        if(now-state.lastAutoRestoreAt<30000)return Promise.resolve(false);
        state.lastAutoRestoreAt=now;
      }
      if(state.restoreInFlight)return state.restoreInFlight;
      let result;
      try{result=originalRestore.call(this,{...opts,isManual:manual})}
      catch(error){console.error('V48 restore error:',error);return Promise.resolve(false)}
      state.restoreInFlight=Promise.resolve(result).catch(error=>{console.error('V48 restore rejected:',error);return false}).finally(()=>{state.restoreInFlight=null});
      return state.restoreInFlight;
    };
  }

  function start(){['restoreDrive','driveBackup','driveBackup2','v27RefreshDrive'].forEach(id=>{const el=document.getElementById(id);if(el)el.dataset.v48Manual='1'})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
