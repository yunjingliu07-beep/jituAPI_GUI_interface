import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync} from 'node:fs';
export function localDB(file=':memory:'){
 const raw=new DatabaseSync(file);for(const name of ['0000_studio','0001_conversations','0002_task_references','0003_account_workflow','0004_updates_storage','0005_invitations','0006_owner_activity','0007_account_storage_limit','0008_generated_results'])raw.exec(readFileSync(new URL('../drizzle/'+name+'.sql',import.meta.url),'utf8'));
 return {raw,batch(statements){raw.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s._batchRun());raw.exec('COMMIT');return Promise.resolve(results);}catch(e){raw.exec('ROLLBACK');throw e;}},prepare(sql){let params=[];const q={_batchRun(){const r=raw.prepare(sql).run(...params);return {success:true,meta:{changes:r.changes}};},bind(...args){params=args;return q;},async first(){return raw.prepare(sql).get(...params)||null;},async all(){return {results:raw.prepare(sql).all(...params)};},async run(){const r=raw.prepare(sql).run(...params);return {success:true,meta:{changes:r.changes}};}};return q;}};
}
