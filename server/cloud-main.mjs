import {constants,existsSync,mkdirSync,openSync,closeSync,readFileSync,writeFileSync,fstatSync,fchmodSync,fsyncSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer,projectRoot} from './index.mjs';

/** Owner credentials live in the persistent volume, never in a URL or stdout. */
export function ownerToken(file){
  if(!isAbsolute(file))throw new Error('MIOBOT_CLOUD_TOKEN_FILE 必须是绝对路径');
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  let fd;
  try{
    fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    writeFileSync(fd,randomBytes(32).toString('base64url')+'\n');fsyncSync(fd);
  }catch(error){if(error.code!=='EEXIST')throw error;}
  finally{if(fd!==undefined)closeSync(fd);}
  fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>1024)throw new Error('云端连接密钥文件无效');
    fchmodSync(fd,0o600);
    const token=readFileSync(fd,'utf8').trim();
    if(!/^[A-Za-z0-9_-]{32,512}$/.test(token))throw new Error('云端连接密钥格式无效，请使用至少 32 位随机字符');
    return token;
  }finally{closeSync(fd);}
}

export async function startCloud({env=process.env,start=startServer}={}){
  const dataRoot=resolve(env.MIOBOT_DATA||'/data'),fresh=!existsSync(resolve(dataRoot,'state.json'));
  mkdirSync(dataRoot,{recursive:true,mode:0o700});
  const cloudToken=ownerToken(env.MIOBOT_CLOUD_TOKEN_FILE||resolve(dataRoot,'cloud-owner-token'));
  const port=env.MIOBOT_PORT===undefined?4318:Number(env.MIOBOT_PORT);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('MIOBOT_PORT 必须是有效端口');
  const app=await start({root:projectRoot,dataRoot,host:'0.0.0.0',port,cloudMode:true,cloudToken,serverName:env.MIOBOT_SERVER_NAME||'MioBot 云端'});
  try{
    if(fresh){app.store.state.settings.location='local';app.store.state.settings.runtimeUrl='http://127.0.0.1:26185';app.store.save();}
    if(env.MIOBOT_NO_ENGINE!=='1'){
      // Keep configuration and diagnostic pages reachable if the engine fails.
      try{await app.runtime.start();}catch{console.error('MioBot 云端引擎启动未完成，请在客户端查看运行状态。');}
    }
    return app;
  }catch(error){await app.close();throw error;}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let app,closing=false;
  const stop=async()=>{if(closing)return;closing=true;try{await app?.close();}finally{process.exit(0);}};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
    app=await startCloud();
    console.log('MioBot 云端服务已启动；连接密钥已保存在持久数据目录，不会显示在日志中。');
    if(closing)await app.close();
  }catch{
    console.error('MioBot 云端启动失败。请检查端口、数据目录权限与密钥文件格式。');
    process.exitCode=1;
  }
}
