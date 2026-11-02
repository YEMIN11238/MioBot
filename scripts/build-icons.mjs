import {mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {projectRoot} from '../server/index.mjs';

// Preserve the supplied artwork; only produce the platform's required sizes.
if(process.platform!=='darwin')throw new Error('ICNS generation requires macOS sips and iconutil.');
const source=join(projectRoot,'assets/app-icon.png');
if(!existsSync(source))throw new Error('Missing assets/app-icon.png');
const iconset=join(projectRoot,'.runtime/app-icon.iconset');
mkdirSync(iconset,{recursive:true});
for(const size of [16,32,128,256,512]){
  for(const scale of [1,2]){
    const pixels=String(size*scale),name=`icon_${size}x${size}${scale===2?'@2x':''}.png`;
    execFileSync('/usr/bin/sips',['-z',pixels,pixels,source,'--out',join(iconset,name)],{stdio:'ignore'});
  }
}
execFileSync('/usr/bin/iconutil',['-c','icns',iconset,'-o',join(projectRoot,'assets/app-icon.icns')],{stdio:'inherit'});
console.log('Generated assets/app-icon.icns from the original PNG.');
