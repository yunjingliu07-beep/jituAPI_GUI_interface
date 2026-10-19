import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHandler,sha,storageUsage,USER_STORAGE_LIMIT} from '../worker/core.js';
import {localDB} from '../scripts/d1-local.mjs';
import {migrate,databaseFile} from '../server/database.mjs';
import {mockBucket,mockUpstream} from './fixtures.mjs';

const origin='https://studio.example',params={mode:'text',model:'gpt-image-2.5-flare',prompt:'test private prompt',size:'1024x1024',n:1};
async function setup(){
 const db=localDB(),mock=mockUpstream(),accounts={},env={DB:db,API_VAULT_KEY:'1'.repeat(64),BUCKET:mockBucket()},handler=createHandler({});
 db.raw.exec('PRAGMA foreign_keys=ON');
 for(const role of ['owner','admin','member']){
  const id=crypto.randomUUID(),token=(crypto.randomUUID()+crypto.randomUUID()).replaceAll('-',''),t=Math.floor(Date.now()/1000);
  db.raw.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(id,role+'@example.com',role,t);
  db.raw.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await sha(token),id,t+3600);
  accounts[role]={id,cookie:'__Host-jitu='+token};
 }
 return {db,mock,env,accounts,close(){mock.restore();db.raw.close();},req(path,{actor='owner',body,method,headers={}}={}){
  const h={origin,...(actor?{cookie:accounts[actor].cookie}:{}),...headers};if(body!==undefined)h['Content-Type']='application/json';
  return handler.fetch(new Request(origin+path,{method:method||(body===undefined?'GET':'POST'),headers:h,body:body===undefined?undefined:JSON.stringify(body)}),env,{});
 }};
}
async function submit(a,options={}){
 const r=await a.req('/api/tasks',{actor:'member',body:{...params,...options.params},headers:{'x-jitu-key':'sk-jitu-activity-test','idempotency-key':options.idem||crypto.randomUUID()}});
 return r;
}

test('only owner can read activity; anonymous, admins, spoofed roles and mutations are rejected',async()=>{
 const a=await setup();try{
  for(const tab of ['users','calls']){
   const path='/api/admin/activity/'+tab;
   assert.equal((await a.req(path,{actor:null})).status,401);
   for(const actor of ['admin','member'])assert.equal((await a.req(path,{actor,headers:{'x-user-role':'owner','oai-authenticated-user-email':'owner@example.com'}})).status,403);
   const r=await a.req(path);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
   assert.equal((await a.req(path,{body:{}})).status,405);
  }
  const data=await (await a.req('/api/admin/activity/users')).json();assert.equal(data.totalUsers,3);assert.equal(data.total,3);
  assert(data.users.every(u=>!('password_hash' in u)&&!('token_hash' in u)));
 }finally{a.close();}
});

test('records real submissions, updates outcomes, deduplicates accepted replays and retains data after chat deletion',async()=>{
 const a=await setup();try{
  const idem=crypto.randomUUID(),start=Math.floor(Date.now()/1000),r=await submit(a,{idem});assert.equal(r.status,202,await r.clone().text());const task=(await r.json()).task;
  const list=()=>a.req('/api/admin/activity/calls').then(r=>r.json());
  let data=await list();assert.equal(data.total,1);assert.equal(data.summary.calls,1);assert.equal(data.summary.tasks,1);
  assert.equal(data.calls[0].email,'member@example.com');assert(data.calls[0].startedAt>=start);assert.equal(data.calls[0].outcome,'accepted');assert.equal(data.calls[0].httpStatus,202);assert.equal(data.calls[0].source,'live');
  assert(!JSON.stringify(data).includes(params.prompt));assert(!JSON.stringify(data).includes('sk-jitu-activity-test'));
  assert.equal((await submit(a,{idem})).status,200);assert.equal((await list()).total,1);
  for(let i=0;i<2;i++)assert.equal((await a.req('/api/tasks/'+task.id,{actor:'member',headers:{'x-jitu-key':'sk-jitu-activity-test'}})).status,200);
  data=await list();assert.equal(data.total,1);assert.equal(data.calls[0].taskStatus,'succeeded');
  const users=await (await a.req('/api/admin/activity/users?email=MEMBER')).json();assert.equal(users.total,1);assert.equal(users.users[0].callCount,1);assert.equal(users.users[0].taskCount,1);assert(users.users[0].lastCallAt);
  assert.equal((await a.req('/api/conversations/'+task.conversationId,{actor:'member',method:'DELETE'})).status,200);
  assert.equal(a.db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);assert.equal((await list()).total,1);
 }finally{a.close();}
});

test('local validation failures are excluded, rejected requests are recorded and uncertain retries get separate rows',async()=>{
 const a=await setup();try{
  assert.equal((await submit(a,{params:{n:0}})).status,400);assert.equal(a.db.raw.prepare('SELECT COUNT(*) AS n FROM api_activity').get().n,0);
  assert.equal((await submit(a,{params:{prompt:'QA_FAIL_BALANCE'}})).status,402);
  assert.equal(a.db.raw.prepare('SELECT outcome FROM api_activity').get().outcome,'rejected');
  const base=globalThis.fetch;let fail=true;
  globalThis.fetch=async(input,opts)=>{if(fail&&String(input).endsWith('/generations')){fail=false;throw new TypeError('network interrupted');}return base(input,opts);};
  const idem=crypto.randomUUID();assert.equal((await submit(a,{idem})).status,504);assert.equal((await submit(a,{idem})).status,202);
  const rows=a.db.raw.prepare("SELECT * FROM api_activity WHERE outcome<>'rejected' ORDER BY rowid").all();assert.equal(rows.length,2);assert.equal(rows[0].outcome,'unknown');assert.equal(rows[0].http_status,null);assert.equal(rows[1].outcome,'accepted');assert.equal(rows[0].task_id,rows[1].task_id);
  const summary=(await (await a.req('/api/admin/activity/calls')).json()).summary;assert.equal(summary.calls,3);assert.equal(summary.tasks,2);
 }finally{a.close();}
});

test('automatic storage cleanup preserves activity while deleting original task rows',async()=>{
 const a=await setup();try{
  const r=await submit(a);assert.equal(r.status,202);const task=(await r.json()).task;
  a.db.raw.prepare("UPDATE tasks SET status='succeeded',created_at=1 WHERE id=?").run(task.id);
  // Inflate recorded text size to cross the quota without writing 1 GB to disk.
  a.db.raw.prepare('UPDATE tasks SET reference_files=? WHERE id=?').run(JSON.stringify([{key:`references/${a.accounts.member.id}/${task.id}/0`,size:USER_STORAGE_LIMIT,kind:'image'}]),task.id);
  assert((await storageUsage(a.env,a.accounts.member.id)).bytes>USER_STORAGE_LIMIT);
  assert.equal((await a.req('/api/storage',{actor:'member'})).status,200);
  assert.equal(a.db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
  assert.equal((await (await a.req('/api/admin/activity/calls')).json()).total,1);
 }finally{a.close();}
});

test('an unreadable successful upstream response remains uncertain rather than reported as rejected',async()=>{
 const a=await setup();try{
  const fetch=globalThis.fetch;globalThis.fetch=async(input,opts)=>String(input).endsWith('/generations')?Response.json(null):fetch(input,opts);
  assert.equal((await submit(a)).status,500);
  const row=a.db.raw.prepare('SELECT outcome,http_status,task_status FROM api_activity').get();assert.equal(row.outcome,'unknown');assert.equal(row.http_status,200);assert.equal(row.task_status,'unknown');
 }finally{a.close();}
});

test('UTC+8 inclusive date filters, literal email search, pagination and invalid inputs',async()=>{
 const a=await setup();try{
  const insert=a.db.raw.prepare("INSERT INTO api_activity(id,task_id,user_id,email,started_at,source,mode,model,requested_count,outcome,task_status,updated_at) VALUES (?,?,?,?,?,'live','text','model',1,'accepted','succeeded',?)");
  const midnight=Date.parse('2026-10-18T16:00:00Z')/1000;
  for(let i=0;i<52;i++)insert.run(String(i).padStart(3,'0'),'task-'+i,a.accounts.member.id,'member@example.com',midnight,midnight);
  for(const [id,t] of [['before',midnight-1],['after',midnight+86400]])insert.run(id,id,a.accounts.admin.id,'admin@example.com',t,t);
  let data=await (await a.req('/api/admin/activity/calls?from=2026-10-19&to=2026-10-19')).json();assert.equal(data.total,52);assert.equal(data.calls.length,50);assert.equal(data.nextOffset,50);assert.equal(data.summary.activeUsers,1);
  data=await (await a.req('/api/admin/activity/calls?from=2026-10-19&to=2026-10-19&offset=50')).json();assert.equal(data.calls.length,2);assert.equal(data.nextOffset,null);
  assert.equal((await (await a.req('/api/admin/activity/calls?email=%25')).json()).total,0);
  assert.equal((await (await a.req('/api/admin/activity/calls?email=MEMBER')).json()).total,52);
  assert.equal((await (await a.req('/api/admin/activity/calls?userId='+a.accounts.admin.id)).json()).total,2);
  assert.equal((await a.req('/api/admin/activity/users?userId=invalid')).status,400);
  for(const q of ['from=2026-02-30','to=bad','offset=-1','offset=0.5','from=2026-10-20&to=2026-10-19','email='+ 'x'.repeat(255)])assert.equal((await a.req('/api/admin/activity/calls?'+q)).status,400,q);
 }finally{a.close();}
});

test('upgrade backfills old tasks once and retains activity after task deletion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meow-activity-'));
 try{
  const raw=new DatabaseSync(databaseFile(dir));
  for(const file of ['0000_studio','0001_conversations','0002_task_references','0003_account_workflow','0004_updates_storage','0005_invitations'])raw.exec(await readFile(new URL('../drizzle/'+file+'.sql',import.meta.url),'utf8'));
  raw.prepare("INSERT INTO users(id,email,created_at) VALUES ('old','old@example.com',1)").run();
  raw.prepare("INSERT INTO tasks(id,user_id,idempotency_key,fingerprint,mode,prompt,model,size,count,status,created_at,updated_at) VALUES ('task','old','idem','fp','text','private','model','1024x1024',1,'succeeded',123,124)").run();raw.close();
  migrate(dir);migrate(dir);
  const db=new DatabaseSync(databaseFile(dir));
  try{const rows=db.prepare('SELECT * FROM api_activity').all();assert.equal(rows.length,1);assert.equal(rows[0].source,'historical');assert.equal(rows[0].started_at,123);assert.equal(rows[0].email,'old@example.com');db.exec('DELETE FROM tasks');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_activity').get().n,1);}finally{db.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
