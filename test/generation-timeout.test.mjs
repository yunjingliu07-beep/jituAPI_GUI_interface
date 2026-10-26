import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHandler,sha,expireTimedOutTasks,maintainExistingStorage,RELEASES} from '../worker/core.js';
import {migrate,openDatabase} from '../server/database.mjs';
import {localDB} from '../scripts/d1-local.mjs';
import {mockUpstream,mockBucket} from './fixtures.mjs';
const origin='https://studio.example';
async function setup(db=localDB(),email='timeout@example.com'){
 const userId=crypto.randomUUID(),token='b'.repeat(64),env={DB:db,BUCKET:mockBucket()},handler=createHandler({});
 db.raw.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(userId,email,Math.floor(Date.now()/1000));
 db.raw.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await sha(token),userId,Math.floor(Date.now()/1000)+86400);
 const req=(path,body,idem=crypto.randomUUID())=>handler.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:{origin,cookie:`__Host-jitu=${token}`,'x-jitu-key':'sk-jitu-test-only-key','idempotency-key':idem,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,{});
 return {db,env,userId,req};
}
const input={mode:'text',prompt:'a cat',model:'model',size:'1024x1024',n:1};
test('20-minute deadline ends old queued, running, unknown and submitting tasks; completed tasks stay complete',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});
 const a=await setup(),mock=mockUpstream();
 try{
  const task=(await (await a.req('/api/tasks',input)).json()).task;
  t.mock.timers.setTime(Date.now()+1199000);
  assert.equal((await (await a.req('/api/tasks')).json()).tasks[0].status,'queued');
  // Status and successful queries must not reset the original deadline.
  assert.equal((await (await a.req('/api/tasks/'+task.id)).json()).task.status,'running');
  const calls=mock.calls.length;t.mock.timers.setTime(Date.now()+1000);
  const expired=(await (await a.req('/api/tasks/'+task.id)).json()).task;
  assert.equal(expired.status,'timed_out');assert.match(expired.error,/生图超时/);assert.equal(mock.calls.length,calls);
  assert.equal(a.db.raw.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'timed_out');
  // A stale page reusing the old submission never starts a new paid request.
  assert.equal((await (await a.req('/api/tasks',input,task.idempotencyKey)).json()).task.status,'timed_out');
  assert.equal(mock.calls.length,calls);
  const next=await a.req('/api/tasks',{...input,conversationId:task.conversationId,prompt:'a new cat'});
  assert.equal(next.status,202);assert.equal((await next.json()).task.conversationId,task.conversationId);
  for(const status of ['submitting','unknown','queued','running','succeeded','failed','expired']){
   const id=crypto.randomUUID();
   a.db.raw.prepare('INSERT INTO tasks(id,user_id,idempotency_key,fingerprint,mode,prompt,model,size,count,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,a.userId,id,'fp','text','old','model','1024x1024',1,status,Math.floor(Date.now()/1000)-1300,Math.floor(Date.now()/1000));
  }
  await maintainExistingStorage(a.env);
  const statuses=a.db.raw.prepare("SELECT status FROM tasks WHERE prompt='old'").all().map(x=>x.status);
  assert.deepEqual(statuses,['timed_out','timed_out','timed_out','timed_out','succeeded','failed','expired']);
  assert.equal((await (await a.req('/api/tasks/'+task.id)).json()).task.status,'timed_out');
 }finally{mock.restore();a.db.raw.close();}
});
test('a result arriving after the deadline cannot reopen a timed out task',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});
 const a=await setup(),mock=mockUpstream();const original=globalThis.fetch;
 try{
  const task=(await (await a.req('/api/tasks',input)).json()).task;
  let release,entered;const started=new Promise(r=>entered=r);
  globalThis.fetch=async(url,options)=>{if(String(url).includes('/tasks/')){entered();return new Promise(r=>release=()=>r(Response.json({status:'succeeded',result:{data:[]}})));}return original(url,options);};
  const query=a.req('/api/tasks/'+task.id);await started;
  t.mock.timers.setTime(Date.now()+1200000);await expireTimedOutTasks(a.env);release();
  const data=await (await query).json();assert.equal(data.task.status,'timed_out');assert.equal(data.result,undefined);
  assert.equal(a.db.raw.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'timed_out');
 }finally{mock.restore();a.db.raw.close();}
});
test('a delayed original submission ends at the same deadline without restoring a queryable job',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});
 const a=await setup(),native=globalThis.fetch;
 try{
  let release,entered;const started=new Promise(r=>entered=r);
  globalThis.fetch=async()=>{entered();return new Promise(r=>release=()=>r(Response.json({id:'late-id',status:'queued'})));};
  const submission=a.req('/api/tasks',input);await started;
  t.mock.timers.setTime(Date.now()+1200000);await expireTimedOutTasks(a.env);release();
  const data=await (await submission).json();assert.equal(data.task.status,'timed_out');
  assert.equal(a.db.raw.prepare('SELECT status FROM tasks').get().status,'timed_out');
  assert.equal(a.db.raw.prepare('SELECT task_status FROM api_activity').get().task_status,'timed_out');
 }finally{globalThis.fetch=native;a.db.raw.close();}
});
test('migration grants the requested account 5 GB before startup cleanup and preserves other accounts and notices',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meow-quota-'));
 let db;
 try{
  const raw=new DatabaseSync(join(dir,'studio.sqlite'));
  const journal=JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
  for(const m of journal.entries.filter(x=>x.idx<7))raw.exec(await readFile(new URL('../drizzle/'+m.tag+'.sql',import.meta.url),'utf8'));
  raw.exec("INSERT INTO users(id,email,created_at) VALUES('target','ronnnlau@gmail.com',1),('other','other@example.com',1); INSERT INTO account_storage(user_id,notice_revision,notice_conversations) VALUES('target',3,2);");raw.close();
  migrate(dir);migrate(dir);db=openDatabase(dir);
  assert.equal(db.raw.prepare("SELECT limit_bytes FROM account_storage WHERE user_id='target'").get().limit_bytes,5000000000);
  assert.equal(db.raw.prepare("SELECT notice_revision FROM account_storage WHERE user_id='target'").get().notice_revision,3);
  for(const user of ['target','other']){
   const size=user==='target'?2000000000:100;
   db.raw.prepare('INSERT INTO tasks(id,user_id,idempotency_key,fingerprint,mode,prompt,model,size,count,status,created_at,updated_at,reference_files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(user+'-task',user,user,'fp','text','saved','model','1024x1024',1,'succeeded',1,1,JSON.stringify([{size}]));
  }
  await maintainExistingStorage({DB:db,BUCKET:mockBucket()});
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id='target'").get().n,1);
  const token='c'.repeat(64);db.raw.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await sha(token),'target',Math.floor(Date.now()/1000)+86400);
  const snapshot=await createHandler({}).fetch(new Request(origin+'/api/storage',{headers:{cookie:`__Host-jitu=${token}`}}),{DB:db,BUCKET:mockBucket()},{});
  assert.equal((await snapshot.json()).limitBytes,5000000000);
  const other=await setup(db,'new@example.com');
  assert.equal((await (await other.req('/api/storage')).json()).limitBytes,1000000000);
  assert(!JSON.stringify(RELEASES[0]).includes('5 GB'));assert(!JSON.stringify(RELEASES).includes('ronnnlau'));
 }finally{db?.raw.close();await rm(dir,{recursive:true,force:true});}
});
