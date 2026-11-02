import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const directories=['server','shared','integrations','src','desktop','assets','public','licenses','deploy','scripts','tests','docs'];
const files=['package.json','package-lock.json','index.html','vite.config.js','LICENSE','THIRD_PARTY.md','README.md','README-cloud.md','README-cloud-client.md'];
const excluded=new Set(['.data','.runtime','release','node_modules','.git','__pycache__','.DS_Store','.env','credentials.json','state.json','cloud-owner-token']);
function safeSource(path){
  if(lstatSync(path).isSymbolicLink())throw new Error('云端源码包不接受符号链接：'+basename(path));
  return !excluded.has(basename(path))&&!/\.(?:pyc|pyo|pem|key|log)$/i.test(path);
}
function walk(root,current=root){return readdirSync(current,{withFileTypes:true}).flatMap(e=>{const path=join(current,e.name);return e.isDirectory()?walk(root,path):[{path:relative(root,path).split('\\').join('/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}];});}

export function packageCloud({root=projectRoot,output=join(root,'release/cloud'),build=true}={}){
  if(build)execFileSync('npm',['run','build'],{cwd:root,stdio:'inherit'});
  if(!existsSync(join(root,'dist/index.html')))throw new Error('请先生成前端 dist，再制作云端包');
  const {version}=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(!/^[a-zA-Z0-9._-]+$/.test(version))throw new Error('项目版本格式无效');
  const name='miobot-cloud-'+version,stage=mkdtempSync(join(tmpdir(),'miobot-cloud-package-')),target=join(stage,name);
  mkdirSync(target);
  try{
    for(const dir of [...directories,'dist'])if(existsSync(join(root,dir)))cpSync(join(root,dir),join(target,dir),{recursive:true,filter:safeSource});
    for(const file of files){if(!existsSync(join(root,file)))throw new Error('云端包缺少：'+file);cpSync(join(root,file),join(target,file),{filter:safeSource});}
    const entries=walk(target).sort((a,b)=>a.path.localeCompare(b.path));
    writeFileSync(join(target,'CLOUD-PACKAGE.json'),JSON.stringify({product:'MioBot',version,createdAt:new Date().toISOString(),containsUserData:false,includesMacRuntime:false,engine:{name:'AstrBot',version:'4.29.3',revision:'f61a7f42696da6df25dc7a249ec9b8d54ed9da18',downloadedDuringDockerBuild:true},dockerImageBuildVerified:false,excluded:['.data','.runtime','release','node_modules','credentials','private keys','runtime logs'],files:entries},null,2)+'\n');
    mkdirSync(output,{recursive:true});
    const archive=resolve(output,name+'.tar.gz');
    // BSD tar otherwise emits AppleDouble files containing Finder metadata.
    execFileSync('tar',['-czf',archive,'-C',stage,name],{stdio:['ignore','ignore','pipe'],env:{...process.env,COPYFILE_DISABLE:'1'}});
    const sha256=createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(archive+'.sha256',sha256+'  '+basename(archive)+'\n');
    return {archive,sha256,files:entries.length+1,dockerImageBuildVerified:false};
  }finally{rmSync(stage,{recursive:true,force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(packageCloud({build:!process.argv.includes('--skip-build')}),null,2));
}
