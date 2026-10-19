import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler,passwordHash,storageUsage,USER_STORAGE_LIMIT,maintainExistingStorage,RELEASES} from '../worker/core.js';
import {localDB} from '../scripts/d1-local.mjs';
import {mockBucket,mockUpstream,PNG} from './fixtures.mjs';
const origin='https://studio.example';
async function setup(){
 const db=localDB(),bucket=mockBucket(),env={DB:db,BUCKET:bucket,API_VAULT_KEY:'a'.repeat(64)},handler=createHandler({});
 const userId=crypto.randomUUID();db.raw.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,1)').run(userId,'storage@example.com',await passwordHash('storage-password-123'));
 let cookie='';
 const req=async(path,body,extra={})=>{const headers={origin,'cf-connecting-ip':'203.0.113.8',...(cookie?{cookie}:{}),...extra.headers};if(body!==undefined&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}const res=await handler.fetch(new Request(origin+path,{method:body===undefined?'GET':'POST',headers,body}),env,{});if(res.headers.has('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return res;};
 assert.equal((await req('/api/auth/password/login',{email:'storage@example.com',password:'storage-password-123'})).status,200);
 return {db,bucket,env,userId,req,close(){db.raw.close();}};
}
async function seed(a,{userId=a.userId,created=1,size=100,status='succeeded',pinned=0,legacy=false}={}){
 const id=crypto.randomUUID(),task=legacy?id:crypto.randomUUID(),key=`references/${userId}/${task}/0-original`;
 if(!legacy)a.db.raw.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at,pinned) VALUES(?,?,?,?,?,?)').run(id,userId,'保存的会话',created,10000000000-created,pinned);
 const refs=[{key,index:0,kind:'image',name:'original.png',type:'image/png',size}];
 a.db.raw.prepare('INSERT INTO tasks(id,user_id,idempotency_key,fingerprint,mode,prompt,model,size,count,status,created_at,updated_at,conversation_id,reference_files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(task,userId,crypto.randomUUID(),'fingerprint','edit','saved prompt','model','1024x1024',1,status,created,created,legacy?null:id,JSON.stringify(refs));
 await a.bucket.put(key,PNG);return {id,task,key};
}
async function exactUsage(a,task,target){
 for(let i=0;i<4;i++){const row=a.db.raw.prepare('SELECT reference_files FROM tasks WHERE id=?').get(task);const refs=JSON.parse(row.reference_files);const used=(await storageUsage(a.env,a.userId)).bytes;refs[0].size+=target-used;a.db.raw.prepare('UPDATE tasks SET reference_files=? WHERE id=?').run(JSON.stringify(refs),task);}
 assert.equal((await storageUsage(a.env,a.userId)).bytes,target);
}
test('release feed is public; acknowledgement persists per account and rejects unknown versions',async()=>{
 const a=await setup();try{
  const feed=await (await a.req('/api/updates')).json();assert.equal(feed.current.version,RELEASES[0].version);assert(feed.current.changes.some(x=>x.includes('1 GB')));
  assert.equal((await (await a.req('/api/me')).json()).user.lastSeenRelease,null);
  assert.equal((await a.req('/api/updates/seen',{version:'future-release'})).status,409);
  assert.equal((await a.req('/api/updates/seen',{version:feed.current.version})).status,200);
  await a.req('/api/auth/logout',{});await a.req('/api/auth/password/login',{email:'storage@example.com',password:'storage-password-123'});
  assert.equal((await (await a.req('/api/me')).json()).user.lastSeenRelease,feed.current.version);
  const outsider=await createHandler({}).fetch(new Request(origin+'/api/updates/seen',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({version:feed.current.version})}),a.env,{});assert.equal(outsider.status,401);
 }finally{a.close();}
});
test('exactly 1 GB fits; overflow removes oldest complete conversations and their files, not other accounts',async()=>{
 const a=await setup();try{
  const other=crypto.randomUUID();a.db.raw.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,1)').run(other,'other@example.com');
  const theirs=await seed(a,{userId:other,size:900000000});
  const oldest=await seed(a,{created:1,size:400000000,pinned:1}),newer=await seed(a,{created:2,size:400000000});
  await exactUsage(a,newer.task,USER_STORAGE_LIMIT);
  let state=await (await a.req('/api/storage')).json();assert.equal(state.usedBytes,USER_STORAGE_LIMIT);assert.equal(state.notice,null);assert(a.bucket.objects.has(oldest.key));
  a.db.raw.prepare("UPDATE tasks SET prompt=prompt||'x' WHERE id=?").run(newer.task);
  state=await (await a.req('/api/storage')).json();assert(state.usedBytes<=USER_STORAGE_LIMIT);assert.equal(state.notice.conversations,1);assert.equal(state.notice.tasks,1);assert(!a.bucket.objects.has(oldest.key));assert(a.bucket.objects.has(newer.key));assert(a.bucket.objects.has(theirs.key));
  const tasks=(await (await a.req('/api/tasks')).json()).tasks;assert(!tasks.some(t=>t.id===oldest.task));assert(tasks.some(t=>t.id===newer.task));
  const chats=(await (await a.req('/api/conversations')).json()).conversations;assert(!chats.some(c=>c.id===oldest.id));
  assert(a.db.raw.prepare('SELECT deleted_at FROM conversations WHERE id=?').get(oldest.id).deleted_at);
  const again=await (await a.req('/api/storage')).json();assert.equal(again.notice.revision,state.notice.revision);
  await a.req('/api/storage/ack',{revision:state.notice.revision});assert.equal((await (await a.req('/api/storage')).json()).notice,null);
  assert(a.db.raw.prepare('SELECT id FROM tasks WHERE id=?').get(theirs.task));
 }finally{a.close();}
});
test('legacy conversations are also cleaned and interrupted file deletion retains tracked bytes and a durable notice',async()=>{
 const a=await setup();try{
  const old=await seed(a,{legacy:true,created:1,size:600000000});await seed(a,{created:2,size:600000000});
  const originalDelete=a.bucket.delete;a.bucket.delete=async()=>{throw new Error('temporarily unavailable');};
  let state=await (await a.req('/api/storage')).json();assert(state.cleanupError);assert.equal(state.pendingCleanup,true);assert.equal(state.notice.conversations,1);assert(state.usedBytes>USER_STORAGE_LIMIT);assert(a.bucket.objects.has(old.key));
  assert(a.db.raw.prepare('SELECT reference_files FROM tasks WHERE id=?').get(old.task));
  assert.equal((await a.req(`/api/tasks/${old.task}/references/0`)).status,404);
  assert(!(await (await a.req('/api/tasks')).json()).tasks.some(t=>t.id===old.task));
  a.bucket.delete=originalDelete;state=await (await a.req('/api/storage')).json();assert.equal(state.cleanupError,null);assert.equal(state.pendingCleanup,false);assert(state.usedBytes<USER_STORAGE_LIMIT);assert(!a.bucket.objects.has(old.key));assert.equal(state.notice.conversations,1);
 }finally{a.close();}
});
test('over-quota uploads are checked before paid upstream calls and ongoing work is preserved',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const busy=await seed(a,{created:Math.floor(Date.now()/1000),status:'running',size:999990000});await exactUsage(a,busy.task,USER_STORAGE_LIMIT-1000);
  const f=new FormData();for(const [k,v]of Object.entries({mode:'edit',model:'model',prompt:'new task',size:'1024x1024',n:1}))f.set(k,String(v));f.set('image',new File([PNG],'new.png',{type:'image/png'}));
  const r=await a.req('/api/tasks',f,{headers:{'x-jitu-key':'sk-jitu-test-only-key','idempotency-key':crypto.randomUUID()}});assert.equal(r.status,507);assert.equal(mock.calls.length,0);assert(a.bucket.objects.has(busy.key));assert(a.db.raw.prepare('SELECT id FROM tasks WHERE id=?').get(busy.task));
 }finally{mock.restore();a.close();}
});
test('preflight reserves uploaded originals and concurrent handlers cannot bypass the account lease',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const old=await seed(a,{size:999990000});await exactUsage(a,old.task,USER_STORAGE_LIMIT-1000);
  let release,started;const entered=new Promise(resolve=>started=resolve);const originalPut=a.bucket.put;
  a.bucket.put=async(...args)=>{started();await new Promise(resolve=>release=resolve);return originalPut(...args);};
  const form=()=>{const f=new FormData();for(const [k,v]of Object.entries({mode:'edit',model:'model',prompt:'new task',size:'1024x1024',n:1}))f.set(k,String(v));f.set('image',new File([PNG],'new.png',{type:'image/png'}));return f;};
  const headers={'x-jitu-key':'sk-jitu-test-only-key','idempotency-key':crypto.randomUUID()};const first=a.req('/api/tasks',form(),{headers});await entered;
  const second=await a.req('/api/tasks',form(),{headers:{...headers,'idempotency-key':crypto.randomUUID()}});assert.equal(second.status,429);
  release();assert.equal((await first).status,202);assert.equal(mock.jobs.size,1);assert(!a.bucket.objects.has(old.key));assert((await storageUsage(a.env,a.userId)).bytes<=USER_STORAGE_LIMIT);
 }finally{mock.restore();a.close();}
});
test('partial uploads remain accounted for until their manifests can be physically removed',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  let calls=0;const put=a.bucket.put;
  a.bucket.put=async(...args)=>{if(++calls===2)throw new Error('disk full');return put(...args);};
  a.bucket.delete=async()=>{throw new Error('delete unavailable');};
  const f=new FormData();for(const [k,v]of Object.entries({mode:'edit',model:'model',prompt:'new task',size:'1024x1024',n:1}))f.set(k,String(v));for(let i=0;i<2;i++)f.append('image',new File([PNG],'new.png',{type:'image/png'}));
  const r=await a.req('/api/tasks',f,{headers:{'x-jitu-key':'sk-jitu-test-only-key','idempotency-key':crypto.randomUUID()}});assert.equal(r.status,503);assert.equal(mock.calls.length,0);assert.equal(a.bucket.objects.size,1);
  const row=a.db.raw.prepare('SELECT * FROM tasks').get();assert.equal(row.references_ready,0);assert.equal(JSON.parse(row.reference_files).length,2);assert((await storageUsage(a.env,a.userId)).bytes>=2*PNG.length);
  assert.equal((await a.req(`/api/tasks/${row.id}/references/0`)).status,503);
 }finally{mock.restore();a.close();}
});
test('startup applies quotas to existing inactive users and preserves cleanup notifications',async()=>{
 const a=await setup();try{
  const old=await seed(a,{size:700000000});await seed(a,{created:2,size:700000000});
  assert.deepEqual(await maintainExistingStorage(a.env),{failures:0});assert(!a.bucket.objects.has(old.key));assert((await storageUsage(a.env,a.userId)).bytes<=USER_STORAGE_LIMIT);
  const state=await (await a.req('/api/storage')).json();assert(state.notice);assert.equal(state.notice.conversations,1);
 }finally{a.close();}
});
test('stale acknowledgements cannot hide a newer cleanup event; expired leases can be recovered',async()=>{
 const a=await setup();try{
  const old=await seed(a,{size:600000000});const keep=await seed(a,{created:2,size:600000000});
  const first=await (await a.req('/api/storage')).json();assert(first.notice);
  await seed(a,{created:3,size:600000000});const second=await (await a.req('/api/storage')).json();assert(second.notice.revision>first.notice.revision);
  await a.req('/api/storage/ack',{revision:first.notice.revision});assert.equal((await (await a.req('/api/storage')).json()).notice.revision,second.notice.revision);
  a.db.raw.prepare('UPDATE account_storage SET lease_token=?,lease_until=1 WHERE user_id=?').run('dead-process',a.userId);
  assert.equal((await a.req('/api/storage')).status,200);
 }finally{a.close();}
});

test('a new task that fits exactly does not delete any old conversation',async()=>{
 const mock=mockUpstream(),a=await setup();try{
  const old=await seed(a,{size:900000000});
  const params={mode:'text',model:'model',prompt:'new task',size:'1024x1024',n:1};
  const taskBytes=4096+Buffer.byteLength(params.model+params.prompt+params.size),chatBytes=512+Buffer.byteLength(params.prompt);
  await exactUsage(a,old.task,USER_STORAGE_LIMIT-taskBytes-chatBytes);
  const r=await a.req('/api/tasks',params,{headers:{'x-jitu-key':'sk-jitu-test-only-key','idempotency-key':crypto.randomUUID()}});
  assert.equal(r.status,202);assert(a.bucket.objects.has(old.key));assert.equal((await storageUsage(a.env,a.userId)).bytes,USER_STORAGE_LIMIT);assert.equal((await (await a.req('/api/storage')).json()).notice,null);
 }finally{mock.restore();a.close();}
});
