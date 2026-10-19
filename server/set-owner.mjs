import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from './database.mjs';

// Run only from the server console, as the service user; no web bootstrap endpoint exists.
export function setInitialOwner(db,rawEmail){
 const email=String(rawEmail||'').trim().toLowerCase();
 if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Provide the email of an existing site account.');
 const account=db.prepare('SELECT id,email,role FROM users WHERE email=?').get(email);
 if(!account)throw new Error('No registered account has that email. No permissions were changed.');
 const owner=db.prepare("SELECT id FROM users WHERE role='owner'").get();
 if(owner&&owner.id!==account.id)throw new Error('An owner already exists. This command cannot replace the owner.');
 if(!owner){const updated=db.prepare("UPDATE users SET role='owner' WHERE id=? AND NOT EXISTS(SELECT 1 FROM users WHERE role='owner') RETURNING id").get(account.id);if(!updated)throw new Error('An owner was configured concurrently. No permissions were changed.');}
 return {ok:true,email:account.email,role:'owner'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(!process.env.DATA_DIR)throw new Error('DATA_DIR is required.');
  const {raw}=openDatabase(process.env.DATA_DIR);
  try{console.log(JSON.stringify(setInitialOwner(raw,process.argv[2])));}finally{raw.close();}
 }catch(e){console.error(e.message);process.exitCode=1;}
}
