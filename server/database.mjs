import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';

// Migrations run before the listener starts, never during an HTTP request.
const migrations=[
 ['0000_studio','users','password_hash'],
 ['0001_conversations','tasks','conversation_id'],
 ['0002_task_references','tasks','reference_files'],
 ['0003_account_workflow','users','onboarding_completed_at'],
 ['0004_updates_storage','users','last_seen_release'],
 ['0005_invitations','users','role'],
 ['0006_owner_activity','api_activity','task_id']
];
export function databaseFile(directory){return resolve(directory,'studio.sqlite');}
export function migrate(directory){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const db=new DatabaseSync(databaseFile(directory));
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  for(const [name,table,column] of migrations){
   if(db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))continue;
   db.exec('BEGIN IMMEDIATE');
   try{db.exec(readFileSync(new URL(`../drizzle/${name}.sql`,import.meta.url),'utf8'));db.exec('COMMIT');}
   catch(error){db.exec('ROLLBACK');throw error;}
  }
 }finally{db.close();}
}
export function openDatabase(directory){
 if(!existsSync(databaseFile(directory)))throw new Error('Apply database migrations before starting the service.');
 const raw=new DatabaseSync(databaseFile(directory),{open:true});
 raw.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 // Fail closed when someone starts the service before applying its schema.
 raw.prepare('SELECT password_hash,onboarding_completed_at,selected_api_id,last_seen_release,role,invitation_id FROM users LIMIT 0').all();
 raw.prepare('SELECT reference_files,references_ready,api_profile_id,api_key_hash FROM tasks LIMIT 0').all();
 raw.prepare('SELECT pinned,deleted_at FROM conversations LIMIT 0').all();
 raw.prepare('SELECT notice_revision FROM account_storage LIMIT 0').all();
 raw.prepare('SELECT code_hash,used_by FROM registration_invitations LIMIT 0').all();
 raw.prepare('SELECT task_id,source,outcome FROM api_activity LIMIT 0').all();
 return {raw,batch(statements){raw.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s._batchRun());raw.exec('COMMIT');return Promise.resolve(results);}catch(e){raw.exec('ROLLBACK');throw e;}},prepare(sql){let values=[];const statement=raw.prepare(sql);const query={
  _batchRun(){const r=statement.run(...values);return {success:true,meta:{changes:r.changes}};},
  bind(...args){values=args;return query;},
  async first(){return statement.get(...values)||null;},
  async all(){return {results:statement.all(...values)};},
  async run(){const result=statement.run(...values);return {success:true,meta:{changes:result.changes}};}
 };return query;}};
}
