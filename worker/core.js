const UPSTREAM = 'https://www.jituapi.cn';
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const LIMIT = 50 * 1024 * 1024;
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const uid = () => crypto.randomUUID();
export class AppError extends Error { constructor(message, status = 400, details = null) { super(message); this.status = status; this.details = details; } }
const assert = (condition, message, status = 400) => { if (!condition) throw new AppError(message, status); };
const hex = b => [...new Uint8Array(b)].map(v => v.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(s.match(/../g).map(v => parseInt(v, 16)));
export const sha = async text => hex(await crypto.subtle.digest('SHA-256', typeof text === 'string' ? enc.encode(text) : text));
function randomToken(bytes = 32) { return hex(crypto.getRandomValues(new Uint8Array(bytes))); }
export async function passwordHash(password, salt = randomToken(16)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return `pbkdf2:100000:${salt}:${hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: 100000 }, key, 256))}`;
}
export async function passwordMatches(password, stored) {
  if (!stored || !/^pbkdf2:100000:[a-f0-9]{32}:[a-f0-9]{64}$/.test(stored)) return false;
  const computed = await passwordHash(password, stored.split(':')[2]);
  let result = 0; for (let i = 0; i < computed.length; i++) result |= computed.charCodeAt(i) ^ stored.charCodeAt(i);
  return result === 0;
}
function validatePassword(p) { assert(typeof p === 'string' && p.length >= 10 && p.length <= 128, '密码请使用 10 至 128 个字符。'); }
export function validEmail(raw) { const email = String(raw || '').trim().toLowerCase(); assert(email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), '请填写有效的邮箱地址。'); return email; }
function safeMessage(value, fallback) { const s = typeof value === 'string' ? value : value?.message; return typeof s==='string'&&s ? s.replace(/sk-[A-Za-z0-9_-]+/g, '[密钥已隐藏]').slice(0, 600) : fallback; }
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}}); }
async function bodyJSON(req, max = 16384) { assert(Number(req.headers.get('content-length') || 0) <= max,'提交内容过大。',413); const text = await new Response(limitedBody(req.body,max)).text(); assert(enc.encode(text).length <= max,'提交内容过大。',413); try { return JSON.parse(text); } catch { throw new AppError('提交内容无法读取，请刷新页面重试。'); } }
function limitedBody(body,max) { if(!body)return null;let bytes=0;return body.pipeThrough(new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>max)throw new AppError('提交内容过大，请减少图片或文字。',413);controller.enqueue(chunk);}})); }
const one = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
async function rate(db, key, maximum, seconds) {
  const t = now(); const row = await one(db, 'INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING count,reset_at', key, t+seconds, t, t, t+seconds);
  assert(row.count <= maximum, `操作太频繁，请在 ${Math.max(1,row.reset_at-t)} 秒后重试。`,429);
}
function mailReady(env) { return !!(env.RESEND_API_KEY?.trim() && env.EMAIL_FROM?.trim()); }
function requireMail(env) { assert(mailReady(env),'邮件服务尚未配置完成，请稍后重试。',503); }
async function codeHash(env,id,email,purpose,code) {
  const key=await crypto.subtle.importKey('raw',unhex(env.API_VAULT_KEY||''),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,enc.encode(JSON.stringify([id,email,purpose,code]))));
}
function newEmailCode() {
  // Rejection sampling keeps all six-digit codes equally likely.
  const values=new Uint32Array(1);do{crypto.getRandomValues(values);}while(values[0]>=4294000000);
  return String(values[0]%1000000).padStart(6,'0');
}
async function sendEmailCode(env,email,purpose,ip) {
  requireMail(env);assert(/^[a-f0-9]{64}$/.test(env.API_VAULT_KEY||''),'账号服务尚未就绪，请稍后重试。',503);
  await rate(env.DB,`mail-ip:${ip}`,20,3600);
  await rate(env.DB,`mail-hour:${await sha(email)}`,5,3600);
  await rate(env.DB,`mail-cooldown:${await sha(email)}`,1,60);
  const account=await one(env.DB,'SELECT id FROM users WHERE email=?',email);
  const result={ok:true,message:'如果该邮箱符合条件，验证码将发送到邮箱，请检查收件箱和垃圾邮件。',retryAfter:60};
  if((purpose==='register'&&account)||(purpose==='reset'&&!account))return result;
  const id=uid(),code=newEmailCode(),t=now();
  await run(env.DB,'DELETE FROM email_codes WHERE (email=? AND purpose=?) OR (expires_at>0 AND expires_at<=?) OR (expires_at=0 AND created_at<?)',email,purpose,t,t-120);
  await run(env.DB,'INSERT INTO email_codes (id,email,purpose,code_hash,expires_at,created_at) VALUES (?,?,?,?,0,?)',id,email,purpose,await codeHash(env,id,email,purpose,code),t);
  const action=purpose==='register'?'注册账号':'重设密码';
  try {
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`email-code/${id}`},body:JSON.stringify({from:env.EMAIL_FROM,to:[email],subject:`image meow · ${action}验证码`,text:`你正在${action}。\n\n验证码：${code}\n\n验证码 10 分钟内有效，仅可使用一次。请勿向任何人透露。重新发送后，旧验证码失效。若非本人操作，请忽略此邮件。`,html:`<div lang="zh-CN"><h2>image meow · ${action}</h2><p>你的验证码：</p><p style="font-size:32px;letter-spacing:6px;font-weight:bold">${code}</p><p>10 分钟内有效，仅可使用一次。请勿向任何人透露。</p><p>重新发送后，旧验证码失效。若非本人操作，请忽略此邮件。</p></div>`}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok||typeof data.id!=='string'||!data.id)throw new Error('Mail rejected');
    await run(env.DB,'UPDATE email_codes SET expires_at=? WHERE id=?',now()+600,id);
  } catch {
    await run(env.DB,'DELETE FROM email_codes WHERE id=?',id);
    throw new AppError('验证码暂时无法发送，请稍后重试；若持续失败，请联系站长检查邮件服务。',502);
  }
  return result;
}
async function consumeEmailCode(env,email,purpose,code,ip) {
  requireMail(env);assert(typeof code==='string'&&/^\d{6}$/.test(code),'请输入邮件中的 6 位验证码。');
  await rate(env.DB,`code-check-ip:${ip}`,30,900);
  const row=await one(env.DB,'UPDATE email_codes SET attempts=attempts+1 WHERE id=(SELECT id FROM email_codes WHERE email=? AND purpose=? ORDER BY created_at DESC LIMIT 1) AND expires_at>? AND attempts<5 RETURNING *',email,purpose,now());
  assert(row,'验证码无效、已过期或尝试次数过多，请重新获取。');
  const consumed=await one(env.DB,'DELETE FROM email_codes WHERE id=? AND code_hash=? AND expires_at>? AND attempts<=5 RETURNING id',row.id,await codeHash(env,row.id,email,purpose,code),now());
  assert(consumed,'验证码不正确或已失效，请检查邮件。');
}
async function getSession(req, db) {
  const token = (req.headers.get('cookie') || '').match(/(?:^|;\s*)__Host-jitu=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  return one(db,'SELECT users.id,users.email,users.password_hash,users.onboarding_completed_at,users.selected_api_id,users.last_seen_release,users.role,sessions.verified_at,sessions.token_hash FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?',await sha(token),now());
}
async function sessionResponse(db, user, status = 200) {
  const token = randomToken(); const t = now();
  // Recheck the password version atomically: an in-flight old-password login must not
  // create a surviving session after a concurrent password reset has completed.
  const session=await one(db,'INSERT INTO sessions (token_hash,user_id,expires_at,verified_at) SELECT ?,id,?,0 FROM users WHERE id=? AND password_hash IS ? RETURNING token_hash',await sha(token),t+604800,user.id,user.password_hash||null);
  assert(session,'密码已更改，请使用新密码重新登录。',401);
  return json({user:publicUser(user)},status,{'Set-Cookie':`__Host-jitu=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`});
}
function publicUser(user){return {email:user.email,role:user.role||'member',hasPassword:!!user.password_hash,onboardingCompleted:!!user.onboarding_completed_at,lastSeenRelease:user.last_seen_release||null};}
function validateAPIKey(raw){const key=String(raw||'').trim();assert(key.length>=12&&key.length<=512&&/^[\x21-\x7e]+$/.test(key),'请填写完整有效的 API 密钥。',422);return key;}
function keyFrom(req){return validateAPIKey(req.headers.get('x-jitu-key'));}
async function vaultKey(env){assert(/^[a-f0-9]{64}$/.test(env.API_VAULT_KEY||''),'API 密钥存储尚未就绪，请稍后重试。',503);return crypto.subtle.importKey('raw',unhex(env.API_VAULT_KEY),'AES-GCM',false,['encrypt','decrypt']);}
export async function encryptAPIKey(env,userId,profileId,key){const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(userId+':'+profileId)},await vaultKey(env),enc.encode(key));return hex(iv)+':'+hex(encrypted);}
async function decryptAPIKey(env,profile){try{const [iv,cipher]=profile.encrypted_key.split(':');const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:unhex(iv),additionalData:enc.encode(profile.user_id+':'+profile.id)},await vaultKey(env),unhex(cipher));return new TextDecoder().decode(bytes);}catch(e){if(e instanceof AppError)throw e;throw new AppError('这把 API 密钥暂时无法读取，请移除后重新添加。',503);}}
function publicAPIProfile(p){return {id:p.id,name:p.name,keyHint:p.key_hint,createdAt:p.created_at};}
async function requestKey(req,env,user){const id=req.headers.get('x-api-profile');if(!id)return {key:keyFrom(req),profileId:null};const profile=await one(env.DB,'SELECT * FROM api_profiles WHERE id=? AND user_id=?',id,user.id);assert(profile,'请选择当前账号中可用的 API。',422);return {key:await decryptAPIKey(env,profile),profileId:profile.id};}
async function taskKey(req,env,user,task){
 if(task.api_profile_id){const profile=await one(env.DB,'SELECT * FROM api_profiles WHERE id=? AND user_id=?',task.api_profile_id,user.id);if(profile)return decryptAPIKey(env,profile);}
 if(task.api_key_hash){const profile=await one(env.DB,'SELECT * FROM api_profiles WHERE user_id=? AND key_hash=?',user.id,task.api_key_hash);if(profile)return decryptAPIKey(env,profile);const selected=await requestKey(req,env,user);assert(await sha(selected.key)===task.api_key_hash,'这次任务需要原来的 API，请重新添加原密钥后查询。',422);return selected.key;}
 return (await requestKey(req,env,user)).key;
}
async function visibleTask(env,user,id){const task=await one(env.DB,'SELECT tasks.* FROM tasks LEFT JOIN conversations c ON c.id=COALESCE(tasks.conversation_id,tasks.id) WHERE tasks.id=? AND tasks.user_id=? AND c.deleted_at IS NULL',id,user.id);assert(task,'找不到这次创作记录。',404);return task;}
async function cleanDeletedConversation(env,user,id,check=async()=>{}){
 try{
  for(;;){
   const rows=await env.DB.prepare('SELECT * FROM tasks WHERE user_id=? AND (conversation_id=? OR (conversation_id IS NULL AND id=?)) LIMIT 100').bind(user.id,id,id).all();
   if(!rows.results.length)break;
   const keys=rows.results.flatMap(t=>taskReferences(t).map(r=>{assert(r.key.startsWith(`references/${user.id}/${t.id}/`),'图片归属信息不正确。',503);return r.key;}));
   if(keys.length){if(!env.BUCKET)return false;for(let i=0;i<keys.length;i+=100)await env.BUCKET.delete(keys.slice(i,i+100));}
   await check();
   await run(env.DB,`DELETE FROM tasks WHERE user_id=? AND id IN (${rows.results.map(()=>'?').join(',')})`,user.id,...rows.results.map(t=>t.id));
  }
  await run(env.DB,"UPDATE conversations SET title='',settings=NULL WHERE id=? AND user_id=? AND deleted_at IS NOT NULL",id,user.id);
  return true;
 }catch{return false;}
}
const INVITATION_ERROR='邀请码无效、已使用、已过期或已撤销，请联系管理员获取新的邀请码。';
function invitationCode(raw){
 assert(typeof raw==='string'&&raw.length<=96,'请输入管理员提供的邀请码。');
 const code=raw.trim().toUpperCase().replace(/^MEOW[-\s]*/,'').replace(/[-\s]/g,'');
 assert(/^[A-F0-9]{32}$/.test(code),INVITATION_ERROR);return code;
}
async function usableInvitation(env,raw){
 const code=invitationCode(raw);
 const invitation=await one(env.DB,"SELECT i.id FROM registration_invitations i JOIN users issuer ON issuer.id=i.created_by WHERE i.code_hash=? AND i.used_by IS NULL AND i.revoked_at IS NULL AND i.expires_at>? AND issuer.role IN ('owner','admin')",await sha(code),now());
 assert(invitation,INVITATION_ERROR);return invitation;
}
function requireAdministrator(user){assert(['owner','admin'].includes(user.role),'此功能仅限管理员使用。',403);}
function requireOwner(user){assert(user.role==='owner','只有站长可以管理管理员。',403);}
function activityFilters(req,column){
 const params=new URL(req.url).searchParams,email=(params.get('email')||'').trim().toLowerCase(),raw=params.get('offset')||'0';
 assert(email.length<=254,'邮箱筛选最多 254 个字符。');assert(/^\d{1,7}$/.test(raw),'分页参数无效。');
 const where=[],args=[];if(email){where.push('instr(lower(email),?)>0');args.push(email);}
 const userId=params.get('userId');if(userId){assert(/^[a-f0-9-]{36}$/.test(userId),'账号筛选无效。');where.push((column==='created_at'?'id':'user_id')+'=?');args.push(userId);}
 let from=null,to=null;
 for(const name of ['from','to']){
  const value=params.get(name);if(!value)continue;
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value),'日期格式应为 YYYY-MM-DD。');
  const utc=Date.parse(value+'T00:00:00Z');assert(Number.isFinite(utc)&&new Date(utc).toISOString().slice(0,10)===value,'日期无效。');
  const timestamp=utc/1000-28800;
  if(name==='from'){from=timestamp;where.push(`${column}>=?`);args.push(timestamp);}
  else{to=timestamp;where.push(`${column}<?`);args.push(timestamp+86400);}
 }
 assert(from===null||to===null||from<=to,'开始日期不能晚于结束日期。');
 return {where:where.length?' WHERE '+where.join(' AND '):'',args,offset:Number(raw)};
}
async function ownerActivity(req,env,user,path){
 assert(user.role==='owner','用户与调用记录仅限站长查看。',403);
 assert(req.method==='GET','此页面仅支持查询。',405);
 const users=path==='/api/admin/activity/users';assert(users||path==='/api/admin/activity/calls','没有找到这个管理功能。',404);
 const {where,args,offset}=activityFilters(req,users?'created_at':'started_at');
 const totalUsers=await one(env.DB,'SELECT COUNT(*) AS n FROM users');
 if(users){
  const count=await one(env.DB,`SELECT COUNT(*) AS n FROM users${where}`,...args);
  const rows=await env.DB.prepare(`SELECT id,email,role,created_at,
   (SELECT COUNT(DISTINCT a.task_id) FROM api_activity a WHERE a.user_id=users.id) AS task_count,
   (SELECT COUNT(*) FROM api_activity a WHERE a.user_id=users.id AND a.source='live') AS call_count,
   (SELECT MAX(a.started_at) FROM api_activity a WHERE a.user_id=users.id AND a.source='live') AS last_call_at
   FROM users${where} ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?`).bind(...args,offset).all();
  return json({totalUsers:totalUsers.n,total:count.n,offset,nextOffset:offset+rows.results.length<count.n?offset+rows.results.length:null,
   users:rows.results.map(u=>({id:u.id,email:u.email,role:u.role,createdAt:u.created_at,taskCount:u.task_count,callCount:u.call_count,lastCallAt:u.last_call_at}))});
 }
 const summary=await one(env.DB,`SELECT COUNT(*) AS records,COUNT(DISTINCT user_id) AS active_users,
  COUNT(DISTINCT task_id) AS tasks,COALESCE(SUM(CASE WHEN source='live' THEN 1 ELSE 0 END),0) AS calls FROM api_activity${where}`,...args);
 const rows=await env.DB.prepare(`SELECT id,task_id,email,started_at,responded_at,source,mode,model,requested_count,outcome,http_status,task_status,upstream_id FROM api_activity${where} ORDER BY started_at DESC,id DESC LIMIT 50 OFFSET ?`).bind(...args,offset).all();
 return json({totalUsers:totalUsers.n,total:summary.records,summary:{activeUsers:summary.active_users,tasks:summary.tasks,calls:summary.calls},offset,
  nextOffset:offset+rows.results.length<summary.records?offset+rows.results.length:null,
  calls:rows.results.map(a=>({id:a.id,taskId:a.task_id,email:a.email,startedAt:a.started_at,respondedAt:a.responded_at,source:a.source,mode:a.mode,model:a.model,requestedCount:a.requested_count,outcome:a.outcome,httpStatus:a.http_status,taskStatus:a.task_status,upstreamId:a.upstream_id}))});
}
function publicInvitation(i){
 return {id:i.id,hint:i.code_hint,label:i.label,createdAt:i.created_at,expiresAt:i.expires_at,createdBy:i.creator_email,usedBy:i.member_email||null,usedAt:i.used_at,revokedAt:i.revoked_at,status:i.used_by?'used':i.revoked_at?'revoked':i.expires_at<=now()?'expired':'available'};
}
async function invitationAdmin(req,env,user,path){
 requireAdministrator(user);
 if(path==='/api/admin/invites'&&req.method==='GET'){
  const raw=new URL(req.url).searchParams.get('offset')||'0';assert(/^\d{1,7}$/.test(raw),'分页参数无效。');const offset=Number(raw),scope=user.role==='owner'?'':' WHERE i.created_by=?',args=user.role==='owner'?[]:[user.id];
  const count=await one(env.DB,`SELECT COUNT(*) AS n FROM registration_invitations i${scope}`,...args);
  const rows=await env.DB.prepare(`SELECT i.*,issuer.email AS creator_email,member.email AS member_email FROM registration_invitations i JOIN users issuer ON issuer.id=i.created_by LEFT JOIN users member ON member.id=i.used_by${scope} ORDER BY i.created_at DESC,i.id DESC LIMIT 50 OFFSET ?`).bind(...args,offset).all();
  return json({invitations:rows.results.map(publicInvitation),total:count.n,offset,nextOffset:offset+rows.results.length<count.n?offset+rows.results.length:null});
 }
 if(path==='/api/admin/invites'&&req.method==='POST'){
  const input=await bodyJSON(req);assert(Number.isInteger(input.count)&&input.count>=1&&input.count<=20,'每次可生成 1 至 20 个邀请码。');
  const days=input.expiresInDays??7;assert([1,7,30].includes(days),'有效期请选择 1、7 或 30 天。');
  assert(input.label==null||(typeof input.label==='string'&&input.label.trim().length<=60),'备注最多填写 60 个字符。');
  await rate(env.DB,`invite-generate:${user.id}`,20,3600);
  const t=now(),expires=t+days*86400,items=[],statements=[];
  for(let i=0;i<input.count;i++){
   const raw=randomToken(16).toUpperCase(),code='MEOW-'+raw.match(/.{4}/g).join('-'),id=uid(),hint=`MEOW-${raw.slice(0,4)}-…-${raw.slice(-4)}`;
   statements.push(env.DB.prepare("INSERT INTO registration_invitations(id,code_hash,code_hint,label,created_by,created_at,expires_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND role IN ('owner','admin'))").bind(id,await sha(raw),hint,(input.label||'').trim(),user.id,t,expires,user.id));
   items.push({id,code,hint,expiresAt:expires});
  }
  const results=await env.DB.batch(statements);assert(results.every(r=>r.meta?.changes===1),'管理员权限已变更，请刷新页面。',403);
  return json({invitations:items},201);
 }
 const revoke=path.match(/^\/api\/admin\/invites\/([a-f0-9-]{36})\/revoke$/);
 if(revoke&&req.method==='POST'){
  const row=await one(env.DB,"UPDATE registration_invitations SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND used_by IS NULL AND (?='owner' OR created_by=?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND role IN ('owner','admin')) RETURNING id",now(),revoke[1],user.role,user.id,user.id);
  assert(row,'找不到可撤销的邀请码；已使用的邀请码不能撤销。',404);return json({ok:true});
 }
 if(path==='/api/admin/members'&&req.method==='GET'){
  requireOwner(user);const rows=await env.DB.prepare("SELECT id,email,role,created_at FROM users WHERE role IN ('owner','admin') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at,id").all();
  return json({members:rows.results.map(u=>({id:u.id,email:u.email,role:u.role,createdAt:u.created_at}))});
 }
 if(path==='/api/admin/members'&&req.method==='POST'){
  requireOwner(user);const input=await bodyJSON(req),email=validEmail(input.email);assert(['grant','revoke'].includes(input.action),'请选择添加或撤销管理员。');
  await rate(env.DB,`admin-members:${user.id}`,30,900);
  const member=await one(env.DB,'SELECT id,email,role FROM users WHERE email=?',email);assert(member,'该邮箱尚未注册，请先使用邀请码完成注册。',404);assert(member.role!=='owner','站长身份不能在网页中修改。',403);
  if(input.action==='grant')await run(env.DB,"UPDATE users SET role='admin' WHERE id=? AND role<>'owner'",member.id);
  else await env.DB.batch([
   env.DB.prepare("UPDATE users SET role='member' WHERE id=? AND role<>'owner'").bind(member.id),
   env.DB.prepare('UPDATE registration_invitations SET revoked_at=COALESCE(revoked_at,?) WHERE created_by=? AND used_by IS NULL').bind(now(),member.id)
  ]);
  return json({ok:true});
 }
 throw new AppError('没有找到这个管理功能。',404);
}

// GB uses decimal bytes. Shared SQLite pages and provider-hosted outputs are not user files.
export const USER_STORAGE_LIMIT = 1_000_000_000;
export const RELEASES = [{
 version:'2026.10.19.4',date:'2026-10-19',title:'更新日志弹窗样式优化',
 changes:['移除更新日志弹窗右上角「×」周围的绿色方框。']
},{
 version:'2026.10.19.3',date:'2026-10-19',title:'删除会话弹窗样式优化',
 changes:['移除删除会话确认弹窗右上角「×」周围的绿色方框。']
},{
 version:'2026.10.19.2',date:'2026-10-19',title:'邀请码注册与管理员管理',
 changes:['新账号注册需要管理员提供的一次性邀请码，并继续验证邮箱；已注册账号的登录和找回密码不受影响。','管理员可批量生成、复制和撤销自己创建的邀请码，支持 1、7 或 30 天有效期。','站长可添加或撤销其他已注册成员的管理员权限，并管理全站邀请码。撤销管理员后，其未使用的邀请码同时失效。']
},{
 version:'2026.10.19.1',date:'2026-10-19',title:'更新日志与个人存储空间',
 changes:['新增更新日志：每次版本更新后首次访问会显示更新内容，也可随时从侧栏查看。','每个账号提供 1 GB 聊天与上传素材空间，可在「我的账号」查看用量。','空间不足时自动清理最早的聊天及其参考图、遮罩，并保留清理通知；正在生成的会话暂不清理。','请及时下载生成结果；生图供应商的结果图片仍按原规则保留约 12 小时。']
}];
const storageText = field => `length(CAST(COALESCE(${field},'') AS BLOB))`;
const TASK_STORAGE_SQL = `4096+${['prompt','model','size','ui_settings','reference_files'].map(storageText).join('+')}+COALESCE((SELECT SUM(MAX(0,CAST(json_extract(value,'$.size') AS INTEGER))) FROM json_each(CASE WHEN json_valid(reference_files) THEN reference_files ELSE '[]' END)),0)`;
const CONVERSATION_STORAGE_SQL = `512+${storageText('title')}+${storageText('settings')}`;
export async function storageUsage(env,userId,conversationId=null) {
 const filter=conversationId?' AND (conversation_id=? OR (conversation_id IS NULL AND id=?))':'';
 const tasks=await one(env.DB,`SELECT COALESCE(SUM(${TASK_STORAGE_SQL}),0) AS bytes,COUNT(*) AS count FROM tasks WHERE user_id=?${filter}`,userId,...(conversationId?[conversationId,conversationId]:[]));
 const chats=await one(env.DB,`SELECT COALESCE(SUM(${CONVERSATION_STORAGE_SQL}),0) AS bytes FROM conversations WHERE user_id=?${conversationId?' AND id=?':''}`,userId,...(conversationId?[conversationId]:[]));
 return {bytes:Number(tasks.bytes)+Number(chats.bytes),tasks:Number(tasks.count)};
}
async function withStorageLock(env,user,action) {
 const token=uid(),time=Date.now();
 const row=await one(env.DB,'INSERT INTO account_storage(user_id,lease_token,lease_until) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until WHERE account_storage.lease_until<=? RETURNING user_id',user.id,token,time+120000,time);
 assert(row,'空间正在整理，请稍后重试；生图请求可使用「恢复原提交」。',429);
 let lost=false;
 const check=async()=>{assert(!lost,'空间整理已中断，请稍后重试。',503);const r=await one(env.DB,'SELECT lease_token FROM account_storage WHERE user_id=?',user.id);assert(r?.lease_token===token,'空间整理已中断，请稍后重试。',503);};
 const timer=setInterval(()=>{run(env.DB,'UPDATE account_storage SET lease_until=? WHERE user_id=? AND lease_token=?',Date.now()+120000,user.id,token).catch(()=>{lost=true;});},20000);
 try{return await action(check);}finally{clearInterval(timer);await run(env.DB,'UPDATE account_storage SET lease_token=NULL,lease_until=0 WHERE user_id=? AND lease_token=?',user.id,token);}
}
async function quotaRemoveConversation(env,user,id,check) {
 const summary=await storageUsage(env,user.id,id);await check();
 // The tombstone and persistent notification are committed together before removing files.
 await env.DB.batch([
  env.DB.prepare("INSERT INTO conversations(id,user_id,title,created_at,updated_at,deleted_at) VALUES(?,?,'',?,?,?) ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at,title='',settings=NULL WHERE conversations.user_id=excluded.user_id").bind(id,user.id,now(),now(),now()),
  env.DB.prepare('UPDATE account_storage SET notice_revision=notice_revision+1,notice_conversations=CASE WHEN notice_revision=acknowledged_revision THEN 1 ELSE notice_conversations+1 END,notice_tasks=CASE WHEN notice_revision=acknowledged_revision THEN ? ELSE notice_tasks+? END,notice_at=? WHERE user_id=?').bind(summary.tasks,summary.tasks,now(),user.id)
 ]);
 assert(await cleanDeletedConversation(env,user,id,check),'最早的聊天已移除，图片文件清理暂未完成，请稍后重试。',503);
}
export async function enforceStorage(env,user,protectedId=null,reserveBytes=0,check=async()=>{}) {
 // Retry incomplete physical deletes first. Never forget a file manifest before deletion succeeds.
 const pending=await env.DB.prepare('SELECT c.id FROM conversations c WHERE c.user_id=? AND c.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM tasks t WHERE t.user_id=c.user_id AND (t.conversation_id=c.id OR (t.conversation_id IS NULL AND t.id=c.id)))').bind(user.id).all();
 for(const c of pending.results){await check();assert(await cleanDeletedConversation(env,user,c.id,check),'图片文件仍在清理，请稍后重试。',503);}
 const limit=USER_STORAGE_LIMIT;
 let usage=await storageUsage(env,user.id);
 if(usage.bytes+reserveBytes<=limit)return usage;
 if(protectedId){const current=await storageUsage(env,user.id,protectedId);assert(current.bytes+reserveBytes<=limit,'当前会话已接近 1 GB，请新建会话后再提交。',507);}
 while(usage.bytes+reserveBytes>limit){
  const candidate=await one(env.DB,`SELECT id FROM (
   SELECT c.id,c.created_at FROM conversations c WHERE c.user_id=? AND c.deleted_at IS NULL AND c.id<>? AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.conversation_id=c.id AND t.user_id=c.user_id AND t.status IN ('submitting','unknown','queued','running') AND t.created_at>?)
   UNION ALL SELECT t.id,t.created_at FROM tasks t WHERE t.user_id=? AND t.conversation_id IS NULL AND t.id<>? AND NOT(t.status IN ('submitting','unknown','queued','running') AND t.created_at>?)
  ) ORDER BY created_at,id LIMIT 1`,user.id,protectedId||'',now()-43200,user.id,protectedId||'',now()-43200);
  assert(candidate,'空间已满，正在生成的会话暂不清理。请等待任务结束，或手动删除不需要的会话。',507);
  await quotaRemoveConversation(env,user,candidate.id,check);
  const next=await storageUsage(env,user.id);assert(next.bytes<usage.bytes,'空间暂时无法释放，请稍后重试。',503);usage=next;
 }
 return usage;
}
async function storageSnapshot(env,user) {
 const usage=await storageUsage(env,user.id),state=await one(env.DB,'SELECT * FROM account_storage WHERE user_id=?',user.id);
 const pending=await one(env.DB,'SELECT 1 AS found FROM conversations c JOIN tasks t ON (t.conversation_id=c.id OR (t.conversation_id IS NULL AND t.id=c.id)) AND t.user_id=c.user_id WHERE c.user_id=? AND c.deleted_at IS NOT NULL LIMIT 1',user.id);
 return {usedBytes:usage.bytes,limitBytes:USER_STORAGE_LIMIT,pendingCleanup:!!pending,notice:state&&state.notice_revision>state.acknowledged_revision?{revision:state.notice_revision,conversations:state.notice_conversations,tasks:state.notice_tasks,createdAt:state.notice_at}:null};
}
export async function maintainAccountStorage(env,user) {
 return withStorageLock(env,user,async check=>{
  let cleanupError=null;try{await enforceStorage(env,user,null,0,check);}catch(e){if(!(e instanceof AppError))throw e;cleanupError=e.message;}
  return {...await storageSnapshot(env,user),cleanupError};
 });
}
export async function maintainExistingStorage(env) {
 let after='',failures=0;
 for(;;){const rows=await env.DB.prepare('SELECT id FROM users WHERE id>? ORDER BY id LIMIT 100').bind(after).all();if(!rows.results.length)break;
  for(const user of rows.results){try{const s=await maintainAccountStorage(env,user);if(s.cleanupError)failures++;}catch{failures++;}after=user.id;}
 }
 return {failures};
}
export function validateParams(p) {
  assert(['text','edit','mask'].includes(p.mode),'请选择正确的创作模式。');
  assert(typeof p.prompt==='string' && p.prompt.trim() && p.prompt.length<=10000,'请描述你想生成的画面，最多 10000 个字符。');
  assert(typeof p.model==='string' && /^[\w.:-]{1,150}$/.test(p.model),'请选择有效的模型。');
  assert(Number.isInteger(Number(p.n)) && Number(p.n)>=1 && Number(p.n)<=16,'生成数量应为 1 至 16 张，具体以模型支持为准。');
  assert(/^\d{2,4}x\d{2,4}$/.test(p.size),'请使用正确的图片尺寸。');
  const [w,h]=p.size.split('x').map(Number); assert(w>=64 && w<=8192 && h>=64 && h<=8192,'宽度和高度请设置在 64 至 8192 像素之间，具体以模型支持为准。');
  return {...p,prompt:p.prompt.trim(),n:Number(p.n)};
}
export function imageInfo(bytes) {
  const b=new Uint8Array(bytes);const view=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if(b.length>=24 && b[0]===137 && b[1]===80 && b[2]===78 && b[3]===71 && b[4]===13 && b[5]===10 && b[6]===26 && b[7]===10) return {type:'image/png',width:view.getUint32(16),height:view.getUint32(20)};
  if(b.length>=12 && b[0]===255 && b[1]===216 && b[2]===255) {let i=2;while(i+8<b.length){if(b[i]!==255){i++;continue;}const m=b[i+1],len=view.getUint16(i+2);if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(m))return {type:'image/jpeg',height:view.getUint16(i+5),width:view.getUint16(i+7)};if(m===217||m===218||len<2)break;i+=2+len;}return {type:'image/jpeg'};}
  if(b.length>=16 && String.fromCharCode(...b.slice(0,4))==='RIFF' && String.fromCharCode(...b.slice(8,12))==='WEBP')return {type:'image/webp'};
  throw new AppError('文件内容不是有效的 PNG、JPG 或 WebP 图片，请换一张图片。');
}
async function checkFile(file, mask=false) {assert(file && typeof file.arrayBuffer==='function' && file.size>0,'请选择一张有效的图片。');assert(file.size<=20*1024*1024,'每张图片不能超过 20 MiB。',413);assert(TYPES.has(file.type) && (!mask||file.type==='image/png'),'参考图仅支持 PNG、JPG、WebP；遮罩必须是 PNG。');const content=await file.arrayBuffer();const info=imageInfo(content);assert(info.type===file.type,'图片格式与文件内容不匹配，请重新导出后上传。');return {info,hash:await sha(content)};}
async function upstream(path,key,options={}) {
  try {return await fetch(UPSTREAM+path,{...options,headers:{...options.headers,Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(90000)});} catch {throw new AppError('与生图服务的连接暂时中断。请求可能已被受理，请使用「恢复原提交」核对，避免重复扣费。',504);}
}
// Error meanings transcribed from the user-provided 即图调用文档.html (2026-10-18).
export const DOCUMENTED_HTTP_ERRORS = {
  400:'参数或尺寸未开放，或参数格式、图片格式、图片数量不正确；本次未扣费。',
  401:'API Key 无效或已作废，请重新连接有效密钥。',
  402:'账户余额不足，或当前 API 密钥的额度不足。',
  403:'密钥没有分组、没有该产品的可用线路，或线路已暂停；无可用线路时不会扣费。',
  404:'模型不存在、已下架，或当前 VIP / SVIP 渠道没有可用模型；查询任务时也可能是编号不存在或不属于当前账号。',
  409:'这个提交标记已用于不同内容。恢复原提交须保持原参数、图片和密钥；新的创作才使用新标记。',
  410:'原结果已过期或被清理，服务不会重新生成或再次扣费。',
  413:'单张参考图超过 20 MiB，或整个请求体超过 50 MiB；本次未扣费。',
  415:'图片编辑请求格式不受支持，请使用 application/json 或 multipart/form-data；本次未扣费。',
  502:'上游生成失败；按接口文档，本次未扣费，已预扣的失败任务会退回费用。',
  503:'上游渠道未配置或未启用。'
};
export function explainUpstreamError(data, httpStatus = null) {
  const raw=data?.error ?? data?.detail ?? data?.message ?? data;
  const code=typeof raw==='object' ? raw?.code ?? data?.code : data?.code;
  const type=typeof raw==='object' ? raw?.type : null;
  const message=safeMessage(raw,'服务未提供详细错误信息。');
  const normalized=code==null?null:safeMessage(String(code),'').slice(0,120);
  const documented=normalized==='upstream_error';
  const reason=documented?'上游生成失败，费用已退回。':DOCUMENTED_HTTP_ERRORS[httpStatus]||'接口返回了文档未收录的错误，请查看服务返回的信息，或联系 API 供应商核对。';
  return {code:normalized,type:type?safeMessage(String(type),'').slice(0,120):null,httpStatus,reason,upstreamMessage:message,
    requestId:(raw?.request_id??data?.request_id)==null?null:safeMessage(String(raw?.request_id??data?.request_id),'').slice(0,150),
    matchedBy:documented?'code':DOCUMENTED_HTTP_ERRORS[httpStatus]?'http_status':null,unknownCode:!!normalized&&!documented};
}
function storedError(error) {return error?.details?JSON.stringify(error.details):error.message;}
function readTaskError(raw) {if(!raw)return null;try{const d=JSON.parse(raw);if(d&&typeof d.reason==='string')return d;}catch{}return {reason:raw,code:null,httpStatus:null,upstreamMessage:null,matchedBy:null};}
async function upstreamJSON(response) {
  let data;try {data=await response.json();} catch {throw new AppError('生图服务暂时没有返回可读取的结果，请稍后再次查询。',502);}
  if(!response.ok){const details=explainUpstreamError(data,response.status);throw new AppError(details.reason,response.status===401?422:response.status,details);}
  return data;
}
function cleanSettings(raw) {
  if(raw==null)return null;
  assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'创作设置格式不正确。');
  const settings={};
  for(const key of ['ratio','customRatioWidth','customRatioHeight','resolution','model','count','mode']) {
    if(raw[key]!=null){assert(['string','number'].includes(typeof raw[key])&&String(raw[key]).length<=150,'创作设置格式不正确。');settings[key]=raw[key];}
  }
  return JSON.stringify(settings);
}
async function checkConversationTarget(env,user,id){
 assert(/^[a-f0-9-]{36}$/.test(id||''),'会话编号无效。');
 const c=await one(env.DB,'SELECT user_id,deleted_at FROM conversations WHERE id=?',id);assert(!c||(c.user_id===user.id&&!c.deleted_at),'找不到这个生图会话。',404);
 const t=await one(env.DB,'SELECT user_id FROM tasks WHERE id=? AND conversation_id IS NULL',id);assert(!t||t.user_id===user.id,'找不到这个生图会话。',404);
}
async function ensureConversation(db,user,id,title,settings=null) {
  assert(/^[a-f0-9-]{36}$/.test(id||''),'会话编号无效。');
  const existing=await one(db,'SELECT * FROM conversations WHERE id=?',id);
  assert(!existing||(existing.user_id===user.id&&!existing.deleted_at),'找不到这个生图会话。',404);
  if(!existing) {
    const legacy=await one(db,'SELECT * FROM tasks WHERE id=? AND conversation_id IS NULL',id);
    assert(!legacy||legacy.user_id===user.id,'找不到这个生图会话。',404);
    await run(db,'INSERT OR IGNORE INTO conversations (id,user_id,title,settings,created_at,updated_at) VALUES (?,?,?,?,?,?)',id,user.id,(legacy?.prompt||title).slice(0,60),settings,legacy?.created_at||now(),now());
    const owner=await one(db,'SELECT user_id FROM conversations WHERE id=?',id);assert(owner?.user_id===user.id,'找不到这个生图会话。',404);
    if(legacy)await run(db,'UPDATE tasks SET conversation_id=? WHERE id=? AND user_id=?',id,id,user.id);
  }
  return id;
}
function publicConversation(c) {let settings=null;try{settings=JSON.parse(c.settings);}catch{}return {id:c.id,title:c.title,settings,pinned:!!c.pinned,createdAt:c.created_at,updatedAt:c.updated_at};}
function taskReferences(task) {try{const refs=JSON.parse(task.reference_files);return Array.isArray(refs)?refs:[];}catch{return [];}}
function referenceManifest(userId,taskId,inputs){return inputs.map(({file,kind,hash},index)=>({key:`references/${userId}/${taskId}/${index}-${hash}`,index,kind,name:String(file.name||`${kind}-${index+1}`).slice(0,240),type:file.type,size:file.size}));}
const textBytes=value=>enc.encode(value||'').length;
async function saveTaskReferences(env,user,task,inputs) {
 if(!inputs.length||(taskReferences(task).length&&task.references_ready!==0))return;
 assert(env.BUCKET,'参考图存储尚未就绪，请稍后恢复原提交；尚未提交生图请求。',503);
 const references=referenceManifest(user.id,task.id,inputs);
 // Persist the whole manifest before any put, so interrupted/failed writes remain accounted for.
 await run(env.DB,'UPDATE tasks SET reference_files=?,references_ready=0 WHERE id=? AND user_id=?',JSON.stringify(references),task.id,user.id);
 task.reference_files=JSON.stringify(references);task.references_ready=0;
 try{
  for(let i=0;i<inputs.length;i++)await env.BUCKET.put(references[i].key,inputs[i].file,{httpMetadata:{contentType:references[i].type}});
  await run(env.DB,'UPDATE tasks SET references_ready=1 WHERE id=? AND user_id=?',task.id,user.id);task.references_ready=1;
 }catch{
  try{await env.BUCKET.delete(references.map(r=>r.key));await run(env.DB,'UPDATE tasks SET reference_files=NULL,references_ready=1 WHERE id=? AND user_id=?',task.id,user.id);task.reference_files=null;task.references_ready=1;}catch{}
  throw new AppError('参考图保存失败，请稍后恢复原提交；尚未提交生图请求。',503);
 }
}
async function downloadReference(env,user,id,index) {
  const task=await visibleTask(env,user,id);
  assert(task.references_ready!==0,'参考图仍待保存完成，请先恢复原提交。',503);
  const reference=taskReferences(task).find(r=>r.index===index);assert(reference,'这张原参考图未保存，请重新上传。',404);
  assert(env.BUCKET,'参考图存储暂时不可用，请稍后重试。',503);
  const object=await env.BUCKET.get(reference.key);assert(object,'这张原参考图暂时无法读取，请重新上传或稍后重试。',404);
  return new Response(object.body,{headers:{'Content-Type':reference.type,'Content-Length':String(reference.size),'Content-Disposition':`attachment; filename="reference-${index+1}.${reference.type==='image/jpeg'?'jpg':reference.type.split('/')[1]}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
async function createTask(req,env,user) {
  const {key,profileId}=await requestKey(req,env,user), idem=req.headers.get('idempotency-key');assert(/^[a-f0-9-]{36}$/.test(idem||''),'提交标记无效，请刷新页面。');
  assert(Number(req.headers.get('content-length')||0)<=LIMIT,'上传总大小不能超过 50 MiB。',413);
  let p, forward, headers={}, fingerprints=[],conversationId=null,uiSettings=null,referenceInputs=[];
  if((req.headers.get('content-type')||'').startsWith('multipart/form-data')) {
    let form;try {form=await new Response(limitedBody(req.body,LIMIT),{headers:{'Content-Type':req.headers.get('content-type')}}).formData();} catch(e) {if(e instanceof AppError)throw e;throw new AppError('图片上传不完整，请重新选择图片。');}
    p=validateParams(Object.fromEntries(['mode','model','prompt','n','size'].map(k=>[k,form.get(k)])));
    conversationId=form.get('conversationId');try{uiSettings=cleanSettings(JSON.parse(form.get('uiSettings')||'null'));}catch(e){if(e instanceof AppError)throw e;throw new AppError('创作设置无法读取。');}
    assert(p.mode!=='text','文生图不需要上传图片。');
    const files=[...form.getAll('image'),...form.getAll('image[]')];assert(files.length>=1&&files.length<=16,'请选择 1 至 16 张参考图。');
    const mask=form.get('mask');const total=files.reduce((n,f)=>n+(f.size||0),0)+(mask?.size||0);assert(total+enc.encode(p.prompt).length+65536<=LIMIT,'参考图和遮罩合计过大，请控制在 50 MiB 以内。',413);
    let first;for(let i=0;i<files.length;i++){const checked=await checkFile(files[i]);if(!i)first=checked.info;fingerprints.push(checked.hash);referenceInputs.push({file:files[i],kind:'image',hash:checked.hash});}
    if(p.mode==='mask'){assert(mask,'局部编辑需要上传 PNG 遮罩。');const checked=await checkFile(mask,true);assert(first.width&&first.height,'局部编辑的第一张参考图请使用 PNG 或 JPG。');assert(first.width===checked.info.width&&first.height===checked.info.height,'遮罩的宽度和高度必须与第一张参考图完全相同。');fingerprints.push(checked.hash);referenceInputs.push({file:mask,kind:'mask',hash:checked.hash});}
    else assert(!mask,'图生图模式请不要上传遮罩。');
    forward=new FormData();for(const k of ['model','prompt','n','size'])forward.set(k,String(p[k]));forward.set('async','true');for(let i=0;i<files.length;i++)forward.append(files.length===1?'image':'image[]',files[i],`reference-${i}.${files[i].type.split('/')[1]}`);if(mask)forward.set('mask',mask,'mask.png');
  } else {const input=await bodyJSON(req,20000);p=validateParams(input);conversationId=input.conversationId;uiSettings=cleanSettings(input.uiSettings);assert(p.mode==='text','图生图请通过上传窗口选择参考图片。');forward=JSON.stringify({model:p.model,prompt:p.prompt,n:p.n,size:p.size,async:true});headers['Content-Type']='application/json';}
  const fingerprint=await sha(JSON.stringify([p.mode,p.model,p.prompt,p.n,p.size,fingerprints,await sha(key),...(conversationId?[conversationId]:[])]));
  const existing=await one(env.DB,'SELECT * FROM tasks WHERE user_id=? AND idempotency_key=?',user.id,idem);
  if(existing){assert(existing.fingerprint===fingerprint,'恢复原提交时，请保持原来的文字、参数和图片不变。',409);if(existing.upstream_id || ['succeeded','failed','expired'].includes(existing.status))return json({task:publicTask(existing)});}
  await rate(env.DB,`generate:${user.id}`,20,60);
  let task;
  await withStorageLock(env,user,async check=>{
   const current=await one(env.DB,'SELECT * FROM tasks WHERE user_id=? AND idempotency_key=?',user.id,idem);
   if(current){assert(current.fingerprint===fingerprint,'恢复原提交时，请保持原参数不变。',409);task=current;}
   const taskId=current?.id||uid();
   const target=current?.conversation_id||conversationId||taskId;
   if(target){const c=await one(env.DB,'SELECT user_id,deleted_at FROM conversations WHERE id=?',target);assert(!c||(c.user_id===user.id&&!c.deleted_at),'找不到这个生图会话。',404);const legacy=await one(env.DB,'SELECT user_id FROM tasks WHERE id=? AND conversation_id IS NULL',target);assert(!legacy||legacy.user_id===user.id,'找不到这个生图会话。',404);}
   const chat=await one(env.DB,'SELECT title,settings FROM conversations WHERE id=? AND user_id=?',target,user.id);
   const legacy=chat?null:await one(env.DB,'SELECT prompt FROM tasks WHERE id=? AND user_id=? AND conversation_id IS NULL',target,user.id);
   let reserve=current?0:4096+textBytes(p.prompt)+textBytes(p.model)+textBytes(p.size)+textBytes(uiSettings);
   if(!current)reserve+=chat?Math.max(0,textBytes(uiSettings||chat.settings)-textBytes(chat.settings)):512+textBytes((legacy?.prompt||p.prompt).slice(0,60))+textBytes(uiSettings);
   if(referenceInputs.length&&(!current||!taskReferences(current).length||current.references_ready===0)){
    const refs=referenceManifest(user.id,taskId,referenceInputs),oldRefs=current?taskReferences(current):[];
    reserve+=Math.max(0,textBytes(JSON.stringify(refs))+refs.reduce((n,r)=>n+r.size,0)-textBytes(current?.reference_files)-oldRefs.reduce((n,r)=>n+Number(r.size||0),0));
   }
   await enforceStorage(env,user,target,reserve,check);
   if(!current){
    conversationId=await ensureConversation(env.DB,user,target,p.prompt,uiSettings);
    await run(env.DB,'INSERT INTO tasks (id,user_id,idempotency_key,fingerprint,mode,prompt,model,size,count,status,created_at,updated_at,conversation_id,ui_settings,api_profile_id,api_key_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',taskId,user.id,idem,fingerprint,p.mode,p.prompt,p.model,p.size,p.n,'submitting',now(),now(),conversationId,uiSettings,profileId,await sha(key));
    await run(env.DB,'UPDATE conversations SET settings=COALESCE(?,settings),updated_at=? WHERE id=? AND user_id=?',uiSettings,now(),conversationId,user.id);
    task=await one(env.DB,'SELECT * FROM tasks WHERE id=?',taskId);
   }
   if(task.upstream_id||['succeeded','failed','expired'].includes(task.status))return;
   try{await saveTaskReferences(env,user,task,referenceInputs);await check();await enforceStorage(env,user,task.conversation_id||task.id,0,check);}catch(e){await run(env.DB,'UPDATE tasks SET status=?,error=?,updated_at=? WHERE id=?','unknown',storedError(e),now(),task.id);throw e;}
  });
  if(task.upstream_id||['succeeded','failed','expired'].includes(task.status))return json({task:publicTask(task)});
  await visibleTask(env,user,task.id);
  const activityId=uid(),startedAt=now();
  await run(env.DB,"INSERT INTO api_activity(id,task_id,user_id,email,started_at,source,mode,model,requested_count,outcome,task_status,updated_at) VALUES (?,?,?,?,?,'live',?,?,?,'pending',?,?)",activityId,task.id,user.id,user.email,startedAt,p.mode,p.model,p.n,task.status,startedAt);
  let data,responseStatus=null;
  try{
   const response=await upstream(p.mode==='text'?'/v1/images/generations':'/v1/images/edits',key,{method:'POST',headers:{...headers,'Idempotency-Key':idem},body:forward});
   responseStatus=response.status;data=await upstreamJSON(response);
   const id=data.id??data.jitu?.request_id;assert(id!=null&&/^[a-zA-Z0-9_-]{1,150}$/.test(String(id)),'生图服务未返回有效任务编号，请保留原提交并稍后核对。',502);
   const acceptedStatus=data.data?'succeeded':['queued','running','succeeded','failed','expired'].includes(data.status)?data.status:'queued';
   await run(env.DB,"UPDATE api_activity SET outcome='accepted',http_status=?,responded_at=?,upstream_id=?,task_status=?,updated_at=? WHERE id=?",responseStatus,now(),String(id),acceptedStatus,now(),activityId);
  }
  catch(e){const ambiguous=!responseStatus||e.status>=500||responseStatus===429||(responseStatus>=200&&responseStatus<300);
   await run(env.DB,'UPDATE api_activity SET outcome=?,http_status=?,responded_at=?,updated_at=? WHERE id=?',ambiguous?'unknown':'rejected',responseStatus,now(),now(),activityId);
   await run(env.DB,'UPDATE tasks SET status=?,error=?,updated_at=? WHERE id=?',ambiguous?'unknown':'failed',storedError(e),now(),task.id);throw e;
  }
  const upstreamID=data.id??data.jitu?.request_id;assert(upstreamID!=null,'生图服务未返回任务编号，请保留原提交并稍后核对。',502);
  assert(/^[a-zA-Z0-9_-]{1,150}$/.test(String(upstreamID)),'生图服务返回的任务编号无法识别，请联系支持核对。',502);
  const status=data.data?'succeeded':['queued','running','succeeded','failed','expired'].includes(data.status)?data.status:'queued';
  const error=status==='failed'?JSON.stringify(explainUpstreamError(data)):null;
  await run(env.DB,'UPDATE tasks SET upstream_id=?,status=?,error=?,updated_at=? WHERE id=?',String(upstreamID),status,error,now(),task.id);
  return json({task:publicTask({...task,upstream_id:String(upstreamID),status,error}),result:data.data?data:undefined},202);
}
export function publicTask(t) {const errorInfo=readTaskError(t.error);let uiSettings=null;try{uiSettings=JSON.parse(t.ui_settings);}catch{}return {id:t.id,conversationId:t.conversation_id||t.id,uiSettings,apiProfileId:t.api_profile_id||null,references:(t.references_ready===0?[]:taskReferences(t)).map(({index,kind,name,type,size})=>({index,kind,name,type,size})),upstreamId:t.upstream_id,idempotencyKey:t.idempotency_key,mode:t.mode,prompt:t.prompt,model:t.model,size:t.size,n:t.count,status:t.created_at+43200<now()&&['succeeded','queued','running'].includes(t.status)?'expired':t.status,error:errorInfo?.reason||null,errorInfo,createdAt:t.created_at,updatedAt:t.updated_at,charged:t.charged,balance:t.balance};}
async function taskResult(env,user,id,req) {
  const task=await visibleTask(env,user,id);
  if(!task.upstream_id)return {task:publicTask(task)};
  if(task.created_at+43200<now()){await run(env.DB,'UPDATE tasks SET status=?,updated_at=? WHERE id=?','expired',now(),task.id);return {task:publicTask({...task,status:'expired'})};}
  const key=await taskKey(req,env,user,task);
  const data=await upstreamJSON(await upstream(`/v1/images/tasks/${encodeURIComponent(task.upstream_id)}`,key));
  assert(['queued','running','succeeded','failed','expired'].includes(data.status),'暂时无法识别生成状态，请稍后再查询。',502);
  const error=data.status==='failed'?JSON.stringify(explainUpstreamError(data)):null;
  await run(env.DB,'UPDATE tasks SET status=?,error=?,updated_at=?,charged=COALESCE(?,charged),balance=COALESCE(?,balance) WHERE id=?',data.status,error,now(),data.result?.jitu?.charged??null,data.result?.jitu?.balance??null,task.id);
  return {task:publicTask({...task,status:data.status,error,charged:data.result?.jitu?.charged??task.charged,balance:data.result?.jitu?.balance??task.balance}),result:data.status==='succeeded'?data.result:undefined};
}
export function safeImageURL(raw) {
  let u;try{u=new URL(raw);}catch{throw new AppError('图片下载地址无法读取。',502);}
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();assert(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.port,'图片下载地址不安全，已停止下载。',502);
  assert(host.includes('.')&&!host.includes(':')&&!/^\d+(\.\d+){3}$/.test(host)&&!/(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host)&&!host.endsWith('.local')&&!host.endsWith('.internal'),'图片下载地址不安全，已停止下载。',502);return u;
}
async function downloadImage(env,user,id,index,req) {
  assert(Number.isInteger(index)&&index>=0&&index<16,'图片序号无效。');const result=await taskResult(env,user,id,req);assert(result.task.status==='succeeded','图片还没有生成完成。',409);
  const item=result.result?.data?.[index];assert(item,'这张图片不存在。',404);
  let bytes,type;
  if(item.b64_json){assert(typeof item.b64_json==='string' && item.b64_json.length<=90*1024*1024,'图片过大，暂时无法下载。',413);try{const str=atob(item.b64_json);bytes=Uint8Array.from(str,c=>c.charCodeAt(0));}catch{throw new AppError('返回的图片内容无法读取。',502);}type=imageInfo(bytes).type;}
  else if(item.url){let next=safeImageURL(item.url),response;for(let n=0;n<4;n++){response=await fetch(next.toString(),{redirect:'manual',signal:AbortSignal.timeout(90000)});if(response.status>=300&&response.status<400){assert(response.headers.get('location'),'图片下载地址已失效。',502);next=safeImageURL(new URL(response.headers.get('location'),next).toString());continue;}break;}assert(response.ok,'图片地址暂时无法访问，请稍后重试下载。',502);type=(response.headers.get('content-type')||'').split(';')[0];assert(TYPES.has(type),'返回的文件不是可下载的图片。',502);assert(Number(response.headers.get('content-length')||0)<=64*1024*1024,'图片过大，暂时无法下载。',413);const reader=response.body.getReader();let size=0;const chunks=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64*1024*1024){await reader.cancel();throw new AppError('图片过大，暂时无法下载。',413);}chunks.push(value);}bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}type=imageInfo(bytes).type;}
  else throw new AppError('这次结果没有可下载的图片。',502);
  const ext=type==='image/jpeg'?'jpg':type.split('/')[1];return new Response(bytes,{headers:{'Content-Type':type,'Content-Disposition':`attachment; filename="image-meow-${id}-${index+1}.${ext}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
export function createHandler(assets) {
  return {async fetch(req,env,ctx) {
    const path=new URL(req.url).pathname;
    try {
      // Freeze every application route before any database access during a final migration snapshot.
      if(path==='/api/migration-status'&&req.method==='GET')return json({mode:env.MIGRATION_MODE==='frozen'?'frozen':'normal',migrationId:env.MIGRATION_ID||null});
      if(env.MIGRATION_MODE==='frozen'){
        const headers={'Cache-Control':'no-store','Retry-After':'120'};
        if(path.startsWith('/api/'))return json({error:'网站正在迁移至新服务器，暂时无法登录或提交生图，请稍后刷新。'},503,headers);
        return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>image meow · 网站迁移中</title><body><main><h1>网站迁移中</h1><p>正在将服务迁移至新服务器，暂时无法登录或提交生图，请稍后刷新。</p><p>已有账号和历史记录会一并迁移。</p></main></body></html>',{status:503,headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
      }
      if(!path.startsWith('/api/')){const asset=assets[path==='/'?'/index.html':path];if(!asset)return new Response('页面不存在',{status:404});return new Response(asset.content,{headers:{'Content-Type':asset.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com"}});}
      assert(env.DB,'网站数据库尚未就绪，请联系站长完成部署。',503);
      if(!['GET','HEAD'].includes(req.method)) {assert(req.headers.get('origin')===new URL(req.url).origin,'页面已过期，请从本站重新打开后操作。',403);}
      const ip=req.headers.get('cf-connecting-ip')||'unknown';
      if(path==='/api/config' && req.method==='GET')return json({authMethods:['password'],registrationEnabled:mailReady(env),emailCodeEnabled:mailReady(env),passwordResetEnabled:mailReady(env),registrationRequiresEmailCode:true,registrationRequiresInvitation:true});
      const user=await getSession(req,env.DB);
      if(path==='/api/updates'&&req.method==='GET')return json({current:RELEASES[0],releases:RELEASES});
      if(path==='/api/me' && req.method==='GET')return json({user:user?publicUser(user):null});
      if(path==='/api/auth/code/send'&&req.method==='POST'){
        const input=await bodyJSON(req),email=validEmail(input.email);assert(['register','reset'].includes(input.purpose),'请选择注册或找回密码。');
        if(input.purpose==='register'){requireMail(env);await rate(env.DB,`invite-check:${ip}`,30,900);await usableInvitation(env,input.inviteCode);}
        return json(await sendEmailCode(env,email,input.purpose,ip));
      }
      if(path==='/api/auth/code/login')throw new AppError('请使用邮箱和密码登录。',403);
      if(path==='/api/auth/password/reset'&&req.method==='POST'){
        const input=await bodyJSON(req),email=validEmail(input.email);validatePassword(input.password);assert(input.password===input.confirmPassword,'两次输入的密码不一致。');
        await rate(env.DB,`reset-ip:${ip}`,10,900);
        const account=await one(env.DB,'SELECT * FROM users WHERE email=?',email);
        const hash=await passwordHash(input.password);
        await consumeEmailCode(env,email,'reset',input.code,ip);assert(account,'验证码不正确或已失效。');
        const updated=await one(env.DB,'UPDATE users SET password_hash=? WHERE id=? AND password_hash IS ? RETURNING id',hash,account.id,account.password_hash);
        assert(updated,'密码已在其他页面更改，请重新获取验证码。',409);
        await run(env.DB,'DELETE FROM sessions WHERE user_id=?',account.id);
        return json({ok:true},200,{'Set-Cookie':'__Host-jitu=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'});
      }
      if(path==='/api/auth/owner')throw new AppError('请使用邮箱和密码注册或登录。',403);
      if(path==='/api/auth/password/register' && req.method==='POST') {
        const input=await bodyJSON(req),email=validEmail(input.email);validatePassword(input.password);
        assert(input.password===input.confirmPassword,'两次输入的密码不一致。');
        await rate(env.DB,`register-ip:${ip}`,10,3600);await rate(env.DB,`register-email:${await sha(email)}`,5,3600);
        assert(!await one(env.DB,'SELECT id FROM users WHERE email=?',email),'该邮箱已注册，请切换到登录或找回密码。',409);
        requireMail(env);const invitation=await usableInvitation(env,input.inviteCode);
        const id=uid(),hash=await passwordHash(input.password);
        await consumeEmailCode(env,email,'register',input.code,ip);
        let created;
        try{created=await one(env.DB,'INSERT INTO users (id,email,password_hash,created_at,invitation_id) VALUES (?,?,?,?,?) ON CONFLICT(email) DO NOTHING RETURNING id',id,email,hash,now(),invitation.id);}catch(e){if(String(e.message).includes('INVITATION_UNAVAILABLE'))throw new AppError(INVITATION_ERROR,409);throw e;}
        assert(created,'该邮箱已注册，请切换到登录或找回密码。',409);
        return await sessionResponse(env.DB,{id,email,password_hash:hash},201);
      }
      if(path==='/api/auth/password/login' && req.method==='POST') {
        const input=await bodyJSON(req),email=validEmail(input.email);assert(typeof input.password==='string'&&input.password.length>0&&input.password.length<=128,'请填写密码。');await rate(env.DB,`login:${ip}`,15,900);await rate(env.DB,`password:${await sha(email)}`,10,900);
        const account=await one(env.DB,'SELECT * FROM users WHERE email=?',email);const stored=account?.password_hash||'pbkdf2:100000:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';const valid=await passwordMatches(input.password,stored);assert(account&&account.password_hash&&valid,'邮箱或密码不正确。首次使用请切换到注册。',401);return await sessionResponse(env.DB,account);
      }
      assert(user,'请先登录你的账号。',401);
      if(path.startsWith('/api/admin/activity/'))return await ownerActivity(req,env,user,path);
      if(path.startsWith('/api/admin/'))return await invitationAdmin(req,env,user,path);
      if(path==='/api/updates/seen'&&req.method==='POST'){const input=await bodyJSON(req);assert(input.version===RELEASES[0].version,'网站已有新版本，请刷新后查看。',409);await run(env.DB,'UPDATE users SET last_seen_release=? WHERE id=?',input.version,user.id);return json({ok:true});}
      if(path==='/api/storage'&&req.method==='GET')return json(await maintainAccountStorage(env,user));
      if(path==='/api/storage/ack'&&req.method==='POST'){const input=await bodyJSON(req);assert(Number.isSafeInteger(input.revision)&&input.revision>0,'清理通知编号无效。');await run(env.DB,'UPDATE account_storage SET acknowledged_revision=MAX(acknowledged_revision,?) WHERE user_id=? AND notice_revision>=?',input.revision,user.id,input.revision);return json({ok:true});}

      if(path==='/api/auth/password/set' && req.method==='POST') {
        const input=await bodyJSON(req);validatePassword(input.password);
        assert(input.password===input.confirmPassword,'两次输入的密码不一致。');
        await rate(env.DB,`password-change:${user.id}`,10,900);
        if(user.password_hash) {
          assert(typeof input.currentPassword==='string'&&input.currentPassword.length>0&&input.currentPassword.length<=128,'请输入当前密码。');
          assert(await passwordMatches(input.currentPassword,user.password_hash),'当前密码不正确。',403);
        }
        // Existing authenticated accounts without a password may set their first password.
        const hash=await passwordHash(input.password);
        const updated=await one(env.DB,'UPDATE users SET password_hash=? WHERE id=? AND password_hash IS ? RETURNING id',hash,user.id,user.password_hash);
        assert(updated,'密码已在其他页面更改，请重新登录。',409);
        await run(env.DB,'DELETE FROM email_codes WHERE email=?',user.email);
        await run(env.DB,'DELETE FROM sessions WHERE user_id=?',user.id);return await sessionResponse(env.DB,{...user,password_hash:hash});
      }
      if(path==='/api/auth/logout' && req.method==='POST'){await run(env.DB,'DELETE FROM sessions WHERE token_hash=?',user.token_hash);return json({ok:true},200,{'Set-Cookie':'__Host-jitu=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'});}
      if(path==='/api/models' && req.method==='GET') {const data=await upstreamJSON(await upstream('/api/models',(await requestKey(req,env,user)).key));return json({models:data});}
      if(path==='/api/onboarding/complete'&&req.method==='POST'){await run(env.DB,'UPDATE users SET onboarding_completed_at=? WHERE id=?',now(),user.id);return json({ok:true});}
      if(path==='/api/api-profiles'&&req.method==='GET'){const rows=await env.DB.prepare('SELECT * FROM api_profiles WHERE user_id=? ORDER BY created_at,id').bind(user.id).all();return json({profiles:rows.results.map(publicAPIProfile),selectedId:rows.results.some(p=>p.id===user.selected_api_id)?user.selected_api_id:rows.results[0]?.id||null});}
      if(path==='/api/api-profiles'&&req.method==='POST'){
        const input=await bodyJSON(req);const key=validateAPIKey(input.key);assert(typeof input.name==='string'&&input.name.trim()&&input.name.length<=40,'请为 API 填写 1 至 40 个字符的名称。');await rate(env.DB,`api-profile:${user.id}`,30,60);
        const hash=await sha(key);let profile=await one(env.DB,'SELECT * FROM api_profiles WHERE user_id=? AND key_hash=?',user.id,hash);
        if(!profile){const count=await one(env.DB,'SELECT COUNT(*) AS n FROM api_profiles WHERE user_id=?',user.id);assert(count.n<20,'一个账号最多保存 20 把 API，请先移除不需要的密钥。');const id=uid();await run(env.DB,'INSERT OR IGNORE INTO api_profiles (id,user_id,name,encrypted_key,key_hash,key_hint,created_at) VALUES (?,?,?,?,?,?,?)',id,user.id,input.name.trim(),await encryptAPIKey(env,user.id,id,key),hash,'•••• '+key.slice(-4),now());profile=await one(env.DB,'SELECT * FROM api_profiles WHERE key_hash=? AND user_id=?',hash,user.id);}
        await run(env.DB,'UPDATE users SET selected_api_id=? WHERE id=?',profile.id,user.id);return json({profile:publicAPIProfile(profile)},201);
      }
      const apiProfileMatch=path.match(/^\/api\/api-profiles\/([a-f0-9-]{36})$/);
      if(apiProfileMatch&&['POST','DELETE'].includes(req.method)){
        const profile=await one(env.DB,'SELECT * FROM api_profiles WHERE id=? AND user_id=?',apiProfileMatch[1],user.id);assert(profile,'找不到这把 API。',404);
        if(req.method==='DELETE'){await run(env.DB,'DELETE FROM api_profiles WHERE id=? AND user_id=?',profile.id,user.id);if(user.selected_api_id===profile.id)await run(env.DB,'UPDATE users SET selected_api_id=NULL WHERE id=?',user.id);return json({ok:true});}
        await run(env.DB,'UPDATE users SET selected_api_id=? WHERE id=?',profile.id,user.id);return json({ok:true});
      }
      if(path==='/api/conversations'&&req.method==='POST')return await withStorageLock(env,user,async check=>{
        const input=await bodyJSON(req);assert(typeof input.title==='string'&&input.title.trim()&&input.title.length<=60,'会话名称请填写 1 至 60 个字符。');assert(input.pinned==null||typeof input.pinned==='boolean','置顶设置格式不正确。');const settings=cleanSettings(input.settings);await checkConversationTarget(env,user,input.id);const previous=await one(env.DB,'SELECT title,settings FROM conversations WHERE id=? AND user_id=?',input.id,user.id);const growth=previous?Math.max(0,textBytes(input.title.trim())-textBytes(previous.title)):512+textBytes(input.title.trim())+textBytes(settings);await enforceStorage(env,user,input.id,growth,check);await ensureConversation(env.DB,user,input.id,input.title,settings);await run(env.DB,'UPDATE conversations SET title=?,pinned=?,updated_at=? WHERE id=? AND user_id=?',input.title.trim(),input.pinned?1:0,now(),input.id,user.id);return json({ok:true},201);
      });
      if(path==='/api/conversations' && req.method==='GET') {
        const list=await env.DB.prepare('SELECT * FROM conversations WHERE user_id=? AND deleted_at IS NULL ORDER BY pinned DESC,updated_at DESC').bind(user.id).all();
        const retry=await one(env.DB,'SELECT c.id FROM conversations c WHERE c.user_id=? AND c.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.id) LIMIT 1',user.id);if(retry)await withStorageLock(env,user,async check=>{await cleanDeletedConversation(env,user,retry.id,check);});
        return json({conversations:list.results.map(publicConversation)});
      }
      const conversationMatch=path.match(/^\/api\/conversations\/([a-f0-9-]{36})$/);
      if(conversationMatch&&['PATCH','DELETE'].includes(req.method))return await withStorageLock(env,user,async check=>{
        const id=conversationMatch[1];const own=await one(env.DB,'SELECT * FROM conversations WHERE id=? AND user_id=?',id,user.id);const legacy=await one(env.DB,'SELECT * FROM tasks WHERE id=? AND user_id=? AND conversation_id IS NULL',id,user.id);assert(own||legacy,'找不到这个生图会话。',404);
        if(req.method==='DELETE'){if(!own)await ensureConversation(env.DB,user,id,legacy.prompt);await run(env.DB,'UPDATE conversations SET deleted_at=?,pinned=0 WHERE id=? AND user_id=?',now(),id,user.id);const cleaned=await cleanDeletedConversation(env,user,id,check);return json({ok:true,cleanupPending:!cleaned});}
        assert(!own?.deleted_at,'这段会话已删除。',404);const input=await bodyJSON(req);assert(input.title!==undefined||input.pinned!==undefined,'请选择要更新的会话设置。');
        if(input.title!==undefined)assert(typeof input.title==='string'&&input.title.trim()&&input.title.length<=60,'会话名称请填写 1 至 60 个字符。');if(input.pinned!==undefined)assert(typeof input.pinned==='boolean','置顶设置格式不正确。');
        const growth=input.title===undefined?0:Math.max(0,textBytes(input.title.trim())-textBytes(own?.title));await enforceStorage(env,user,id,own?growth:512+textBytes((input.title||legacy?.prompt||'').slice(0,60)),check);await ensureConversation(env.DB,user,id,input.title||legacy?.prompt||own.title);if(input.title!==undefined)await run(env.DB,'UPDATE conversations SET title=?,updated_at=? WHERE id=? AND user_id=?',input.title.trim(),now(),id,user.id);if(input.pinned!==undefined)await run(env.DB,'UPDATE conversations SET pinned=? WHERE id=? AND user_id=?',input.pinned?1:0,id,user.id);return json({ok:true});
      });
      if(path==='/api/tasks' && req.method==='GET'){const records=await env.DB.prepare('SELECT t.* FROM tasks t LEFT JOIN conversations c ON c.id=COALESCE(t.conversation_id,t.id) WHERE t.user_id=? AND c.deleted_at IS NULL ORDER BY t.created_at DESC,t.rowid DESC LIMIT 500').bind(user.id).all();return json({tasks:records.results.map(publicTask)});}
      if(path==='/api/tasks' && req.method==='POST')return await createTask(req,env,user);
      const referenceMatch=path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/references\/(\d+)$/);
      if(referenceMatch&&req.method==='GET') {await rate(env.DB,`reference:${user.id}`,120,60);return await downloadReference(env,user,referenceMatch[1],Number(referenceMatch[2]));}
      const match=path.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/images\/(\d+))?$/);
      if(match && req.method==='GET') {await rate(env.DB,`query:${user.id}`,180,60);if(match[2]!=null)return await downloadImage(env,user,match[1],Number(match[2]),req);return json(await taskResult(env,user,match[1],req));}
      throw new AppError('没有找到这个功能。',404);
    } catch(e){return json({error:e instanceof AppError?e.message:'服务暂时遇到问题，请稍后重试。',...(e instanceof AppError&&e.details?{errorInfo:e.details}:{})},e instanceof AppError?e.status:500);}
  }};
}
