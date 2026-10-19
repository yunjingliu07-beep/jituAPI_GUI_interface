import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDB} from '../scripts/d1-local.mjs';
import {createHandler,passwordHash,sha} from '../worker/core.js';
import {setInitialOwner} from '../server/set-owner.mjs';
import {mockBucket,mockUpstream} from './fixtures.mjs';

const origin='https://studio.example',password='invitation-test-password';
async function setup(){
 const db=localDB(),mock=mockUpstream(),env={DB:db,API_VAULT_KEY:'1'.repeat(64),BUCKET:mockBucket(),RESEND_API_KEY:'test-only',EMAIL_FROM:'Studio <test@example.com>'},handler=createHandler({}),accounts={};
 db.raw.exec('PRAGMA foreign_keys=ON');
 const hash=await passwordHash(password),t=Math.floor(Date.now()/1000);
 for(const [name,role] of [['owner','owner'],['admin','admin'],['other','admin'],['member','member']]){
  const id=randomUUID(),email=name+'@example.com',token=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
  db.raw.prepare('INSERT INTO users(id,email,password_hash,created_at,role) VALUES(?,?,?,?,?)').run(id,email,hash,t,role);
  db.raw.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,verified_at) VALUES(?,?,?,0)').run(await sha(token),id,t+3600);
  accounts[name]={id,email,cookie:'__Host-jitu='+token};
 }
 return {db,env,mock,accounts,close(){mock.restore();db.raw.close();},async req(path,body,actor=null,extra={}){
  const headers={origin,'cf-connecting-ip':'203.0.113.10',...(actor?{cookie:accounts[actor]?.cookie||actor}:{}),...extra};if(body!==undefined)headers['Content-Type']='application/json';
  return handler.fetch(new Request(origin+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)}),env,{});
 }};
}
async function createInvite(a,actor='owner',count=1,extra={}){const r=await a.req('/api/admin/invites',{count,...extra},actor);assert.equal(r.status,201,await r.clone().text());return (await r.json()).invitations;}
async function otp(a,email,inviteCode){const r=await a.req('/api/auth/code/send',{email,purpose:'register',inviteCode});assert.equal(r.status,200,await r.clone().text());return a.mock.mail.at(-1).text.match(/验证码：(\d{6})/)[1];}
const registration=(email,code,inviteCode)=>({email,code,inviteCode,password,confirmPassword:password,role:'owner'});

test('existing members log in and reset passwords without invitations; public API advertises the requirement',async()=>{
 const a=await setup();try{
  assert.equal((await (await a.req('/api/config')).json()).registrationRequiresInvitation,true);
  const login=await a.req('/api/auth/password/login',{email:'member@example.com',password});assert.equal(login.status,200);assert.equal((await login.json()).user.role,'member');
  assert.equal((await a.req('/api/auth/code/send',{email:'member@example.com',purpose:'reset'})).status,200);
  const code=a.mock.mail.at(-1).text.match(/验证码：(\d{6})/)[1];
  assert.equal((await a.req('/api/auth/password/reset',{email:'member@example.com',code,password:'changed-password-123',confirmPassword:'changed-password-123'})).status,200);
  assert.equal(a.db.raw.prepare('SELECT invitation_id FROM users WHERE email=?').get('member@example.com').invitation_id,null);
 }finally{a.close();}
});
test('registration and email delivery both require a valid invitation; expired and revoked codes send no mail',async()=>{
 const a=await setup();try{
  const items=await createInvite(a,'owner',3);
  a.db.raw.prepare('UPDATE registration_invitations SET expires_at=1 WHERE id=?').run(items[1].id);
  assert.equal((await a.req(`/api/admin/invites/${items[2].id}/revoke`,{},'owner')).status,200);
  for(const inviteCode of [undefined,'MEOW-invalid',items[1].code,items[2].code]){
   assert.equal((await a.req('/api/auth/code/send',{email:'new@example.com',purpose:'register',inviteCode})).status,400);
   assert.equal((await a.req('/api/auth/password/register',registration('new@example.com','123456',inviteCode))).status,400);
  }
  assert.equal(a.mock.mail.length,0);
  const code=await otp(a,'new@example.com',items[0].code.toLowerCase());
  const response=await a.req('/api/auth/password/register',registration('new@example.com',code,items[0].code));assert.equal(response.status,201);assert.equal((await response.json()).user.role,'member');
  const row=a.db.raw.prepare('SELECT * FROM registration_invitations WHERE id=?').get(items[0].id),member=a.db.raw.prepare('SELECT * FROM users WHERE email=?').get('new@example.com');
  assert.equal(row.used_by,member.id);assert.equal(member.invitation_id,items[0].id);assert(row.used_at);assert.equal(member.role,'member');
  assert.equal((await a.req('/api/auth/code/send',{email:'next@example.com',purpose:'register',inviteCode:items[0].code})).status,400);
 }finally{a.close();}
});
test('members cannot use admin APIs or promote themselves through spoofed roles and headers',async()=>{
 const a=await setup();try{
  for(const path of ['/api/admin/invites','/api/admin/members']){
   assert.equal((await a.req(path)).status,401);
   assert.equal((await a.req(path,undefined,'member',{'x-user-role':'owner','oai-authenticated-user-email':'owner@example.com'})).status,403);
   assert.equal((await a.req(path,{count:1,email:'member@example.com',action:'grant',role:'owner'},'member')).status,403);
  }
  assert.equal(a.db.raw.prepare('SELECT role FROM users WHERE id=?').get(a.accounts.member.id).role,'member');
 }finally{a.close();}
});
test('admins only list and revoke their own codes; only the owner manages administrators',async()=>{
 const a=await setup();try{
  const [own]=await createInvite(a,'admin'),[other]=await createInvite(a,'other');
  const list=await (await a.req('/api/admin/invites',undefined,'admin')).json();assert.equal(list.total,1);assert.equal(list.invitations[0].id,own.id);
  assert.equal((await a.req(`/api/admin/invites/${other.id}/revoke`,{},'admin')).status,404);
  assert.equal((await a.req(`/api/admin/invites/${own.id}/revoke`,{},'admin')).status,200);
  assert.equal((await a.req(`/api/admin/invites/${other.id}/revoke`,{},'owner')).status,200);
  for(const body of [undefined,{email:'member@example.com',action:'grant'}])assert.equal((await a.req('/api/admin/members',body,'admin')).status,403);
  assert.equal((await a.req('/api/admin/members',{email:'absent@example.com',action:'grant'},'owner')).status,404);
  assert.equal((await a.req('/api/admin/members',{email:'owner@example.com',action:'revoke'},'owner')).status,403);
  assert.equal((await a.req('/api/admin/members',{email:'member@example.com',action:'grant'},'owner')).status,200);
  assert.equal((await (await a.req('/api/me',undefined,'member')).json()).user.role,'admin');
  assert.equal((await a.req('/api/admin/invites',{count:1},'member')).status,201);
 }finally{a.close();}
});
test('full codes are shown only when created, never in lists or database; bounds and pagination are validated',async()=>{
 const a=await setup();try{
  for(const fields of [{count:0},{count:21},{count:1.5},{count:1,expiresInDays:2},{count:1,label:'x'.repeat(61)}])assert.equal((await a.req('/api/admin/invites',fields,'admin')).status,400);
  const first=await createInvite(a,'admin',20,{expiresInDays:30,label:'设计组'});await createInvite(a,'admin',20);await createInvite(a,'admin',11);
  const list=await (await a.req('/api/admin/invites',undefined,'admin')).json();assert.equal(list.total,51);assert.equal(list.invitations.length,50);assert.equal(list.nextOffset,50);
  const next=await (await a.req('/api/admin/invites?offset=50',undefined,'admin')).json();assert.equal(next.invitations.length,1);assert.equal(next.nextOffset,null);
  const all=JSON.stringify([...list.invitations,...next.invitations]),stored=JSON.stringify(a.db.raw.prepare('SELECT * FROM registration_invitations').all());
  for(const i of first){assert.match(i.code,/^MEOW-(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);assert(!all.includes(i.code));assert(!stored.includes(i.code));assert(!stored.includes(i.code.replaceAll('-','').slice(4)));}
  assert(!all.includes('code_hash'));assert(!all.includes('"code":'));assert(all.includes('设计组'));
  assert.equal(first[0].expiresAt-a.db.raw.prepare('SELECT created_at FROM registration_invitations WHERE id=?').get(first[0].id).created_at,30*86400);
  assert.equal((await a.req('/api/admin/invites?offset=-1',undefined,'owner')).status,400);
 }finally{a.close();}
});
test('two different emails racing for one invitation create exactly one member',async()=>{
 const a=await setup();try{
  const [invite]=await createInvite(a),codes=[];for(const email of ['first@example.com','second@example.com'])codes.push(await otp(a,email,invite.code));
  const responses=await Promise.all(['first@example.com','second@example.com'].map((email,i)=>a.req('/api/auth/password/register',registration(email,codes[i],invite.code))));
  assert.equal(responses.filter(r=>r.status===201).length,1);assert(responses.every(r=>[201,400,409].includes(r.status)));
  assert.equal(a.db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE invitation_id=?').get(invite.id).n,1);
  const item=a.db.raw.prepare('SELECT used_by FROM registration_invitations WHERE id=?').get(invite.id);assert(item.used_by);
  assert.equal(a.db.raw.prepare('SELECT invitation_id FROM users WHERE id=?').get(item.used_by).invitation_id,invite.id);
  assert.equal((await a.req(`/api/admin/invites/${invite.id}/revoke`,{},'owner')).status,404);
 }finally{a.close();}
});
test('wrong email code and duplicate accounts do not consume an invitation',async()=>{
 const a=await setup();try{
  const [invite]=await createInvite(a),code=await otp(a,'new@example.com',invite.code),wrong=code==='000000'?'000001':'000000';
  assert.equal((await a.req('/api/auth/password/register',registration('new@example.com',wrong,invite.code))).status,400);
  assert.equal((await a.req('/api/auth/password/register',registration('member@example.com',code,invite.code))).status,409);
  assert.equal(a.db.raw.prepare('SELECT used_by FROM registration_invitations WHERE id=?').get(invite.id).used_by,null);
  assert.equal((await a.req('/api/auth/password/register',registration('new@example.com',code,invite.code))).status,201);
 }finally{a.close();}
});
test('revoking admin rights invalidates live sessions and unused codes while existing invitees still log in',async()=>{
 const a=await setup();try{
  const [used,unused]=await createInvite(a,'admin',2),code=await otp(a,'invitee@example.com',used.code);
  assert.equal((await a.req('/api/auth/password/register',registration('invitee@example.com',code,used.code))).status,201);
  assert.equal((await a.req('/api/admin/members',{email:'admin@example.com',action:'revoke'},'owner')).status,200);
  assert.equal((await a.req('/api/admin/invites',undefined,'admin')).status,403);
  assert.equal((await (await a.req('/api/me',undefined,'admin')).json()).user.role,'member');
  assert(a.db.raw.prepare('SELECT revoked_at FROM registration_invitations WHERE id=?').get(unused.id).revoked_at);
  assert.equal((await a.req('/api/auth/code/send',{email:'later@example.com',purpose:'register',inviteCode:unused.code})).status,400);
  assert.equal((await a.req('/api/auth/password/login',{email:'invitee@example.com',password})).status,200);
  assert.equal((await a.req('/api/auth/password/login',{email:'admin@example.com',password})).status,200);
  assert.equal((await a.req('/api/admin/members',{email:'admin@example.com',action:'grant'},'owner')).status,200);
  assert.equal((await a.req('/api/auth/code/send',{email:'later@example.com',purpose:'register',inviteCode:unused.code})).status,400);
 }finally{a.close();}
});
test('database insert rechecks invitation availability if it is revoked after validation',async()=>{
 const a=await setup();try{
  const [invite]=await createInvite(a),code=await otp(a,'new@example.com',invite.code),db=a.env.DB;
  a.env.DB={...db,prepare(sql){const q=db.prepare(sql);if(sql.startsWith('INSERT INTO users ')){const bind=q.bind;q.bind=(...args)=>{db.raw.prepare('UPDATE registration_invitations SET revoked_at=1 WHERE id=?').run(invite.id);return bind(...args);};}return q;}};
  assert.equal((await a.req('/api/auth/password/register',registration('new@example.com',code,invite.code))).status,409);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE invitation_id=?').get(invite.id).n,0);
  assert.equal(db.raw.prepare('SELECT used_by FROM registration_invitations WHERE id=?').get(invite.id).used_by,null);
 }finally{a.close();}
});
test('demotion during bulk generation returns no usable codes',async()=>{
 const a=await setup();try{
  const db=a.env.DB;a.env.DB={...db,batch(statements){db.raw.prepare("UPDATE users SET role='member' WHERE id=?").run(a.accounts.admin.id);return db.batch(statements);}};
  assert.equal((await a.req('/api/admin/invites',{count:5},'admin')).status,403);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM registration_invitations').get().n,0);
 }finally{a.close();}
});
test('console bootstrap requires an existing account and never replaces an established owner',async()=>{
 const db=localDB();try{
  db.raw.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,1)').run('first','first@example.com');
  db.raw.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,1)').run('second','second@example.com');
  assert.throws(()=>setInitialOwner(db.raw,'missing@example.com'),/No registered/);
  assert.throws(()=>setInitialOwner(db.raw,'invalid'),/existing site account/);
  assert.equal(setInitialOwner(db.raw,' FIRST@example.com ').role,'owner');assert.equal(setInitialOwner(db.raw,'first@example.com').ok,true);
  assert.throws(()=>setInitialOwner(db.raw,'second@example.com'),/already exists/);
  assert.equal(db.raw.prepare('SELECT role FROM users WHERE id=?').get('second').role,'member');
  assert.throws(()=>db.raw.prepare("UPDATE users SET role='owner' WHERE id='second'").run(),/UNIQUE/);
 }finally{db.raw.close();}
});
