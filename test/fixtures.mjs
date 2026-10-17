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
  if(url.includes('/tasks/')){const id=url.split('/').pop();if(!jobs.has(id))return Response.json({error:{message:'未找到任务'}},{status:404});const job=jobs.get(id);job.checks++;return Response.json({id,status:job.checks<2?'running':'succeeded',...(job.checks>=2?{result:{data:[{b64_json:PNG.toString('base64')}],jitu:{charged:0.02,balance:9.98}}}:{})});}
  if(url.endsWith('/generations')||url.endsWith('/edits')){const idempotency=opts.headers?.['Idempotency-Key'];const existing=[...jobs.entries()].find(([,v])=>v.key===idempotency);if(existing)return Response.json({id:existing[0],status:'queued'},{status:202});const id=String(++sequence);jobs.set(id,{checks:0,key:idempotency});return Response.json({id,status:'queued'},{status:202});}
 }
 return nativeFetch(input,opts);
 };
 return {calls,jobs,mail,restore(){globalThis.fetch=nativeFetch;}};
}
