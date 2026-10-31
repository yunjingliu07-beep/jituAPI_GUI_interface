import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate,openDatabase,databaseFile} from '../server/database.mjs';
import {maintainExistingStorage,USER_STORAGE_LIMIT} from '../worker/core.js';
import {mockBucket} from './fixtures.mjs';

test('3 GB upgrade covers every existing user, preserves larger quotas and metadata, and runs before cleanup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meow-quota-3gb-'));let db;
 try{
  const raw=new DatabaseSync(databaseFile(dir));
  const journal=JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
  for(const entry of journal.entries.filter(e=>e.idx<9))raw.exec(await readFile(new URL('../drizzle/'+entry.tag+'.sql',import.meta.url),'utf8'));
  const quotas={low:1_000_000_000,almost:2_999_999_999,exact:3_000_000_000,higher:3_000_000_001,custom:5_000_000_000,missing:null};
  for(const [id,quota] of Object.entries(quotas)){
   raw.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,1)').run(id,id+'@example.com','original-hash');
   if(quota!==null)raw.prepare('INSERT INTO account_storage(user_id,limit_bytes,notice_revision,acknowledged_revision,notice_conversations,notice_tasks,notice_at,lease_token,lease_until) VALUES(?,?,4,2,3,6,123,?,456)').run(id,quota,'original-lease');
  }
  // This existing 2 GB task would be deleted if startup still enforced the old 1 GB quota.
  raw.prepare("INSERT INTO tasks(id,user_id,idempotency_key,fingerprint,mode,prompt,model,size,count,status,created_at,updated_at,reference_files) VALUES('saved-task','low','saved-key','fp','edit','saved prompt','model','1024x1024',1,'succeeded',1,1,?)").run(JSON.stringify([{key:'references/low/saved-task/0',size:2_000_000_000}]));
  const before=raw.prepare('SELECT * FROM account_storage ORDER BY user_id').all();raw.close();
  migrate(dir);migrate(dir);db=openDatabase(dir);
  assert.equal(USER_STORAGE_LIMIT,3_000_000_000);
  for(const row of before)assert.deepEqual({...db.raw.prepare('SELECT * FROM account_storage WHERE user_id=?').get(row.user_id)},{...row,limit_bytes:Math.max(row.limit_bytes,3_000_000_000)});
  assert.equal(db.raw.prepare("SELECT limit_bytes FROM account_storage WHERE user_id='missing'").get().limit_bytes,3_000_000_000);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE password_hash=?').get('original-hash').n,6);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM app_data_migrations').get().n,1);
  const bucket=mockBucket();await bucket.put('references/low/saved-task/0',new Uint8Array([1]));
  assert.deepEqual(await maintainExistingStorage({DB:db,BUCKET:bucket}),{failures:0});
  assert(db.raw.prepare("SELECT id FROM tasks WHERE id='saved-task'").get());
  assert(bucket.objects.has('references/low/saved-task/0'));
  assert.equal(db.raw.prepare("SELECT notice_revision FROM account_storage WHERE user_id='low'").get().notice_revision,4);
  // A user registered after migration gets the same default when its quota record is created.
  db.raw.exec("INSERT INTO users(id,email,created_at) VALUES('new','new@example.com',1)");
  await maintainExistingStorage({DB:db,BUCKET:bucket});
  assert.equal(db.raw.prepare("SELECT limit_bytes FROM account_storage WHERE user_id='new'").get().limit_bytes,3_000_000_000);
  assert.equal(db.raw.prepare("SELECT limit_bytes FROM account_storage WHERE user_id='custom'").get().limit_bytes,5_000_000_000);
 }finally{db?.raw.close();await rm(dir,{recursive:true,force:true});}
});
