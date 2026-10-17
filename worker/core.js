const UPSTREAM = 'https://www.jituapi.cn';
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const LIMIT = 50 * 1024 * 1024;
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const uid = () => crypto.randomUUID();
export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
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
function safeMessage(value, fallback) { const s = typeof value === 'string' ? value : value?.message; return s ? s.replace(/sk-[A-Za-z0-9_-]+/g, '[密钥已隐藏]').slice(0, 600) : fallback; }
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}}); }
async function bodyJSON(req, max = 16384) { assert(Number(req.headers.get('content-length') || 0) <= max,'提交内容过大。',413); const text = await new Response(limitedBody(req.body,max)).text(); assert(enc.encode(text).length <= max,'提交内容过大。',413); try { return JSON.parse(text); } catch { throw new AppError('提交内容无法读取，请刷新页面重试。'); } }
function limitedBody(body,max) { if(!body)return null;let bytes=0;return body.pipeThrough(new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>max)throw new AppError('提交内容过大，请减少图片或文字。',413);controller.enqueue(chunk);}})); }
const one = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
async function rate(db, key, maximum, seconds) {
  const t = now(); const row = await one(db, 'INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING count,reset_at', key, t+seconds, t, t, t+seconds);
  assert(row.count <= maximum, `操作太频繁，请在 ${Math.max(1,row.reset_at-t)} 秒后重试。`,429);
}
async function getSession(req, db) {
  const token = (req.headers.get('cookie') || '').match(/(?:^|;\s*)__Host-jitu=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  return one(db,'SELECT users.id,users.email,users.password_hash,sessions.verified_at,sessions.token_hash FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?',await sha(token),now());
}
async function sessionResponse(db, user, verified = false) {
  const token = randomToken(); const t = now();
  await run(db,'INSERT INTO sessions (token_hash,user_id,expires_at,verified_at) VALUES (?,?,?,?)',await sha(token),user.id,t+604800,verified?t:0);
  return json({user:{email:user.email,hasPassword:!!user.password_hash},verifiedUntil:verified?t+600:0},200,{'Set-Cookie':`__Host-jitu=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`});
}
async function takeCode(db, email, purpose, code) {
  assert(/^\d{6}$/.test(String(code)), '请输入 6 位邮箱验证码。');
  const row=await one(db,'SELECT * FROM email_codes WHERE email=? AND purpose=? ORDER BY created_at DESC LIMIT 1',email,purpose);
  assert(row && row.expires_at>now() && row.attempts<5,'验证码已过期或尝试次数过多，请重新发送。');
  await run(db,'UPDATE email_codes SET attempts=attempts+1 WHERE id=?',row.id);
  assert(await sha(`${row.id}:${code}`)===row.code_hash,'验证码不正确，请检查后重试。');
  const claimed=await one(db,'DELETE FROM email_codes WHERE id=? AND attempts<=5 AND expires_at>? RETURNING id',row.id,now());
  assert(claimed,'验证码已使用，请重新发送。');
}
async function sendCode(req, env, input) {
  const email=validEmail(input.email), purpose=input.purpose==='password'?'password':'login';
  assert(env.RESEND_API_KEY && env.EMAIL_FROM,'网站尚未配置验证码邮件服务，请联系站长设置发件邮箱。',503);
  await rate(env.DB,`code-email:${await sha(email)}`,1,60);
  await rate(env.DB,`code-day:${await sha(email)}`,12,86400);
  await rate(env.DB,`code-ip:${req.headers.get('cf-connecting-ip') || 'unknown'}`,15,3600);
  if(purpose==='password' && !(await one(env.DB,'SELECT id FROM users WHERE email=?',email))) return json({message:'如果邮箱已注册，验证码将发送到你的邮箱。'});
  const id=uid(); let number; do {number=crypto.getRandomValues(new Uint32Array(1))[0];} while(number>=4294000000);
  const code=String(number%1000000).padStart(6,'0');
  await run(env.DB,'DELETE FROM email_codes WHERE email=? AND purpose=?',email,purpose);
  await run(env.DB,'INSERT INTO email_codes (id,email,purpose,code_hash,expires_at,attempts,created_at) VALUES (?,?,?,?,?,0,?)',id,email,purpose,await sha(`${id}:${code}`),now()+600,now());
  let response;
  try {response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':id},body:JSON.stringify({from:env.EMAIL_FROM,to:[email],subject:`${code} 是你的即图验证码`,html:`<div style="background:#fff8f2;padding:40px;color:#243b36;font-family:sans-serif"><h2>即图 · 灵感工作室</h2><p>你的邮箱验证码是：</p><p style="font-size:32px;letter-spacing:8px;font-weight:bold">${code}</p><p>10 分钟内有效，请勿转发。如果这不是你的操作，请忽略此邮件。</p></div>`}),signal:AbortSignal.timeout(20000)});} catch {await run(env.DB,'DELETE FROM email_codes WHERE id=?',id);throw new AppError('邮件服务暂时无法连接，请稍后再试。',503);}
  if(!response.ok){await run(env.DB,'DELETE FROM email_codes WHERE id=?',id);throw new AppError('验证码未能发送，请联系站长检查邮件服务和发件域名。',503);}
  return json({message:'验证码已发送，请检查收件箱和垃圾邮件。'});
}
function keyFrom(req) { const key=(req.headers.get('x-jitu-key')||'').trim(); assert(key.length>=12 && key.length<=512 && /^[\x21-\x7e]+$/.test(key),'请先连接有效的即图 API 密钥。',422); return key; }
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
  try {return await fetch(UPSTREAM+path,{...options,headers:{...options.headers,Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(90000)});} catch {throw new AppError('与即图的连接暂时中断。请求可能已被受理，请使用「恢复原提交」核对，避免重复扣费。',504);}
}
async function upstreamJSON(response) {
  let data;try {data=await response.json();} catch {throw new AppError('即图暂时没有返回可读取的结果，请稍后再次查询。',502);}
  if(!response.ok){const common={400:'请检查尺寸、图片和模型支持的参数。',401:'密钥无效或已作废，请重新连接 API 密钥。',402:'即图余额或密钥额度不足，请充值后重试。',403:'密钥没有可用线路，请使用普通渠道密钥。',404:'模型或任务不存在，请检查模型及密钥所属账号。',409:'原提交与当前内容不一致，请恢复原来的参数和参考图。',410:'图片已超过保留时间，无法继续获取。',413:'上传图片过大，请缩小文件后重试。',429:'请求太频繁，请稍后重试。',502:'上游生成失败，请在即图控制台核对退款。',503:'所选模型暂时没有可用线路。'};throw new AppError(safeMessage(data.error||data.detail||data.message,common[response.status]||'即图服务暂时不可用，请稍后再试。'),response.status===401?422:response.status);}
  return data;
}
async function createTask(req,env,user) {
  const key=keyFrom(req), idem=req.headers.get('idempotency-key');assert(/^[a-f0-9-]{36}$/.test(idem||''),'提交标记无效，请刷新页面。');
  assert(Number(req.headers.get('content-length')||0)<=LIMIT,'上传总大小不能超过 50 MiB。',413);
  let p, forward, headers={}, fingerprints=[];
  if((req.headers.get('content-type')||'').startsWith('multipart/form-data')) {
    let form;try {form=await new Response(limitedBody(req.body,LIMIT),{headers:{'Content-Type':req.headers.get('content-type')}}).formData();} catch(e) {if(e instanceof AppError)throw e;throw new AppError('图片上传不完整，请重新选择图片。');}
    p=validateParams(Object.fromEntries(['mode','model','prompt','n','size'].map(k=>[k,form.get(k)])));
    assert(p.mode!=='text','文生图不需要上传图片。');
    const files=[...form.getAll('image'),...form.getAll('image[]')];assert(files.length>=1&&files.length<=16,'请选择 1 至 16 张参考图。');
    const mask=form.get('mask');const total=files.reduce((n,f)=>n+(f.size||0),0)+(mask?.size||0);assert(total+enc.encode(p.prompt).length+65536<=LIMIT,'参考图和遮罩合计过大，请控制在 50 MiB 以内。',413);
    let first;for(let i=0;i<files.length;i++){const checked=await checkFile(files[i]);if(!i)first=checked.info;fingerprints.push(checked.hash);}
    if(p.mode==='mask'){assert(mask,'局部编辑需要上传 PNG 遮罩。');const checked=await checkFile(mask,true);assert(first.width&&first.height,'局部编辑的第一张参考图请使用 PNG 或 JPG。');assert(first.width===checked.info.width&&first.height===checked.info.height,'遮罩的宽度和高度必须与第一张参考图完全相同。');fingerprints.push(checked.hash);}
    else assert(!mask,'图生图模式请不要上传遮罩。');
    forward=new FormData();for(const k of ['model','prompt','n','size'])forward.set(k,String(p[k]));forward.set('async','true');for(let i=0;i<files.length;i++)forward.append(files.length===1?'image':'image[]',files[i],`reference-${i}.${files[i].type.split('/')[1]}`);if(mask)forward.set('mask',mask,'mask.png');
  } else {const input=await bodyJSON(req,20000);p=validateParams(input);assert(p.mode==='text','图生图请通过上传窗口选择参考图片。');forward=JSON.stringify({model:p.model,prompt:p.prompt,n:p.n,size:p.size,async:true});headers['Content-Type']='application/json';}
  const fingerprint=await sha(JSON.stringify([p.mode,p.model,p.prompt,p.n,p.size,fingerprints,await sha(key)]));
  const existing=await one(env.DB,'SELECT * FROM tasks WHERE user_id=? AND idempotency_key=?',user.id,idem);
  if(existing){assert(existing.fingerprint===fingerprint,'恢复原提交时，请保持原来的文字、参数和图片不变。',409);if(existing.upstream_id || ['succeeded','failed','expired'].includes(existing.status))return json({task:publicTask(existing)});}
  await rate(env.DB,`generate:${user.id}`,20,60);
  if(!existing){await run(env.DB,'INSERT OR IGNORE INTO tasks (id,user_id,idempotency_key,fingerprint,mode,prompt,model,size,count,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',uid(),user.id,idem,fingerprint,p.mode,p.prompt,p.model,p.size,p.n,'submitting',now(),now());}
  const task=await one(env.DB,'SELECT * FROM tasks WHERE user_id=? AND idempotency_key=?',user.id,idem);
  assert(task.fingerprint===fingerprint,'提交内容发生了变化，请恢复原提交内容。',409);
  let data;
  try {data=await upstreamJSON(await upstream(p.mode==='text'?'/v1/images/generations':'/v1/images/edits',key,{method:'POST',headers:{...headers,'Idempotency-Key':idem},body:forward}));}
  catch(e){const ambiguous=e.status>=500||e.status===429;await run(env.DB,'UPDATE tasks SET status=?,error=?,updated_at=? WHERE id=?',ambiguous?'unknown':'failed',e.message,now(),task.id);throw new AppError(e.message,e.status);}
  const upstreamID=data.id??data.jitu?.request_id;assert(upstreamID!=null,'即图未返回任务编号，请保留原提交并稍后核对。',502);
  assert(/^[a-zA-Z0-9_-]{1,150}$/.test(String(upstreamID)),'即图返回的任务编号无法识别，请联系支持核对。',502);
  const status=data.data?'succeeded':['queued','running','succeeded','failed','expired'].includes(data.status)?data.status:'queued';
  await run(env.DB,'UPDATE tasks SET upstream_id=?,status=?,error=NULL,updated_at=? WHERE id=?',String(upstreamID),status,now(),task.id);
  return json({task:publicTask({...task,upstream_id:String(upstreamID),status}),result:data.data?data:undefined},202);
}
export function publicTask(t) {return {id:t.id,upstreamId:t.upstream_id,idempotencyKey:t.idempotency_key,mode:t.mode,prompt:t.prompt,model:t.model,size:t.size,n:t.count,status:t.status,error:t.error,createdAt:t.created_at,updatedAt:t.updated_at,charged:t.charged,balance:t.balance};}
async function taskResult(env,user,id,key) {
  const task=await one(env.DB,'SELECT * FROM tasks WHERE id=? AND user_id=?',id,user.id);assert(task,'找不到这次创作记录。',404);
  if(!task.upstream_id)return {task:publicTask(task)};
  if(task.created_at+43200<now()){await run(env.DB,'UPDATE tasks SET status=?,updated_at=? WHERE id=?','expired',now(),task.id);return {task:publicTask({...task,status:'expired'})};}
  const data=await upstreamJSON(await upstream(`/v1/images/tasks/${encodeURIComponent(task.upstream_id)}`,key));
  assert(['queued','running','succeeded','failed','expired'].includes(data.status),'暂时无法识别生成状态，请稍后再查询。',502);
  const error=data.status==='failed'?safeMessage(data.error,'生成失败，请在即图控制台核对退款。'):null;
  await run(env.DB,'UPDATE tasks SET status=?,error=?,updated_at=?,charged=COALESCE(?,charged),balance=COALESCE(?,balance) WHERE id=?',data.status,error,now(),data.result?.jitu?.charged??null,data.result?.jitu?.balance??null,task.id);
  return {task:publicTask({...task,status:data.status,error}),result:data.status==='succeeded'?data.result:undefined};
}
export function safeImageURL(raw) {
  let u;try{u=new URL(raw);}catch{throw new AppError('图片下载地址无法读取。',502);}
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();assert(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.port,'图片下载地址不安全，已停止下载。',502);
  assert(host.includes('.')&&!host.includes(':')&&!/^\d+(\.\d+){3}$/.test(host)&&!/(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host)&&!host.endsWith('.local')&&!host.endsWith('.internal'),'图片下载地址不安全，已停止下载。',502);return u;
}
async function downloadImage(env,user,id,index,key) {
  assert(Number.isInteger(index)&&index>=0&&index<16,'图片序号无效。');const result=await taskResult(env,user,id,key);assert(result.task.status==='succeeded','图片还没有生成完成。',409);
  const item=result.result?.data?.[index];assert(item,'这张图片不存在。',404);
  let bytes,type;
  if(item.b64_json){assert(typeof item.b64_json==='string' && item.b64_json.length<=90*1024*1024,'图片过大，暂时无法下载。',413);try{const str=atob(item.b64_json);bytes=Uint8Array.from(str,c=>c.charCodeAt(0));}catch{throw new AppError('返回的图片内容无法读取。',502);}type=imageInfo(bytes).type;}
  else if(item.url){let next=safeImageURL(item.url),response;for(let n=0;n<4;n++){response=await fetch(next.toString(),{redirect:'manual',signal:AbortSignal.timeout(90000)});if(response.status>=300&&response.status<400){assert(response.headers.get('location'),'图片下载地址已失效。',502);next=safeImageURL(new URL(response.headers.get('location'),next).toString());continue;}break;}assert(response.ok,'图片地址暂时无法访问，请稍后重试下载。',502);type=(response.headers.get('content-type')||'').split(';')[0];assert(TYPES.has(type),'返回的文件不是可下载的图片。',502);assert(Number(response.headers.get('content-length')||0)<=64*1024*1024,'图片过大，暂时无法下载。',413);const reader=response.body.getReader();let size=0;const chunks=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64*1024*1024){await reader.cancel();throw new AppError('图片过大，暂时无法下载。',413);}chunks.push(value);}bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}type=imageInfo(bytes).type;}
  else throw new AppError('这次结果没有可下载的图片。',502);
  const ext=type==='image/jpeg'?'jpg':type.split('/')[1];return new Response(bytes,{headers:{'Content-Type':type,'Content-Disposition':`attachment; filename="jitu-${id}-${index+1}.${ext}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
export function createHandler(assets) {
  return {async fetch(req,env,ctx) {
    const path=new URL(req.url).pathname;
    try {
      if(!path.startsWith('/api/')){const asset=assets[path==='/'?'/index.html':path];if(!asset)return new Response('页面不存在',{status:404});return new Response(asset.content,{headers:{'Content-Type':asset.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com"}});}
      assert(env.DB,'网站数据库尚未就绪，请联系站长完成部署。',503);
      if(!['GET','HEAD'].includes(req.method)) {assert(req.headers.get('origin')===new URL(req.url).origin,'页面已过期，请从本站重新打开后操作。',403);}
      const ip=req.headers.get('cf-connecting-ip')||'unknown';
      if(path==='/api/config' && req.method==='GET')return json({mailReady:!!(env.RESEND_API_KEY&&env.EMAIL_FROM),ownerLoginAvailable:!!req.headers.get('oai-authenticated-user-id')});
      const user=await getSession(req,env.DB);
      if(path==='/api/me' && req.method==='GET')return json({user:user?{email:user.email,hasPassword:!!user.password_hash}:null,verifiedUntil:user?user.verified_at+600:0});
      if(path==='/api/auth/code/send' && req.method==='POST')return await sendCode(req,env,await bodyJSON(req));
      if(path==='/api/auth/code/login' && req.method==='POST') {
        const input=await bodyJSON(req), email=validEmail(input.email);await rate(env.DB,`login:${ip}`,30,900);await takeCode(env.DB,email,'login',input.code);
        await run(env.DB,'INSERT OR IGNORE INTO users (id,email,created_at) VALUES (?,?,?)',uid(),email,now());const account=await one(env.DB,'SELECT * FROM users WHERE email=?',email);return sessionResponse(env.DB,account,true);
      }
      if(path==='/api/auth/password/login' && req.method==='POST') {
        const input=await bodyJSON(req),email=validEmail(input.email);assert(typeof input.password==='string'&&input.password.length<=128,'请填写密码。');await rate(env.DB,`login:${ip}`,15,900);await rate(env.DB,`password:${await sha(email)}`,10,900);
        const account=await one(env.DB,'SELECT * FROM users WHERE email=?',email);const stored=account?.password_hash||'pbkdf2:100000:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';const valid=await passwordMatches(input.password,stored);assert(account&&account.password_hash&&valid,'邮箱或密码不正确。首次使用请先通过验证码注册。',401);return sessionResponse(env.DB,account);
      }
      if(path==='/api/auth/owner' && req.method==='POST') {
        assert(req.headers.get('oai-authenticated-user-id')&&req.headers.get('oai-authenticated-user-email'),'管理预览仅限通过托管平台验证的站长。',403);const email=validEmail(req.headers.get('oai-authenticated-user-email'));
        await run(env.DB,'INSERT OR IGNORE INTO users (id,email,created_at) VALUES (?,?,?)',uid(),email,now());return sessionResponse(env.DB,await one(env.DB,'SELECT * FROM users WHERE email=?',email),true);
      }
      assert(user,'请先登录你的账号。',401);
      if(path==='/api/auth/password/set' && req.method==='POST') {
        const input=await bodyJSON(req);validatePassword(input.password);
        if(user.verified_at+600<now()){await rate(env.DB,`reset:${user.id}`,10,900);await takeCode(env.DB,user.email,'password',input.code);}
        await run(env.DB,'UPDATE users SET password_hash=? WHERE id=?',await passwordHash(input.password),user.id);
        await run(env.DB,'DELETE FROM sessions WHERE user_id=?',user.id);return sessionResponse(env.DB,{...user,password_hash:'set'},true);
      }
      if(path==='/api/auth/logout' && req.method==='POST'){await run(env.DB,'DELETE FROM sessions WHERE token_hash=?',user.token_hash);return json({ok:true},200,{'Set-Cookie':'__Host-jitu=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'});}
      if(path==='/api/models' && req.method==='GET') {const data=await upstreamJSON(await upstream('/api/models',keyFrom(req)));return json({models:data});}
      if(path==='/api/tasks' && req.method==='GET'){const records=await env.DB.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(user.id).all();return json({tasks:records.results.map(publicTask)});}
      if(path==='/api/tasks' && req.method==='POST')return await createTask(req,env,user);
      const match=path.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/images\/(\d+))?$/);
      if(match && req.method==='GET') {await rate(env.DB,`query:${user.id}`,180,60);const key=keyFrom(req);if(match[2]!=null)return await downloadImage(env,user,match[1],Number(match[2]),key);return json(await taskResult(env,user,match[1],key));}
      throw new AppError('没有找到这个功能。',404);
    } catch(e){return json({error:e instanceof AppError?e.message:'服务暂时遇到问题，请稍后重试。'},e instanceof AppError?e.status:500);}
  }};
}
