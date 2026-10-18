import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync} from 'node:fs';
export function localDB(file=':memory:'){
 const raw=new DatabaseSync(file);for(const name of ['0000_studio','0001_conversations'])raw.exec(readFileSync(new URL('../drizzle/'+name+'.sql',import.meta.url),'utf8'));
 return {raw,prepare(sql){let params=[];const q={bind(...args){params=args;return q;},async first(){return raw.prepare(sql).get(...params)||null;},async all(){return {results:raw.prepare(sql).all(...params)};},async run(){const r=raw.prepare(sql).run(...params);return {success:true,meta:{changes:r.changes}};}};return q;}};
}
