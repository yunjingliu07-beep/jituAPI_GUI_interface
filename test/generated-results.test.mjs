import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler,sha,storageUsage,syncPendingResults} from '../worker/core.js';
import {localDB} from '../scripts/d1-local.mjs';
import {mockBucket,mockUpstream,PNG} from './fixtures.mjs';
const origin='https://studio.example',key='sk-jitu-result-only-test';
const input={mode:'text',prompt:'saved cat',model:'model',n:1,size:'1024x1024'};
async function setup(){
 const db=localDB(),bucket=mockBucket(),env={DB:db,BUCKET:mockBucket(),RESULTS_BUCKET:bucket,API_VAULT_KEY:'a'.repeat(64)},handler=createHandler({}),userId=crypto.randomUUID(),token='c'.repeat(64);
 db.raw.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(userId,'results@example.com',Math.floor(Date.now()/1000));
 db.raw.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await sha(token),userId,Math.floor(Date.now()/1000)+86400);
 const req=(path,{body,method,headers={},cookie=`__Host-jitu=${token}`}={})=>handler.fetch(new Request(origin+path,{method:method||(body?'POST':'GET'),headers:{origin,cookie,...headers},body:body?JSON.stringify(body):undefined}),env,{});
 const create=async(body=input,headers={})=>{const r=await req('/api/tasks',{body,headers:{'x-jitu-key':key,'idempotency-key':crypto.randomUUID(),...headers}});assert.equal(r.status,202);return (await r.json()).task;};
 const query=async(id,headers={'x-jitu-key':key})=>{const r=await req('/api/tasks/'+id,{headers});assert.equal(r.status,200);return r.json();};
 const complete=async task=>{await query(task.id);return query(task.id);};
 return {db,env,bucket,userId,req,create,query,complete};
}
test('completed results persist beyond 12 hours, are private, and need no upstream key to read',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const task=await a.create(),before=(await storageUsage(a.env,a.userId)).bytes;
  const data=await a.complete(task);assert(data.task.resultsSaved);assert.equal(data.task.savedImages.length,1);assert.equal(a.bucket.objects.size,1);
  assert.equal(data.task.savedImages[0].size,PNG.length);assert(!JSON.stringify(data.task).includes('generated/'));
  assert((await storageUsage(a.env,a.userId)).bytes>=before+PNG.length);
  const calls=mock.calls.length;a.db.raw.prepare('UPDATE tasks SET created_at=1 WHERE id=?').run(task.id);
  assert.equal((await a.query(task.id,{})).task.status,'succeeded');
  const r=await a.req(`/api/tasks/${task.id}/images/0`);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await r.arrayBuffer()),PNG);assert.equal(mock.calls.length,calls);
  assert.equal((await a.req(`/api/tasks/${task.id}/images/0`,{cookie:''})).status,401);
  const otherToken='d'.repeat(64),other=crypto.randomUUID();a.db.raw.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,1)').run(other,'outsider@example.com');
  a.db.raw.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await sha(otherToken),other,Math.floor(Date.now()/1000)+86400);
  assert.equal((await a.req(`/api/tasks/${task.id}/images/0`,{cookie:`__Host-jitu=${otherToken}`})).status,404);
 }finally{mock.restore();a.db.raw.close();}
});
test('an immediate multi-image response is archived before it is reported as saved',async()=>{
 const a=await setup(),native=globalThis.fetch;try{
  globalThis.fetch=async()=>Response.json({id:'immediate',data:[{b64_json:PNG.toString('base64')},{b64_json:PNG.toString('base64')}]});
  const task=await a.create({...input,n:2});assert(task.resultsSaved);assert.equal(task.resultCount,2);assert.equal(task.savedImages.length,2);assert.equal(a.bucket.objects.size,2);
  assert.deepEqual(Buffer.from(await (await a.req(`/api/tasks/${task.id}/images/1`)).arrayBuffer()),PNG);
 }finally{globalThis.fetch=native;a.db.raw.close();}
});
test('URL results are downloaded with redirect checks; partial success is retained when another URL is unsafe',async()=>{
 const mock=mockUpstream(),a=await setup(),base=globalThis.fetch;try{
  const task=await a.create({...input,n:2});const urls=[];
  globalThis.fetch=async(url,options)=>{
   urls.push(String(url));if(String(url).includes('/tasks/'))return Response.json({status:'succeeded',result:{data:[{url:'https://images.example/result'},{url:'http://127.0.0.1/private'}]}});
   if(String(url)==='https://images.example/result')return new Response(null,{status:302,headers:{location:'https://cdn.example/cat.png'}});
   if(String(url)==='https://cdn.example/cat.png')return new Response(PNG,{headers:{'content-type':'image/png'}});
   return base(url,options);
  };
  const data=await a.query(task.id);assert.equal(data.task.resultsSaved,false);assert.equal(data.task.savedImages.length,1);assert.match(data.task.saveError,/不安全/);assert(!urls.includes('http://127.0.0.1/private'));
  a.db.raw.prepare('UPDATE tasks SET created_at=1 WHERE id=?').run(task.id);
  assert.deepEqual(Buffer.from(await (await a.req(`/api/tasks/${task.id}/images/0`)).arrayBuffer()),PNG);
  assert.equal((await a.req(`/api/tasks/${task.id}/images/1`)).status,404);
  assert.equal((await a.query(task.id,{})).task.status,'succeeded');
 }finally{mock.restore();a.db.raw.close();}
});
test('saving results counts toward quota and removes the oldest conversation and its generated files',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const oldest=await a.create();await a.complete(oldest);const oldKey=[...a.bucket.objects.keys()][0];
  a.db.raw.prepare('UPDATE conversations SET created_at=1 WHERE id=?').run(oldest.conversationId);
  const task=await a.create({...input,prompt:'new cat'}),usage=(await storageUsage(a.env,a.userId)).bytes;
  a.db.raw.prepare('UPDATE account_storage SET limit_bytes=? WHERE user_id=?').run(usage,a.userId);
  const saved=await a.complete(task);assert(saved.task.resultsSaved);assert(!a.bucket.objects.has(oldKey));
  assert(!a.db.raw.prepare('SELECT id FROM tasks WHERE id=?').get(oldest.id));
  const state=await (await a.req('/api/storage')).json();assert(state.usedBytes<=usage);assert.equal(state.notice.conversations,1);assert.equal(state.notice.tasks,1);
 }finally{mock.restore();a.db.raw.close();}
});
test('a full current conversation reports a save error and can retry after space is increased without new generation',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const task=await a.create(),usage=(await storageUsage(a.env,a.userId)).bytes;
  a.db.raw.prepare('UPDATE account_storage SET limit_bytes=? WHERE user_id=?').run(usage,a.userId);
  const data=await a.complete(task);assert.equal(data.task.status,'succeeded');assert.equal(data.task.resultsSaved,false);assert.match(data.task.saveError,/接近/);assert.equal(a.bucket.objects.size,0);assert.equal((await storageUsage(a.env,a.userId)).bytes,usage);
  a.db.raw.prepare('UPDATE account_storage SET limit_bytes=1000000000 WHERE user_id=?').run(a.userId);
  assert((await a.query(task.id)).task.resultsSaved);assert.equal(mock.jobs.size,1);
 }finally{mock.restore();a.db.raw.close();}
});
test('a failed disk write stays tracked and retry overwrites the same destination without double counting',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const task=await a.create(),put=a.bucket.put;
  a.bucket.put=async(...args)=>{await put(...args);throw new Error('disk unavailable');};
  const data=await a.complete(task);assert.equal(data.task.resultsSaved,false);assert.equal(data.task.savedImages.length,0);assert(data.task.saveError);
  const files=JSON.parse(a.db.raw.prepare('SELECT result_files FROM tasks WHERE id=?').get(task.id).result_files);assert.equal(files[0].ready,false);assert.equal(files[0].size,PNG.length);assert(a.bucket.objects.has(files[0].key));
  const before=(await storageUsage(a.env,a.userId)).bytes;a.bucket.put=put;
  const saved=await a.query(task.id);assert(saved.task.resultsSaved);assert.equal(saved.task.saveError,null);assert.equal(a.bucket.objects.size,1);assert((await storageUsage(a.env,a.userId)).bytes<=before);assert.equal(mock.jobs.size,1);
 }finally{mock.restore();a.db.raw.close();}
});
test('failed physical deletion hides the conversation but preserves its generated-file manifest until cleanup succeeds',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const task=await a.create();await a.complete(task);const remove=a.bucket.delete;
  a.bucket.delete=async()=>{throw new Error('disk unavailable');};
  const deleted=await a.req('/api/conversations/'+task.conversationId,{method:'DELETE'});assert((await deleted.json()).cleanupPending);assert.equal(a.bucket.objects.size,1);
  assert.equal((await a.req(`/api/tasks/${task.id}/images/0`)).status,404);assert(a.db.raw.prepare('SELECT result_files FROM tasks WHERE id=?').get(task.id));
  const pending=await (await a.req('/api/storage')).json();assert(pending.pendingCleanup);assert(pending.usedBytes>PNG.length);
  a.bucket.delete=remove;const cleaned=await (await a.req('/api/storage')).json();assert.equal(cleaned.pendingCleanup,false);assert.equal(a.bucket.objects.size,0);assert(!a.db.raw.prepare('SELECT id FROM tasks WHERE id=?').get(task.id));
 }finally{mock.restore();a.db.raw.close();}
});
test('server background checks use the saved original API and archive results without a browser or a new paid task',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const p=await (await a.req('/api/api-profiles',{body:{name:'original',key}})).json();
  const task=await a.create(input,{'x-api-profile':p.profile.id});
  for(let i=0;i<2;i++){a.db.raw.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Math.floor(Date.now()/1000)-6,task.id);assert.equal((await syncPendingResults(a.env)).checked,1);}
  const saved=(await a.query(task.id,{})).task;assert(saved.resultsSaved);assert.equal(mock.jobs.size,1);
  assert.equal(mock.calls.filter(c=>c.url.endsWith('/generations')).length,1);
  a.db.raw.prepare('DELETE FROM api_profiles WHERE user_id=?').run(a.userId);
  assert.equal((await a.req(`/api/tasks/${task.id}/images/0`)).status,200);
  assert.equal((await syncPendingResults(a.env)).checked,0);
 }finally{mock.restore();a.db.raw.close();}
});
test('deleting a conversation during result download prevents a later archive from recreating files',async()=>{
 const mock=mockUpstream(),a=await setup(),base=globalThis.fetch;try{
  const task=await a.create();let release,entered;const started=new Promise(r=>entered=r);
  globalThis.fetch=async(url,options)=>{
   if(String(url).includes('/tasks/'))return Response.json({status:'succeeded',result:{data:[{url:'https://images.example/cat'}]}});
   if(String(url)==='https://images.example/cat'){entered();return new Promise(r=>release=()=>r(new Response(PNG,{headers:{'content-type':'image/png'}})));}
   return base(url,options);
  };
  const query=a.req('/api/tasks/'+task.id,{headers:{'x-jitu-key':key}});await started;
  assert.equal((await a.req('/api/conversations/'+task.conversationId,{method:'DELETE'})).status,200);release();
  assert.equal((await query).status,404);assert.equal(a.bucket.objects.size,0);
 }finally{mock.restore();a.db.raw.close();}
});
test('a stale running response cannot overwrite a completed and archived result',async()=>{
 const mock=mockUpstream(),a=await setup(),base=globalThis.fetch;try{
  const task=await a.create();let release,entered,queries=0;const started=new Promise(r=>entered=r);
  globalThis.fetch=async(url,options)=>{
   if(String(url).includes('/tasks/')){if(++queries===1){entered();return new Promise(r=>release=()=>r(Response.json({status:'running'})));}return Response.json({status:'succeeded',result:{data:[{b64_json:PNG.toString('base64')}]}});}
   return base(url,options);
  };
  const slow=a.req('/api/tasks/'+task.id,{headers:{'x-jitu-key':key}});await started;
  assert((await a.query(task.id)).task.resultsSaved);release();
  const delayed=await (await slow).json();assert.equal(delayed.task.status,'succeeded');assert(delayed.task.resultsSaved);assert.equal(delayed.task.saveError,null);
  assert.equal(a.bucket.objects.size,1);
 }finally{mock.restore();a.db.raw.close();}
});
test('overlapping save attempts share the account lease and produce one file and one quota charge',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const task=await a.create();await a.query(task.id);
  const put=a.bucket.put;let release,entered,writes=0;const started=new Promise(r=>entered=r);
  a.bucket.put=async(...args)=>{writes++;entered();await new Promise(r=>release=r);return put(...args);};
  const first=a.req('/api/tasks/'+task.id,{headers:{'x-jitu-key':key}});await started;
  const second=await a.query(task.id);assert.equal(second.task.status,'succeeded');assert.equal(second.task.resultsSaved,false);
  release();assert((await (await first).json()).task.resultsSaved);assert.equal(writes,1);assert.equal(a.bucket.objects.size,1);
  const manifest=JSON.parse(a.db.raw.prepare('SELECT result_files FROM tasks WHERE id=?').get(task.id).result_files);assert.equal(manifest.length,1);assert.equal(manifest[0].size,PNG.length);
 }finally{mock.restore();a.db.raw.close();}
});
