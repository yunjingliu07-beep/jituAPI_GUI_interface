import {test} from 'node:test';import assert from 'node:assert/strict';
import {createHandler,sha,passwordHash,passwordMatches,validateParams,imageInfo,safeImageURL} from '../worker/core.js';
import {localDB} from '../scripts/d1-local.mjs';import {mockUpstream,mockBucket,PNG} from './fixtures.mjs';
const origin='https://studio.example';
function app(){const db=localDB();const env={DB:db,BUCKET:mockBucket(),RESEND_API_KEY:'test-only',EMAIL_FROM:'Studio <test@example.com>'};const h=createHandler({});let cookie='';return {env,db,async req(path,body,extra={}){const headers={origin,'cf-connecting-ip':'203.0.113.9',...extra.headers};if(cookie)headers.cookie=cookie;let payload=body;if(body!==undefined&&!(body instanceof FormData)){headers['Content-Type']='application/json';payload=JSON.stringify(body);}const req=new Request(origin+path,{method:body===undefined?'GET':'POST',headers,body:payload});const res=await h.fetch(req,env,{});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return res;},setCookie(v){cookie=v;},getCookie(){return cookie;}};}
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

test('independent conversations preserve settings, legacy history and account isolation',async()=>{
 const mock=mockUpstream(),a=app();try{await login(a);const conversationId=crypto.randomUUID(),secondId=crypto.randomUUID();const settings={ratio:'custom',customRatioWidth:7,customRatioHeight:5,resolution:2048,count:1,model:params.model,mode:'text'};
 const post=async(cid,prompt)=>{const res=await a.req('/api/tasks',{...params,conversationId:cid,prompt,size:'2048x1464',uiSettings:settings},{headers:{...keyHeaders,'idempotency-key':crypto.randomUUID()}});assert.equal(res.status,202);return (await res.json()).task};
 const first=await post(conversationId,'第一轮');await post(secondId,'另一个会话');await post(conversationId,'第二轮');assert.equal(mock.jobs.size,3);assert.equal(first.conversationId,conversationId);assert.deepEqual(first.uiSettings,settings);
 let list=(await (await a.req('/api/tasks')).json()).tasks;assert.equal(list.filter(t=>t.conversationId===conversationId).length,2);
 const conversations=(await (await a.req('/api/conversations')).json()).conversations;assert.equal(conversations.length,2);assert.deepEqual(conversations.find(c=>c.id===conversationId).settings,settings);
 const rename=await createHandler({}).fetch(new Request(origin+'/api/conversations/'+conversationId,{method:'PATCH',headers:{origin,cookie:a.getCookie(),'Content-Type':'application/json'},body:JSON.stringify({title:'重命名后的会话'})}),a.env,{});assert.equal(rename.status,200);
 // Old records keep their own ID as a virtual conversation until continued.
 const legacyId=crypto.randomUUID();a.db.raw.prepare('UPDATE tasks SET conversation_id=NULL WHERE id=?').run(first.id);a.db.raw.prepare('UPDATE tasks SET id=? WHERE id=?').run(legacyId,first.id);
 list=(await (await a.req('/api/tasks')).json()).tasks;assert.equal(list.find(t=>t.id===legacyId).conversationId,legacyId);await post(legacyId,'接着旧作品创作');assert.equal(a.db.raw.prepare('SELECT conversation_id FROM tasks WHERE id=?').get(legacyId).conversation_id,legacyId);
 await login(a,'other@example.com');assert.equal((await (await a.req('/api/conversations')).json()).conversations.length,0);assert.equal((await a.req('/api/tasks',{...params,conversationId},{headers:{...keyHeaders,'idempotency-key':crypto.randomUUID()}})).status,404);
 }finally{mock.restore();a.db.raw.close()}
});

test('documented errors retain HTTP status, API code, reason and redacted original message',async()=>{
 const {explainUpstreamError,DOCUMENTED_HTTP_ERRORS}=await import('../worker/core.js');
 for(const status of [400,401,402,403,404,409,410,413,415,502,503]){const info=explainUpstreamError({error:{code:'provider_specific_code',message:'detail sk-sensitive-secret'}},status);assert.equal(info.httpStatus,status);assert.equal(info.reason,DOCUMENTED_HTTP_ERRORS[status]);assert.equal(info.code,'provider_specific_code');assert.equal(info.unknownCode,true);assert(!info.upstreamMessage.includes('sk-sensitive-secret'));assert.equal(info.matchedBy,'http_status')}
 const code=explainUpstreamError({error:{code:'upstream_error',message:'生成失败',request_id:15}});assert.equal(code.matchedBy,'code');assert.match(code.reason,/费用已退回/);assert.equal(code.requestId,'15');
 const unknown=explainUpstreamError({error:{code:'new_vendor_code',message:'新的错误'}});assert.equal(unknown.matchedBy,null);assert.match(unknown.reason,/未收录/);assert.equal(unknown.upstreamMessage,'新的错误');assert.equal(explainUpstreamError({detail:'格式不正确'},400).upstreamMessage,'格式不正确');assert.doesNotThrow(()=>explainUpstreamError({error:{message:123}},400));
});

test('submission and asynchronous failure details survive subsequent history reads',async()=>{
 const mock=mockUpstream(),a=app();try{await login(a);let res=await a.req('/api/tasks',{...params,prompt:'QA_FAIL_BALANCE'},{headers:{...keyHeaders,'idempotency-key':crypto.randomUUID()}});assert.equal(res.status,402);const failed=await res.json();assert.equal(failed.errorInfo.code,'insufficient_quota');assert.match(failed.errorInfo.reason,/余额不足/);
 let history=(await (await a.req('/api/tasks')).json()).tasks;assert.equal(history[0].errorInfo.code,'insufficient_quota');assert.equal(history[0].errorInfo.httpStatus,402);
 res=await a.req('/api/tasks',{...params,prompt:'QA_ASYNC_FAIL'},{headers:{...keyHeaders,'idempotency-key':crypto.randomUUID()}});const task=(await res.json()).task;res=await a.req('/api/tasks/'+task.id,undefined,{headers:keyHeaders});const data=await res.json();assert.equal(data.task.status,'failed');assert.equal(data.task.errorInfo.code,'upstream_error');assert.equal(data.task.errorInfo.matchedBy,'code');
 history=(await (await a.req('/api/tasks')).json()).tasks;assert.equal(history.find(t=>t.id===task.id).errorInfo.code,'upstream_error');
 }finally{mock.restore();a.db.raw.close()}
});

test('ratio to pixel conversion supports 9:16, custom proportions and rejects unusable dimensions',async()=>{
 const {requestedSize}=await import('../public/parameters.js');assert.equal(requestedSize({ratio:'9:16',resolution:2048}).size,'1152x2048');assert.equal(requestedSize({ratio:'custom',customRatioWidth:7,customRatioHeight:5,resolution:2048}).size,'2048x1464');assert.equal(requestedSize({ratio:'custom',customRatioWidth:1.5,customRatioHeight:1,resolution:4096}).size,'4096x2728');
 for(const [w,h] of [[0,1],[-1,1],[NaN,1],[1,Infinity],[10000,1]])assert.throws(()=>requestedSize({ratio:'custom',customRatioWidth:w,customRatioHeight:h,resolution:1024}));
});

test('original references and mask are saved before generation and restored with owner-only access',async()=>{
 const mock=mockUpstream(),a=app();try{await login(a);const f=new FormData();for(const [k,v]of Object.entries({...params,mode:'mask'}))f.set(k,String(v));f.append('image[]',new File([PNG],'original-one.png',{type:'image/png'}));f.append('image[]',new File([PNG],'original-two.png',{type:'image/png'}));f.set('mask',new File([PNG],'original-mask.png',{type:'image/png'}));const idem=crypto.randomUUID();
 let res=await a.req('/api/tasks',f,{headers:{...keyHeaders,'idempotency-key':idem}});assert.equal(res.status,202);const task=(await res.json()).task;assert.equal(task.references.length,3);assert.deepEqual(task.references.map(r=>r.kind),['image','image','mask']);assert.deepEqual(task.references.map(r=>r.name),['original-one.png','original-two.png','original-mask.png']);assert.equal(a.env.BUCKET.objects.size,3);assert(!JSON.stringify(task.references).includes('references/'));assert(!JSON.stringify(task.references).includes('key'));
 const ownerCookie=a.getCookie();for(let i=0;i<3;i++){res=await a.req(`/api/tasks/${task.id}/references/${i}`);assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'image/png');assert.equal(res.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await res.arrayBuffer()),PNG)}
 // An original remains available independently of the upstream result's 12-hour retention.
 a.db.raw.prepare('UPDATE tasks SET created_at=? WHERE id=?').run(1,task.id);assert.equal((await a.req(`/api/tasks/${task.id}/references/0`)).status,200);
 const history=(await (await a.req('/api/tasks')).json()).tasks;assert.equal(history[0].references[2].kind,'mask');
 assert.equal((await a.req(`/api/tasks/${task.id}/references/17`)).status,404);
 await login(a,'reference-other@example.com');assert.equal((await a.req(`/api/tasks/${task.id}/references/0`)).status,404);a.setCookie('');assert.equal((await a.req(`/api/tasks/${task.id}/references/0`)).status,401);a.setCookie(ownerCookie);
 // Same submission does not create extra reference objects or upstream jobs.
 res=await a.req('/api/tasks',f,{headers:{...keyHeaders,'idempotency-key':idem}});assert.equal(res.status,200);assert.equal(a.env.BUCKET.objects.size,3);assert.equal(mock.jobs.size,1);
 }finally{mock.restore();a.db.raw.close()}
});

test('reference storage failure prevents paid upstream calls and preserves the original submission for retry',async()=>{
 const mock=mockUpstream(),a=app();try{await login(a);const f=new FormData();for(const [k,v]of Object.entries({...params,mode:'edit'}))f.set(k,String(v));f.set('image',new File([PNG],'reference.png',{type:'image/png'}));const idem=crypto.randomUUID();a.env.BUCKET={async put(){throw new Error('storage unavailable')}};
 let res=await a.req('/api/tasks',f,{headers:{...keyHeaders,'idempotency-key':idem}});assert.equal(res.status,503);assert.match((await res.json()).error,/尚未提交生图请求/);assert.equal(mock.calls.length,0);let history=(await (await a.req('/api/tasks')).json()).tasks;assert.equal(history[0].status,'unknown');assert.equal(history[0].references.length,0);
 a.env.BUCKET=mockBucket();res=await a.req('/api/tasks',f,{headers:{...keyHeaders,'idempotency-key':idem}});assert.equal(res.status,202);const task=(await res.json()).task;assert.equal(task.references.length,1);assert.equal(mock.jobs.size,1);
 }finally{mock.restore();a.db.raw.close()}
});
