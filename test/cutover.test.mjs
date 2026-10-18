import {test} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';

async function certificates(dir){
 const run=(...args)=>execFileSync('openssl',args,{cwd:dir,stdio:'ignore'});
 run('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Cutover test CA');
 for(const [name,host] of [['old','preview.imagemeow.top'],['new','imagemeow.top']]){
  run('req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+host);
  await writeFile(join(dir,name+'.ext'),'subjectAltName=DNS:'+host+'\n');
  run('x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext');
 }
 return {old:{key:await readFile(join(dir,'old.key')),cert:await readFile(join(dir,'old.pem'))},fresh:{key:await readFile(join(dir,'new.key')),cert:await readFile(join(dir,'new.pem'))}};
}
function check(port,ca,retries){
 const env={...process.env,MEOW_HTTPS_CHECK_PORT:String(port),CURL_CA_BUNDLE:ca,HTTPS_PROXY:'http://127.0.0.1:1',https_proxy:'http://127.0.0.1:1'};
 if(retries!==undefined)env.MEOW_HTTPS_CHECK_RETRIES=String(retries);
 const child=spawn('bash',['deploy/ubuntu/check-root-https.sh'],{env});let out='',error='';
 child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>error+=chunk);
 return once(child,'close').then(([code])=>({code,out,error}));
}
test('cutover retries an old TLS certificate during reload but never accepts a permanently wrong hostname',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meow-tls-'));let server,timer;
 try{
  const certs=await certificates(dir);
  server=https.createServer(certs.old,(req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});
  server.on('tlsClientError',()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port,ca=join(dir,'ca.pem');
  const wrong=await check(port,ca,0);assert.equal(wrong.code,60);assert.equal(wrong.out,'');
  timer=setTimeout(()=>server.setSecureContext(certs.fresh),700);
  const switched=await check(port,ca);
  assert.equal(switched.code,0,switched.error);assert.equal(switched.out,'{"ok":true}');
  assert.match(switched.error,/subject|certificate/i);
 }finally{
  clearTimeout(timer);if(server?.listening){const closed=once(server,'close');server.close();await closed;}
  await rm(dir,{recursive:true,force:true});
 }
});
