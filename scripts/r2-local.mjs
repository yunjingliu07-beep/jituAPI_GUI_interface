// Local R2 adapter. Task ownership is checked by the handler before access.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
export function localBucket(directory) {
  const root=resolve(directory);
  function objectPath(key) {const path=resolve(root,key);if(!path.startsWith(root+sep))throw new Error('Invalid object key');return path;}
  return {async put(key,body) {const path=objectPath(key);await mkdir(dirname(path),{recursive:true});await writeFile(path,new Uint8Array(await new Response(body).arrayBuffer()));},async get(key) {try{return {body:new Uint8Array(await readFile(objectPath(key)))};}catch(e){if(e.code==='ENOENT')return null;throw e;}}};
}
