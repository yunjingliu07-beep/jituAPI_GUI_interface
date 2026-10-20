import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {localDB} from '../scripts/d1-local.mjs';
import {PNG} from './fixtures.mjs';
import {passwordHash,passwordMatches,encryptAPIKey,sha,createHandler} from '../worker/core.js';
import {validateSnapshot,encryptSnapshot,decryptSnapshot,prepareImport} from '../server/migration-transfer.mjs';
import {databaseFile} from '../server/database.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const recipient=()=>generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{format:'pem',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
async function snapshot(){
 const source=localDB(),vaultKey='b'.repeat(64),user=crypto.randomUUID(),profile=crypto.randomUUID(),task=crypto.randomUUID(),key='sk-migration-test-only';
 try{
  source.raw.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(user,'migration@example.com',await passwordHash('original-password-123'),1);
  source.raw.prepare('INSERT INTO api_profiles(id,user_id,name,encrypted_key,key_hash,key_hint,created_at) VALUES(?,?,?,?,?,?,?)').run(profile,user,'original',await encryptAPIKey({API_VAULT_KEY:vaultKey},user,profile,key),await sha(key),'•••• only',1);
  const fileKey=`references/${user}/${task}/0-${hash(PNG)}`;
  const refs=JSON.stringify([{index:0,key:fileKey,kind:'image',name:'original.png',type:'image/png',size:PNG.length}]);
  source.raw.prepare('INSERT INTO tasks(id,user_id,idempotency_key,fingerprint,mode,prompt,model,size,count,status,created_at,updated_at,reference_files,api_profile_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(task,user,crypto.randomUUID(),'fingerprint','edit','original prompt','test-model','1024x1024',1,'succeeded',1,1,refs,profile);
  return {format:'image-meow-snapshot-v1',projectId:'appgprj_6ad3602eac1c8191beccd3a66e796b09',migrationId:crypto.randomUUID(),capturedAt:new Date().toISOString(),vaultKey,tables:Object.fromEntries(['users','conversations','api_profiles','tasks'].map(t=>[t,source.raw.prepare(`SELECT * FROM ${t}`).all()])),references:{[fileKey]:PNG.toString('base64')}};
 }finally{source.raw.close();}
}

test('migration freeze blocks every product route before database access or upstream calls',async()=>{
 const env={MIGRATION_MODE:'frozen',MIGRATION_ID:crypto.randomUUID(),DB:new Proxy({},{get(){throw new Error('Database must not be touched while frozen');}})};
 const handler=createHandler({});
 for(const [method,path] of [['GET','/'],['GET','/app.js'],['GET','/style.css'],['GET','/cathead.png'],['POST','/site-icon.png'],['GET','/api/tasks'],['GET','/api/conversations'],['POST','/api/auth/password/register'],['POST','/api/tasks'],['DELETE','/api/api-profiles/anything']]){
  const r=await handler.fetch(new Request('https://example.com'+path,{method}),env,{});
  assert.equal(r.status,503);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('retry-after'),'120');
 }
 const status=await handler.fetch(new Request('https://example.com/api/migration-status'),env,{});
 assert.deepEqual(await status.json(),{mode:'frozen',migrationId:env.MIGRATION_ID});
});

test('frozen mirror serves only public branding icons while product routes remain paused',async()=>{
 const icon=await readFile(new URL('../public/site-icon.png',import.meta.url));
 const assets={'/site-icon.png':{type:'image/png',content:icon},'/favicon.ico':{type:'image/x-icon',content:await readFile(new URL('../public/favicon.ico',import.meta.url))},'/favicon.svg':{type:'image/svg+xml',content:await readFile(new URL('../public/brand-mark.svg',import.meta.url),'utf8')}};
 assets['/favicon.png']=assets['/site-icon.png'];
 const handler=createHandler(assets),env={MIGRATION_MODE:'frozen',DB:new Proxy({},{get(){throw new Error('Icons must not touch the database');}})};
 for(const [path,asset] of Object.entries(assets)){
  const response=await handler.fetch(new Request('https://example.com'+path+'?v=paw-20261020'),env,{});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),asset.type);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(asset.content));
  const head=await handler.fetch(new Request('https://example.com'+path,{method:'HEAD'}),env,{});assert.equal(head.status,200);
 }
 const paused=await handler.fetch(new Request('https://example.com/'),env,{});
 assert.equal(paused.status,503);assert.match(await paused.text(),/rel="icon"[^>]+site-icon\.png\?v=paw-20261020/);
 const product=await handler.fetch(new Request('https://example.com/api/me'),env,{});assert.equal(product.status,503);
});

test('migration packages require the recipient private key and reject tampering or missing references',async()=>{
 const original=await snapshot(),pair=recipient(),other=recipient();
 const bytes=encryptSnapshot(original,pair.publicKey),checksum=hash(bytes);
 for(const text of ['migration@example.com','original prompt',original.vaultKey,'sk-migration-test-only'])assert(!bytes.includes(text));
 assert.deepEqual(decryptSnapshot(bytes,pair.privateKey,checksum),JSON.parse(JSON.stringify(original)));
 assert.throws(()=>decryptSnapshot(bytes,other.privateKey,checksum));
 assert.throws(()=>decryptSnapshot(bytes,pair.privateKey,'0'.repeat(64)));
 const modified=JSON.parse(bytes),data=Buffer.from(modified.data,'base64');data[0]^=1;modified.data=data.toString('base64');const corrupted=Buffer.from(JSON.stringify(modified));
 assert.throws(()=>decryptSnapshot(corrupted,pair.privateKey,hash(corrupted)));
 assert.throws(()=>validateSnapshot({...original,references:{}}));
 assert.throws(()=>validateSnapshot({...original,vaultKey:'c'.repeat(64)}));
});

test('migration import preserves passwords, profile encryption and reference ownership; invalid snapshots leave no database',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meow-import-')),original=await snapshot();
 try{
  const destination=join(dir,'imported'),receipt=prepareImport(original,destination,'d'.repeat(64));
  assert.deepEqual(receipt.counts,{users:1,conversations:0,api_profiles:1,tasks:1,references:1});
  const db=new DatabaseSync(databaseFile(destination));
  try{
   const user=db.prepare('SELECT * FROM users').get();assert(await passwordMatches('original-password-123',user.password_hash));
   const profile=db.prepare('SELECT * FROM api_profiles').get();assert.equal(profile.encrypted_key,original.tables.api_profiles[0].encrypted_key);
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
   assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
  const key=Object.keys(original.references)[0];assert.deepEqual(await readFile(join(destination,'references',key)),PNG);
  const invalid=structuredClone(original);invalid.tables.tasks[0].user_id='missing-user';
  assert.throws(()=>prepareImport(invalid,join(dir,'invalid'),'d'.repeat(64)));
  await assert.rejects(readFile(join(dir,'invalid','studio.sqlite')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
