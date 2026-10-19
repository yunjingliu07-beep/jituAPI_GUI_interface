// Local R2 adapter. Task ownership is checked by the handler before access.
import {mkdir,writeFile,readFile,rm,rmdir} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
export function localBucket(directory) {
  const root=resolve(directory);
  function objectPath(key) {const path=resolve(root,key);if(!path.startsWith(root+sep))throw new Error('Invalid object key');return path;}
  return {async put(key,body) {const path=objectPath(key);await mkdir(dirname(path),{recursive:true});await writeFile(path,new Uint8Array(await new Response(body).arrayBuffer()));},async get(key) {try{return {body:new Uint8Array(await readFile(objectPath(key)))};}catch(e){if(e.code==='ENOENT')return null;throw e;}},async delete(keys){for(const key of Array.isArray(keys)?keys:[keys]){const path=objectPath(key);await rm(path,{force:true});const userRoot=resolve(root,key.split('/').slice(0,2).join('/'));for(let parent=dirname(path);parent.startsWith(userRoot+sep);parent=dirname(parent)){try{await rmdir(parent);}catch(e){if(e.code==='ENOENT')continue;if(e.code==='ENOTEMPTY')break;throw e;}}}}};
}
