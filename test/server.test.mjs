import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {migrate,databaseFile} from '../server/database.mjs';
import {createServer} from '../server/index.mjs';
import {mockUpstream,PNG,seedInvitation} from './fixtures.mjs';

const origin='https://preview.example.com',vaultKey='a'.repeat(64);
async function launch(dataDir,mail){
 const server=await createServer({origin,dataDir,vaultKey,resendApiKey:"test-only",emailFrom:"image meow <test@example.com>"});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 let cookie='';
 return {server,async close(){const closed=once(server,'close');server.close();await closed;},async request(path,{body,method,headers={}}={}){
  if(path==='/api/auth/password/register'&&body?.email&&!body.code&&headers.origin!=='https://evil.example'){
   const seedDB=new DatabaseSync(databaseFile(dataDir));const inviteCode=seedInvitation(seedDB);seedDB.close();body={...body,inviteCode};
   const codeResponse=await this.request('/api/auth/code/send',{body:{email:body.email,purpose:'register',inviteCode}});assert.equal(codeResponse.status,200);body={...body,code:mail.mail.at(-1).text.match(/验证码：(\d{6})/)[1]};
  }
  const h={host:new URL(origin).host,origin,'x-real-ip':'203.0.113.7',...(cookie?{cookie}:{}),...headers};
  if(body!==undefined&&!(body instanceof FormData)){h['Content-Type']='application/json';body=JSON.stringify(body);}
  const request=new Request(base+path,{method:method||(body===undefined?'GET':'POST'),headers:h,body});
  const bytes=body===undefined?undefined:Buffer.from(await request.arrayBuffer());
  const response=await new Promise((resolve,reject)=>{
   const upstream=httpRequest(base+path,{method:request.method,headers:Object.fromEntries(request.headers)},incoming=>{
    const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('error',reject);
    incoming.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:incoming.statusCode,headers:incoming.headers})));
   });upstream.on('error',reject);upstream.end(bytes);
  });
  if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return response;
 }};
}

test('self-host migration upgrades an existing database without replacing account records',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meow-migration-'));
 try{
  const db=new DatabaseSync(databaseFile(dir));
  db.exec(await readFile(new URL('../drizzle/0000_studio.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)').run('original-account','old@example.com','original-hash',1);db.close();
  migrate(dir);migrate(dir);
  const upgraded=new DatabaseSync(databaseFile(dir));
  assert.equal(upgraded.prepare('SELECT password_hash FROM users WHERE id=?').get('original-account').password_hash,'original-hash');
  assert(upgraded.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='api_key_hash'));
  assert(upgraded.prepare('PRAGMA table_info(conversations)').all().some(c=>c.name==='pinned'));
  assert(upgraded.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='last_seen_release'));
  assert(upgraded.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='references_ready'));
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM account_storage').get().n,0);
  assert.equal(upgraded.prepare('SELECT role FROM users').get().role,'member');
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM registration_invitations').get().n,0);
  upgraded.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('self-host origin checks work behind Nginx and forwarded headers cannot bypass host or rate checks',async()=>{
 const mock=mockUpstream(),dir=await mkdtemp(join(tmpdir(),'meow-proxy-'));migrate(dir);const app=await launch(dir,mock);
 try{
  assert.equal((await app.request('/healthz')).status,200);
  assert.equal((await app.request('/',{headers:{host:'evil.example'}})).status,421);
  assert.equal((await app.request('/api/auth/password/register',{body:{},headers:{origin:'https://evil.example'}})).status,403);
  const body={email:'proxy@example.com',password:'test-password-123',confirmPassword:'test-password-123'};
  let r=await app.request('/api/auth/password/register',{body,headers:{'x-forwarded-proto':'http','x-forwarded-host':'evil.example','cf-connecting-ip':'10.1.2.3'}});
  assert.equal(r.status,201);assert.match(r.headers.get('set-cookie'),/Secure/);
  assert.equal((await (await app.request('/api/me')).json()).user.email,body.email);
  const db=new DatabaseSync(databaseFile(dir));
  assert(db.prepare('SELECT key FROM rate_limits WHERE key=?').get('register-ip:203.0.113.7'));
  assert(!db.prepare('SELECT key FROM rate_limits WHERE key=?').get('register-ip:10.1.2.3'));db.close();
  assert.equal((await app.request('/server.env')).status,404);
  assert.equal((await app.request('/studio.sqlite')).status,404);
  assert.equal((await app.request('/references/anything')).status,404);
 }finally{await app.close();mock.restore();await rm(dir,{recursive:true,force:true});}
});

test('self-host persists encrypted API profiles, conversations and private reference images across restart',async()=>{
 const mock=mockUpstream(),dir=await mkdtemp(join(tmpdir(),'meow-durable-'));migrate(dir);let app=await launch(dir,mock);
 try{
  const account={email:'durable@example.com',password:'test-password-123',confirmPassword:'test-password-123'};
  assert.equal((await app.request('/api/auth/password/register',{body:account})).status,201);
  const roleDB=new DatabaseSync(databaseFile(dir));roleDB.prepare("UPDATE users SET role='admin' WHERE email=?").run(account.email);roleDB.close();
  const inviteResponse=await app.request('/api/admin/invites',{body:{count:2}});assert.equal(inviteResponse.status,201);const invites=(await inviteResponse.json()).invitations;
  let r=await app.request('/api/api-profiles',{body:{name:'我的 API',key:'sk-jitu-self-host-test'}});
  assert.equal(r.status,201);const profile=(await r.json()).profile;
  const form=new FormData(),conversationId=crypto.randomUUID();
  for(const [k,v] of Object.entries({mode:'edit',model:'gpt-image-2.5-flare',prompt:'一只小猫',size:'1024x1024',n:1,conversationId}))form.set(k,String(v));
  form.set('image',new File([PNG],'cat.png',{type:'image/png'}));
  r=await app.request('/api/tasks',{body:form,headers:{'x-api-profile':profile.id,'idempotency-key':crypto.randomUUID()}});
  assert.equal(r.status,202);const task=(await r.json()).task;
  assert.equal(mock.jobs.size,1);
  const release=(await (await app.request('/api/updates')).json()).current.version;
  assert.equal((await app.request('/api/updates/seen',{body:{version:release}})).status,200);
  await app.close();migrate(dir);app=await launch(dir,mock);
  assert.equal((await app.request('/api/auth/password/login',{body:account})).status,200);
  const me=(await (await app.request('/api/me')).json()).user;assert.equal(me.lastSeenRelease,release);assert.equal(me.role,'admin');
  const savedInvites=await (await app.request('/api/admin/invites')).json();assert.equal(savedInvites.total,2);assert(savedInvites.invitations.some(i=>i.id===invites[0].id));
  assert.equal((await app.request('/api/auth/code/send',{body:{email:'invited-after-restart@example.com',purpose:'register',inviteCode:invites[0].code}})).status,200);
  const storage=await (await app.request('/api/storage')).json();assert(storage.usedBytes>0);assert.equal(storage.limitBytes,1000000000);
  const profiles=await (await app.request('/api/api-profiles')).json();
  assert.equal(profiles.profiles[0].id,profile.id);assert(!JSON.stringify(profiles).includes('sk-jitu-self-host-test'));
  const conversations=await (await app.request('/api/conversations')).json();
  assert(conversations.conversations.some(c=>c.id===conversationId));
  r=await app.request(`/api/tasks/${task.id}/references/0`);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),PNG);
  const header={'x-api-profile':profile.id};
  await app.request(`/api/tasks/${task.id}`,{headers:header});
  r=await app.request(`/api/tasks/${task.id}`,{headers:header});assert.equal((await r.json()).task.status,'succeeded');
  r=await app.request(`/api/tasks/${task.id}/images/0`,{headers:header});assert.deepEqual(Buffer.from(await r.arrayBuffer()),PNG);
  const other={email:'other@example.com',password:'other-password-123',confirmPassword:'other-password-123'};
  await app.request('/api/auth/password/register',{body:other});
  assert.equal((await app.request(`/api/tasks/${task.id}/references/0`)).status,404);
 }finally{await app.close();mock.restore();await rm(dir,{recursive:true,force:true});}
});
