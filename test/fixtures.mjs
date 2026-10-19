import {createHash,randomBytes,randomUUID} from 'node:crypto';
export const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
export function mockUpstream(){
 const calls=[],jobs=new Map(),mail=[],nativeFetch=globalThis.fetch;let sequence=0;
 globalThis.fetch=async(input,opts={})=>{
 const url=String(input);
 if(url==='https://api.resend.com/emails'){const body=JSON.parse(opts.body);mail.push(body);return Response.json({id:'mail-test'});}
 if(url.startsWith('https://www.jituapi.cn')){
  calls.push({url,opts});
  if(url.endsWith('/api/models'))return Response.json([{id:'gpt-image-2.5-flare'}]);
  const key=opts.headers?.Authorization;if(key==='Bearer invalid-test-key')return Response.json({error:{message:'密钥无效'}},{status:401});
  if(url.includes('/tasks/')){const id=url.split('/').pop();if(!jobs.has(id))return Response.json({error:{message:'未找到任务'}},{status:404});const job=jobs.get(id);job.checks++;if(job.error)return Response.json({id,status:'failed',error:job.error});return Response.json({id,status:job.checks<2?'running':'succeeded',...(job.checks>=2?{result:{data:[{b64_json:PNG.toString('base64')}],jitu:{charged:0.02,balance:9.98}}}:{})});}
  if(url.endsWith('/generations')||url.endsWith('/edits')){const input=typeof opts.body==='string'?JSON.parse(opts.body):Object.fromEntries(opts.body);if(input.prompt==='QA_FAIL_BALANCE')return Response.json({error:{code:'insufficient_quota',message:'额度不足，请在控制台充值'}},{status:402});const idempotency=opts.headers?.['Idempotency-Key'];const existing=[...jobs.entries()].find(([,v])=>v.key===idempotency);if(existing)return Response.json({id:existing[0],status:'queued'},{status:202});const id=String(++sequence);jobs.set(id,{checks:0,key:idempotency,...(input.prompt==='QA_ASYNC_FAIL'?{error:{code:'upstream_error',type:'upstream_error',message:'生成失败，费用已退回',request_id:id}}:{})});return Response.json({id,status:'queued'},{status:202});}
 }
 return nativeFetch(input,opts);
 };
 return {calls,jobs,mail,restore(){globalThis.fetch=nativeFetch;}};
}

export function mockBucket(){const objects=new Map();return {objects,async put(key,body){objects.set(key,new Uint8Array(await new Response(body).arrayBuffer()));},async get(key){const bytes=objects.get(key);return bytes?{body:bytes.slice()}:null;},async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])objects.delete(key);}};}

// Seed an issuer and invitation without relying on the feature under test.
export function seedInvitation(db){
 let owner=db.prepare("SELECT id FROM users WHERE role='owner'").get();
 if(!owner){owner={id:randomUUID()};db.prepare("INSERT INTO users(id,email,role,created_at) VALUES (?,?,'owner',?)").run(owner.id,'fixture-owner@example.com',Math.floor(Date.now()/1000));}
 const raw=randomBytes(16).toString('hex').toUpperCase();
 db.prepare('INSERT INTO registration_invitations(id,code_hash,code_hint,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(randomUUID(),createHash('sha256').update(raw).digest('hex'),raw.slice(0,4)+'…'+raw.slice(-4),owner.id,Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)+86400);
 return 'MEOW-'+raw.match(/.{4}/g).join('-');
}
