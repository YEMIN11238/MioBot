import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchManagedRuntime} from '../server/assistant-runtime.mjs';
const source=resolve(process.argv[2]||fileURLToPath(new URL('../.runtime/astrbot-source',import.meta.url)));
console.log(JSON.stringify(patchManagedRuntime(source)));
