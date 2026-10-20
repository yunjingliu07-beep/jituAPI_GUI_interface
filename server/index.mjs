import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHandler,maintainExistingStorage} from '../worker/core.js';
import {localBucket} from '../scripts/r2-local.mjs';
import {openDatabase} from './database.mjs';

export async function createServer({origin,dataDir,vaultKey,resendApiKey,emailFrom}){
 const publicURL=new URL(origin);
 if(publicURL.protocol!=='https:'||publicURL.origin!==origin||publicURL.username||publicURL.password)throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash.');
 if(!/^[a-f0-9]{64}$/.test(vaultKey||''))throw new Error('API_VAULT_KEY must contain 64 lowercase hexadecimal characters.');
 if(!dataDir)throw new Error('DATA_DIR is required.');
 const assets={};
 for(const [name,type] of [['index.html','text/html; charset=utf-8'],['style.css','text/css; charset=utf-8'],['app.js','application/javascript; charset=utf-8'],['parameters.js','application/javascript; charset=utf-8'],['activity.js','application/javascript; charset=utf-8'],['brand-mark.svg','image/svg+xml'],['cathead.png','image/png'],['cathead+logo.png','image/png']]){
  assets['/'+name]={type,content:await readFile(new URL('../public/'+name,import.meta.url),type==='image/png'?undefined:'utf8')};
 }
 assets['/favicon.svg']=assets['/brand-mark.svg'];
 const DB=openDatabase(dataDir),env={DB,API_VAULT_KEY:vaultKey,RESEND_API_KEY:resendApiKey,EMAIL_FROM:emailFrom,BUCKET:localBucket(resolve(dataDir,'references'))};
 const maintenance=await maintainExistingStorage(env);
 if(maintenance.failures)console.warn('Some account storage cleanup remains pending; it will retry on account access.');
 const app=createHandler(assets);
 const server=http.createServer({maxHeaderSize:16384},async(req,res)=>{
  try{
   // Nginx is the only public listener. Do not infer origins or IPs from arbitrary forwarded headers.
   if(req.headers.host!==publicURL.host||!req.url?.startsWith('/')||req.url.startsWith('//')){
    res.writeHead(421,{'Content-Type':'text/plain; charset=utf-8'});res.end('Unrecognized host.');return;
   }
   const url=new URL(origin+req.url);
   if(url.origin!==origin){res.writeHead(400);res.end();return;}
   if(url.pathname==='/healthz'&&['GET','HEAD'].includes(req.method)){
    DB.raw.prepare('SELECT 1').get();
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(req.method==='HEAD'?undefined:'{"ok":true}');return;
   }
   const headers=new Headers(req.headers);
   for(const name of ['oai-authenticated-user-id','oai-authenticated-user-email','cf-connecting-ip','x-real-ip','x-forwarded-for','x-forwarded-host','x-forwarded-proto','forwarded'])headers.delete(name);
   const peer=req.socket.remoteAddress;
   const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer);
   const realIP=req.headers['x-real-ip'];
   headers.set('cf-connecting-ip',local&&typeof realIP==='string'&&isIP(realIP)?realIP:peer||'unknown');
   const body=['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req);
   const request=new Request(url,{method:req.method,headers,body,duplex:'half'});
   const response=await app.fetch(request,env,{});
   res.writeHead(response.status,Object.fromEntries(response.headers));
   if(req.method==='HEAD'){await response.body?.cancel();res.end();}
   else if(response.body)await pipeline(Readable.fromWeb(response.body),res);
   else res.end();
  }catch{
   // Avoid logging request bodies, cookies, API keys, or database errors.
   if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"服务暂时遇到问题，请稍后重试。"}');}
   else res.destroy();
  }
 });
 server.requestTimeout=300000;
 server.headersTimeout=60000;
 server.keepAliveTimeout=5000;
 server.maxRequestsPerSocket=1000;
 server.on('close',()=>DB.raw.close());
 return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.env.JITU_QA==='1')throw new Error('QA mocks cannot be enabled in the production server.');
 const port=Number(process.env.PORT||3000);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT.');
 const server=await createServer({origin:process.env.PUBLIC_ORIGIN,dataDir:process.env.DATA_DIR,vaultKey:process.env.API_VAULT_KEY,resendApiKey:process.env.RESEND_API_KEY,emailFrom:process.env.EMAIL_FROM});
 server.listen(port,'127.0.0.1',()=>console.log(`image meow listening on 127.0.0.1:${port}`));
 function shutdown(){server.close();setTimeout(()=>process.exit(1),110000).unref();}
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
