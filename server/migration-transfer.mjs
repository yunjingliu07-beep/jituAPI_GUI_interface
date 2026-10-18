import {createPublicKey,createPrivateKey,randomBytes,createCipheriv,createDecipheriv,publicEncrypt,privateDecrypt,constants,createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,copyFileSync,rmSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {migrate,databaseFile} from './database.mjs';

const PROJECT='appgprj_6ad3602eac1c8191beccd3a66e796b09';
const FORMAT='image-meow-transfer-v1';
const AAD=Buffer.from(FORMAT+':'+PROJECT);
const TABLES=['users','conversations','api_profiles','tasks'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const requireThat=(value,message)=>{if(!value)throw new Error(message);};
export function publicKeyId(key){return digest(createPublicKey(key).export({type:'spki',format:'der'}));}

export function validateSnapshot(snapshot){
 requireThat(snapshot?.format==='image-meow-snapshot-v1'&&snapshot.projectId===PROJECT,'Unexpected snapshot format or source.');
 requireThat(/^[a-f0-9]{64}$/.test(snapshot.vaultKey||''),'The source encryption key is missing.');
 requireThat(/^[a-f0-9-]{36}$/.test(snapshot.migrationId||'')&&Number.isFinite(Date.parse(snapshot.capturedAt)),'The snapshot has no migration identity.');
 const counts={};
 for(const table of TABLES){requireThat(Array.isArray(snapshot.tables?.[table]),'A required source table is missing.');counts[table]=snapshot.tables[table].length;}
 requireThat(counts.users>0,'The source snapshot contains no accounts.');
 for(const user of snapshot.tables.users)requireThat(user.password_hash===null||/^pbkdf2:100000:[a-f0-9]{32}:[a-f0-9]{64}$/.test(user.password_hash),'A source password hash is not supported.');
 const files=snapshot.references||{},needed=new Set();
 for(const task of snapshot.tables.tasks){
  let references;try{references=JSON.parse(task.reference_files||'[]');}catch{throw new Error('Invalid source reference metadata.');}
  requireThat(Array.isArray(references),'Invalid source reference metadata.');
  for(const ref of references){
   requireThat(typeof ref.key==='string'&&/^references\/[a-f0-9-]+\/[a-f0-9-]+\/\d+-[a-f0-9]{64}$/.test(ref.key),'Invalid source reference object key.');
   requireThat(typeof files[ref.key]==='string','A source reference image is missing.');
   const bytes=Buffer.from(files[ref.key],'base64');
   requireThat(bytes.length===ref.size&&digest(bytes)===ref.key.slice(-64),'A reference image failed its integrity check.');needed.add(ref.key);
  }
 }
 requireThat(Object.keys(files).length===needed.size,'Unexpected reference files in the snapshot.');
 for(const profile of snapshot.tables.api_profiles){
  requireThat(typeof profile.encrypted_key==='string'&&/^[a-f0-9]{24}:[a-f0-9]+$/.test(profile.encrypted_key),'Invalid encrypted API profile.');
  const [ivHex,cipherHex]=profile.encrypted_key.split(':'),cipher=Buffer.from(cipherHex,'hex');
  const decrypt=createDecipheriv('aes-256-gcm',Buffer.from(snapshot.vaultKey,'hex'),Buffer.from(ivHex,'hex'));
  decrypt.setAAD(Buffer.from(profile.user_id+':'+profile.id));decrypt.setAuthTag(cipher.subarray(-16));
  const key=Buffer.concat([decrypt.update(cipher.subarray(0,-16)),decrypt.final()]);
  requireThat(digest(key)===profile.key_hash,'The original API encryption key could not be verified.');
 }
 return {...counts,references:needed.size};
}

export function encryptSnapshot(snapshot,recipient){
 validateSnapshot(snapshot);
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD);
 const data=Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(snapshot)))),cipher.final()]);
 return Buffer.from(JSON.stringify({format:FORMAT,keyId:publicKeyId(recipient),wrappedKey:publicEncrypt({key:recipient,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));
}
export function decryptSnapshot(bytes,privateKey,expectedHash){
 requireThat(/^[a-f0-9]{64}$/.test(expectedHash||'')&&digest(bytes)===expectedHash,'The encrypted file checksum does not match.');
 requireThat(bytes.length<256*1024*1024,'The migration file is too large.');
 const envelope=JSON.parse(bytes);
 requireThat(envelope.format===FORMAT&&envelope.keyId===publicKeyId(createPublicKey(privateKey).export({type:'spki',format:'pem'})),'The migration file belongs to a different server.');
 const key=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(envelope.wrappedKey,'base64'));
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAAD(AAD);decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
 const payload=Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]);
 const snapshot=JSON.parse(gunzipSync(payload,{maxOutputLength:256*1024*1024}).toString('utf8'));
 validateSnapshot(snapshot);return snapshot;
}

export function prepareImport(snapshot,directory,packageHash){
 const counts=validateSnapshot(snapshot);requireThat(!existsSync(directory),'The import staging directory already exists.');
 mkdirSync(directory,{mode:0o700});
 try{
  migrate(directory);
  const db=new DatabaseSync(databaseFile(directory));
  try{
   db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
   for(const table of TABLES){
    const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
    const insert=db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
    for(const row of snapshot.tables[table]){
     requireThat(columns.every(column=>Object.hasOwn(row,column)),'The source schema is incomplete.');
     requireThat(Object.keys(row).every(column=>columns.includes(column)),'The source schema has unsupported columns.');
     insert.run(...columns.map(column=>row[column]));
    }
    requireThat(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n===counts[table],'Imported row count differs from the source.');
   }
   requireThat(db.prepare('PRAGMA foreign_key_check').all().length===0,'Imported records have broken ownership references.');
   db.exec('COMMIT');
   requireThat(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','Imported database integrity check failed.');
   db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }finally{db.close();}
  for(const [key,encoded] of Object.entries(snapshot.references||{})){
   const file=join(directory,'references',key);mkdirSync(resolve(file,'..'),{recursive:true,mode:0o700});writeFileSync(file,Buffer.from(encoded,'base64'),{mode:0o600});
  }
  const receipt={projectId:PROJECT,migrationId:snapshot.migrationId,capturedAt:snapshot.capturedAt,packageHash,counts};
  writeFileSync(join(directory,'migration-receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
  return receipt;
 }catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}

function service(action){execFileSync('systemctl',[action,'image-meow'],{stdio:'ignore',timeout:130000});}
async function healthy(origin){
 for(let attempt=0;attempt<12;attempt++){
  const ok=await new Promise(resolve=>{
   const req=httpRequest({hostname:'127.0.0.1',port:3000,path:'/healthz',headers:{Host:new URL(origin).host}},res=>{res.resume();resolve(res.statusCode===200);});
   req.on('error',()=>resolve(false));req.setTimeout(2000,()=>{req.destroy();resolve(false);});req.end();
  });if(ok)return;await new Promise(resolve=>setTimeout(resolve,500));
 }throw new Error('The imported service did not pass its health check.');
}

export async function installImport(snapshot,packageHash){
 requireThat(process.getuid?.()===0,'Run the import with sudo.');
 const config='/etc/image-meow/server.env',data='/var/lib/image-meow';
 const previous=readFileSync(config,'utf8');
 requireThat(/^DATA_DIR=\/var\/lib\/image-meow$/m.test(previous),'Unexpected production data directory.');
 const origin=previous.match(/^PUBLIC_ORIGIN=(https:\/\/[^\s]+)$/m)?.[1];requireThat(origin,'Missing public origin.');
 const stage='/var/lib/.image-meow-import-'+randomUUID();
 const receipt=prepareImport(snapshot,stage,packageHash);
 execFileSync('chown',['-R','image-meow:image-meow',stage],{stdio:'ignore'});
 const backup='/var/backups/image-meow-migration-'+new Date().toISOString().replace(/[:.]/g,'-');
 mkdirSync(backup,{mode:0o700});chmodSync(backup,0o700);
 copyFileSync(config,join(backup,'server.env'));chmodSync(join(backup,'server.env'),0o600);
 let moved=false,installed=false;
 try{
  service('stop');
  renameSync(data,join(backup,'data'));moved=true;
  renameSync(stage,data);installed=true;
  requireThat(/^API_VAULT_KEY=[a-f0-9]{64}$/m.test(previous),'Unexpected encryption key configuration.');
  const updated=previous.replace(/^API_VAULT_KEY=.*$/m,'API_VAULT_KEY='+snapshot.vaultKey);
  writeFileSync(config+'.migration',updated,{mode:0o600});renameSync(config+'.migration',config);
  service('start');await healthy(origin);
  return {...receipt,backup};
 }catch(error){
  try{service('stop');}catch{}
  if(installed)renameSync(data,join(backup,'failed-import'));
  if(moved)renameSync(join(backup,'data'),data);
  copyFileSync(join(backup,'server.env'),config);chmodSync(config,0o600);
  try{service('start');}catch{}
  rmSync(stage,{recursive:true,force:true});throw error;
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [action,file,argument]=process.argv.slice(2);
  if(action==='encrypt'){
   let input='';for await(const chunk of process.stdin)input+=chunk;
   const snapshot=JSON.parse(input),bytes=encryptSnapshot(snapshot,readFileSync(file));
   writeFileSync(argument,bytes,{mode:0o600,flag:'wx'});
   console.log(JSON.stringify({file:argument,sha256:digest(bytes),size:bytes.length,counts:validateSnapshot(snapshot)}));
  }else if(action==='import'){
   requireThat(process.getuid?.()===0,'Run the import with sudo.');
   const snapshot=decryptSnapshot(readFileSync(file),createPrivateKey(readFileSync('/etc/image-meow/migration-private.pem')),argument);
   const result=await installImport(snapshot,argument);console.log(JSON.stringify({ok:true,...result},null,2));
  }else throw new Error('Use encrypt PUBLIC_KEY OUTPUT_FILE, or import ENCRYPTED_FILE SHA256.');
 }catch{
  console.error('Migration failed. No keys or account details were printed. Verify the package checksum, recipient key and service configuration; check image-meow service status before retrying.');process.exitCode=1;
 }
}
