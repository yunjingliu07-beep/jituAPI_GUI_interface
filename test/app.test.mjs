import {test} from 'node:test';import assert from 'node:assert/strict';
import {createHandler,sha,passwordHash,passwordMatches,validateParams,imageInfo,safeImageURL} from '../worker/core.js';
import {localDB} from '../scripts/d1-local.mjs';import {mockUpstream,PNG} from './fixtures.mjs';
const origin='https://studio.example';
function app(){const db=localDB();const env={DB:db,RESEND_API_KEY:'test-only',EMAIL_FROM:'Studio <test@example.com>'};const h=createHandler({});let cookie='';return {env,db,async req(path,body,extra={}){const headers={origin,'cf-connecting-ip':'203.0.113.9',...extra.headers};if(cookie)headers.cookie=cookie;let payload=body;if(body!==undefined&&!(body instanceof FormData)){headers['Content-Type']='application/json';payload=JSON.stringify(body);}const req=new Request(origin+path,{method:body===undefined?'GET':'POST',headers,body:payload});const res=await h.fetch(req,env,{});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return res;},setCookie(v){cookie=v;},getCookie(){return cookie;}};}
async function login(a,email='alice@example.com'){const body={email,password:'test-password-123',confirmPassword:'test-password-123'};const r=await a.req('/api/auth/password/register',body);return r.status===409?a.req('/api/auth/password/login',body):r;}
const params={mode:'text',model:'gpt-image-2.5-flare',prompt:'一只戴围巾的小猫',size:'1024x1024',n:1};
const keyHeaders={'x-jitu-key':'sk-jitu-test-only-key'};
test('password hash uses salt and verifies without storing plaintext',async()=>{const h=await passwordHash('correct horse battery');assert(!h.includes('correct'));assert(await passwordMatches('correct horse battery',h));assert(!await passwordMatches('wrong',h));assert.notEqual(h,await passwordHash('correct horse battery'));});
test('parameter, file and image URL validation',()=>{assert.equal(validateParams(params).n,1);for(const p of [{...params,n:0},{...params,size:'4K'},{...params,prompt:''},{...params,mode:'unknown'}])assert.throws(()=>validateParams(p));assert.equal(imageInfo(PNG).width,1);assert.throws(()=>imageInfo(Buffer.from('not image')));for(const u of ['http://127.0.0.1/x','https://169.254.169.254/x','https://localhost/x','https://host.internal/x','file:///etc/passwd','https://user:pass@example.com/x'])assert.throws(()=>safeImageURL(u));assert.equal(safeImageURL('https://images.example.com/a.png').hostname,'images.example.com');});
test('password registration, duplicate protection, sign-in and logout without mail',async()=>{
 const a=app();delete a.env.RESEND_API_KEY;delete a.env.EMAIL_FROM;
 try{let r=await a.req('/api/auth/password/register',{email:' NEW@Example.com ',password:'test-password-123',confirmPassword:'test-password-123'});assert.equal(r.status,201);assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);assert.equal((await r.json()).user.email,'new@example.com');
 const id=a.db.raw.prepare('SELECT id FROM users WHERE email=?').get('new@example.com').id;
 r=await a.req('/api/auth/password/register',{email:'new@example.com',password:'takeover-password',confirmPassword:'takeover-password'});assert.equal(r.status,409);assert.equal(a.db.raw.prepare('SELECT id FROM users WHERE email=?').get('new@example.com').id,id);
 r=await a.req('/api/auth/logout',{});assert.equal(r.status,200);assert.equal((await (await a.req('/api/me')).json()).user,null);
 r=await a.req('/api/auth/password/login',{email:'new@example.com',password:'takeover-password'});assert.equal(r.status,401);
 r=await a.req('/api/auth/password/login',{email:'new@example.com',password:'test-password-123'});assert.equal(r.status,200);assert.equal((await r.json()).user.hasPassword,true);
 const concurrent=await Promise.all([login(a,'concurrent@example.com'),login(a,'concurrent@example.com')]);assert(concurrent.every(r=>r.status===200||r.status===201));assert.equal(a.db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE email=?').get('concurrent@example.com').n,1);
 }finally{a.db.raw.close();}
});
test('verification and hosted-login endpoints stay disabled even with mail credentials',async()=>{
 const mock=mockUpstream(),a=app();try{const config=await (await a.req('/api/config')).json();assert.deepEqual(config.authMethods,['password']);assert.equal(config.emailCodeEnabled,false);
 for(const route of ['/api/auth/code/send','/api/auth/code/login','/api/auth/owner']){const r=await a.req(route,{email:'alice@example.com',code:'123456'},{headers:{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'alice@example.com'}});assert.equal(r.status,403);}
 assert.equal(mock.mail.length,0);assert.equal(a.db.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
 }finally{mock.restore();a.db.raw.close();}
});
test('registration validates password and confirmation; CSRF and unauthenticated access blocked',async()=>{
 const a=app();try{for(const fields of [{email:'bad',password:'test-password-123',confirmPassword:'test-password-123'},{email:'new@example.com',password:'short',confirmPassword:'short'},{email:'new@example.com',password:'test-password-123',confirmPassword:'different-password'}])assert.equal((await a.req('/api/auth/password/register',fields)).status,400);
 assert.equal((await a.req('/api/tasks')).status,401);assert.equal((await a.req('/api/auth/password/set',{password:'new-password-123',confirmPassword:'new-password-123'})).status,401);
 assert.equal((await a.req('/api/auth/password/register',{email:'a@b.com',password:'test-password-123',confirmPassword:'test-password-123'},{headers:{origin:'https://evil.example'}})).status,403);
 }finally{a.db.raw.close();}
});
test('password change verifies current password and invalidates other sessions',async()=>{
 const a=app();try{await login(a);const firstCookie=a.getCookie();await a.req('/api/auth/password/login',{email:'alice@example.com',password:'test-password-123'});const secondCookie=a.getCookie();a.setCookie(firstCookie);
 // A previously verified email session must not bypass the current password check.
 a.db.raw.prepare('UPDATE sessions SET verified_at=?').run(Math.floor(Date.now()/1000));
 let r=await a.req('/api/auth/password/set',{password:'new-password-123',confirmPassword:'new-password-123'});assert.equal(r.status,400);
 r=await a.req('/api/auth/password/set',{password:'new-password-123',confirmPassword:'new-password-123',currentPassword:'wrong'});assert.equal(r.status,403);
 r=await a.req('/api/auth/password/set',{password:'new-password-123',confirmPassword:'mismatch',currentPassword:'test-password-123'});assert.equal(r.status,400);
 r=await a.req('/api/auth/password/set',{password:'new-password-123',confirmPassword:'new-password-123',currentPassword:'test-password-123'});assert.equal(r.status,200);const newCookie=a.getCookie();
 for(const old of [firstCookie,secondCookie]){a.setCookie(old);assert.equal((await (await a.req('/api/me')).json()).user,null);}
 a.setCookie(newCookie);assert.equal((await (await a.req('/api/me')).json()).user.email,'alice@example.com');
 assert.equal((await a.req('/api/auth/password/login',{email:'alice@example.com',password:'test-password-123'})).status,401);
 assert.equal((await a.req('/api/auth/password/login',{email:'alice@example.com',password:'new-password-123'})).status,200);
 }finally{a.db.raw.close();}
});
test('legacy passwordless accounts need an existing authenticated session to set a password',async()=>{
 const a=app();try{const token='a'.repeat(64),t=Math.floor(Date.now()/1000);a.db.raw.prepare('INSERT INTO users (id,email,created_at) VALUES (?,?,?)').run('legacy-user','legacy@example.com',t);
 assert.equal((await login(a,'legacy@example.com')).status,401);
 assert.equal((await a.req('/api/auth/password/register',{email:'legacy@example.com',password:'takeover-password',confirmPassword:'takeover-password'})).status,409);
 a.db.raw.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,verified_at) VALUES (?,?,?,0)').run(await sha(token),'legacy-user',t+1000);a.setCookie('__Host-jitu='+token);
 assert.equal((await a.req('/api/auth/password/set',{password:'first-password-123',confirmPassword:'first-password-123'})).status,200);
 assert.equal(a.db.raw.prepare('SELECT id FROM users WHERE email=?').get('legacy@example.com').id,'legacy-user');
 assert.equal((await a.req('/api/auth/password/login',{email:'legacy@example.com',password:'first-password-123'})).status,200);
 }finally{a.db.raw.close();}
});
test('generation, idempotency, polling, private history and binary download',async()=>{const mock=mockUpstream(),a=app();try{await login(a);const idem=crypto.randomUUID();let r=await a.req('/api/tasks',params,{headers:{...keyHeaders,'idempotency-key':idem}});assert.equal(r.status,202);const task=(await r.json()).task;assert.equal(task.status,'queued');r=await a.req('/api/tasks',params,{headers:{...keyHeaders,'idempotency-key':idem}});assert.equal(r.status,200);assert.equal(mock.jobs.size,1);r=await a.req('/api/tasks',{...params,prompt:'different'},{headers:{...keyHeaders,'idempotency-key':idem}});assert.equal(r.status,409);r=await a.req(`/api/tasks/${task.id}`,undefined,{headers:keyHeaders});assert.equal((await r.json()).task.status,'running');r=await a.req(`/api/tasks/${task.id}`,undefined,{headers:keyHeaders});assert.equal((await r.json()).task.status,'succeeded');r=await a.req(`/api/tasks/${task.id}/images/0`,undefined,{headers:keyHeaders});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.match(r.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),PNG);assert.equal((await (await a.req('/api/tasks')).json()).tasks.length,1);await login(a,'bob@example.com');assert.equal((await (await a.req('/api/tasks')).json()).tasks.length,0);assert.equal((await a.req(`/api/tasks/${task.id}`,undefined,{headers:keyHeaders})).status,404);}finally{mock.restore();a.db.raw.close();}});
test('reference files forwarded as multipart; masks checked server-side',async()=>{const mock=mockUpstream(),a=app();try{await login(a);function form(mask=false){const f=new FormData();for(const [k,v] of Object.entries({...params,mode:mask?'mask':'edit'}))f.set(k,String(v));f.set('image',new File([PNG],'reference.png',{type:'image/png'}));if(mask)f.set('mask',new File([PNG],'mask.png',{type:'image/png'}));return f;}let r=await a.req('/api/tasks',form(),{headers:{...keyHeaders,'idempotency-key':crypto.randomUUID()}});assert.equal(r.status,202);assert(mock.calls.at(-1).opts.body instanceof FormData);assert.equal(mock.calls.at(-1).opts.body.get('async'),'true');r=await a.req('/api/tasks',form(true),{headers:{...keyHeaders,'idempotency-key':crypto.randomUUID()}});assert.equal(r.status,202);const bad=form(true);const larger=Buffer.from(PNG);larger.writeUInt32BE(2,16);bad.set('mask',new File([larger],'mask.png',{type:'image/png'}));r=await a.req('/api/tasks',bad,{headers:{...keyHeaders,'idempotency-key':crypto.randomUUID()}});assert.equal(r.status,400);assert.match((await r.json()).error,/完全相同/);const fake=form();fake.set('image',new File(['not png'],'fake.png',{type:'image/png'}));assert.equal((await a.req('/api/tasks',fake,{headers:{...keyHeaders,'idempotency-key':crypto.randomUUID()}})).status,400);}finally{mock.restore();a.db.raw.close();}});
