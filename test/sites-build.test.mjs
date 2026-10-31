import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cp,mkdir,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),exec=promisify(execFile);

test('Sites package keeps the same business schema without replaying the server historical backfill',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meow-sites-build-'));
 const server=new DatabaseSync(':memory:'),site=new DatabaseSync(':memory:');
 try{
  for(const path of ['public','drizzle','.openai'])await cp(join(root,path),join(dir,path),{recursive:true});
  await mkdir(join(dir,'worker'));await cp(join(root,'worker/core.js'),join(dir,'worker/core.js'));
  await exec(process.execPath,[join(root,'scripts/build.mjs')],{cwd:dir});
  const journal=JSON.parse(await readFile(join(root,'drizzle/meta/_journal.json'),'utf8'));
  assert.deepEqual(JSON.parse(await readFile(join(dir,'dist/drizzle/meta/_journal.json'),'utf8')),journal);
  for(const entry of journal.entries.filter(e=>e.idx<6)){
   const sql=await readFile(join(root,'drizzle',entry.tag+'.sql'),'utf8');
   assert.equal(await readFile(join(dir,'dist/drizzle',entry.tag+'.sql'),'utf8'),sql);
   server.exec(sql);site.exec(sql);
  }
  for(const db of [server,site])db.exec(`
   INSERT INTO users(id,email,created_at) VALUES('user','example@example.com',1);
   INSERT INTO tasks(id,user_id,idempotency_key,fingerprint,mode,prompt,model,size,count,status,created_at,updated_at)
   VALUES('task','user','key','hash','text','private prompt','model','1024x1024',1,'succeeded',1,1);
  `);
  const original=await readFile(join(root,'drizzle/0006_owner_activity.sql'),'utf8');
  const hosted=await readFile(join(dir,'dist/drizzle/0006_owner_activity.sql'),'utf8');
  assert.match(original,/INSERT INTO api_activity/);
  assert.doesNotMatch(hosted,/INSERT INTO api_activity/);
  assert.equal(hosted,await readFile(join(root,'drizzle/sites/0006_owner_activity.sql'),'utf8'));
  server.exec(original);site.exec(hosted);
  for(const entry of journal.entries.filter(e=>e.idx>6)){
   const original=await readFile(join(root,'drizzle',entry.tag+'.sql'),'utf8');
   assert.equal(await readFile(join(dir,'dist/drizzle',entry.tag+'.sql'),'utf8'),original);
   server.exec(original);site.exec(original);
  }
  const businessSchema=db=>db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name IN ('tasks','account_storage','tasks_result_sync','app_data_migrations') ORDER BY type,name").all();
  assert.deepEqual(businessSchema(site),businessSchema(server));
  const schema=db=>db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'api_activity%' ORDER BY type,name").all();
  assert.deepEqual(schema(site),schema(server));
  assert.equal(server.prepare('SELECT COUNT(*) AS n FROM api_activity').get().n,1);
  assert.equal(site.prepare('SELECT COUNT(*) AS n FROM api_activity').get().n,0);
  site.exec(`INSERT INTO api_activity(id,task_id,user_id,email,started_at,source,mode,model,requested_count,outcome,task_status,updated_at)
   VALUES('call','task','user','example@example.com',2,'live','text','model',1,'accepted','running',2);
   UPDATE tasks SET status='failed',updated_at=3 WHERE id='task';`);
  assert.equal(site.prepare("SELECT task_status FROM api_activity WHERE id='call'").get().task_status,'failed');
  assert(!(await readdir(join(dir,'dist/drizzle'))).includes('sites'));
  const worker=await readFile(join(dir,'dist/server/index.js'),'utf8');
  assert(worker.includes('/activity.js'));assert(worker.includes('2026.10.19.4'));
  assert(worker.includes('#updates-dialog .dialog-close:focus-visible'));
  const archive=join(dir,'deployment.tar.gz');
  await exec(process.execPath,[join(root,'scripts/package-sites.mjs'),archive],{cwd:dir});
  const {stdout:list}=await exec('tar',['-tzf',archive]);
  assert(list.includes('./drizzle/0006_owner_activity.sql'));
  assert(list.includes('./drizzle/0008_generated_results.sql'));
  assert(list.includes('./drizzle/0009_storage_quota_3gb.sql'));
  assert(list.includes('./dist/server/index.js'));assert(list.includes('./.openai/hosting.json'));
  assert(!list.includes('dist/drizzle/'));assert(!list.includes('worker/core.js'));
  const {stdout:packed}=await exec('tar',['-xOzf',archive,'./drizzle/0006_owner_activity.sql']);
  assert.equal(packed,hosted);
 }finally{server.close();site.close();await rm(dir,{recursive:true,force:true});}
});
