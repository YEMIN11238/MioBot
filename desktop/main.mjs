import {app,BrowserWindow,Notification,shell,dialog} from 'electron';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {startServer} from '../server/index.mjs';
let service,window;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
app.setName('MioBot');
// Keep the existing data, browser session, and single-instance identity on rename.
const legacyData=join(app.getPath('appData'),'Personal Agent');
mkdirSync(legacyData,{recursive:true,mode:0o700});
app.setPath('userData',legacyData);
app.setPath('sessionData',legacyData);
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{window?.show();window?.focus();});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.quit());
  app.whenReady().then(async()=>{
  const iconPath=resolve(root,'assets/app-icon.png');
  if(process.platform==='darwin')app.dock.setIcon(iconPath);
  service=await startServer({root,dataRoot:process.env.PERSONAL_AGENT_DATA||app.getPath('userData'),port:4318,onNotify:n=>{if(Notification.isSupported())new Notification({title:n.type==='care'?'MioBot · 来自助手的关心':'MioBot · 提醒',body:n.title}).show();}});
  window=new BrowserWindow({width:1500,height:980,minWidth:940,minHeight:680,title:'MioBot',icon:iconPath,backgroundColor:'#fbfbfe',titleBarStyle:'hiddenInset',trafficLightPosition:{x:16,y:15},webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith('https://'))shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==service.url)event.preventDefault();});
  window.on('close',event=>{if(!app.isQuitting){event.preventDefault();window.hide();}});
  app.on('activate',()=>window?.show());
  let closing=false;app.on('before-quit',event=>{app.isQuitting=true;if(!closing){event.preventDefault();closing=true;service.close().finally(()=>app.quit());}});
  await window.loadURL(service.url+'/?desktop=1');
  if(service.deployment.mode==='local'&&service.store.state.settings.location==='local'&&service.runtime.isInstalled())void service.runtime.start().catch(error=>{service.runtime.error=service.runtime.safeError(error);});
  }).catch(error=>{dialog.showErrorBox('MioBot 启动失败',String(error.message||error));app.quit();});
}
