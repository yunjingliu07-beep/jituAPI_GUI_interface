import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const exec=promisify(execFile);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";

async function fixture(scenario,active=true){
 const root=await mkdtemp(join(tmpdir(),'meow-update-'));
 const repo=join(root,'repo'),bin=join(root,'bin');
 for(const path of [join(repo,'deploy/ubuntu'),bin,join(root,'data'),join(root,'config'),join(root,'backups')])await mkdir(path,{recursive:true});
 await writeFile(join(root,'data/studio.sqlite'),'fixture database');
 await writeFile(join(root,'config/server.env'),`DATA_DIR=${root}/data\nPUBLIC_ORIGIN=https://imagemeow.top\n`);
 await writeFile(join(root,'service'),active?'active':'inactive');
 await writeFile(join(root,'trace'),'');
 let source=await readFile(new URL('../deploy/ubuntu/update.sh',import.meta.url),'utf8');
 // Isolate the unchanged update flow from root privileges and production paths.
 source=source.replace(/^\[\[ \$EUID -eq 0 \]\].*$/m,'# Unprivileged fixture.');
 for(const [from,to] of [['/opt/image-meow',repo],['/var/lib/image-meow',join(root,'data')],['/etc/image-meow',join(root,'config')],['/var/backups',join(root,'backups')],['/run/lock/image-meow-update.lock',join(root,'update.lock')],['/usr/bin/node',join(bin,'node')]])source=source.replaceAll(from,to);
 const script=join(repo,'deploy/ubuntu/update.sh');await writeFile(script,source);
 const mock=`#!/usr/bin/env bash
set -eu
tool=\${0##*/}
printf '%s %s\\n' "$tool" "$*" >> "$TEST_ROOT/trace"
case "$tool" in
 node)
   [[ "$TEST_SCENARIO" != node-failure ]] || exit 51
   exec ${quote(process.execPath)} "$@" ;;
 flock) [[ "$TEST_SCENARIO" != locked ]] ;;
 systemctl)
   case "$1" in
     is-active) [[ "$(cat "$TEST_ROOT/service")" == active ]] ;;
     stop) printf inactive > "$TEST_ROOT/service" ;;
     start)
       if [[ "$TEST_SCENARIO" == start-failure ]]; then exit 52; fi
       printf active > "$TEST_ROOT/service" ;;
   esac ;;
 cp)
   [[ "$TEST_SCENARIO" != backup-failure ]] || exit 53
   if [[ "$TEST_SCENARIO" == hangup ]]; then kill -HUP "$PPID"; exit 0; fi
   exec /bin/cp "$@" ;;
 git) printf '%040d\\n' 1 ;;
 runuser) [[ "$TEST_SCENARIO" != migration-failure ]] ;;
 curl)
   [[ "$TEST_SCENARIO" != health-failure ]] || exit 54
   printf '{"ok":true}' ;;
esac
`;
 for(const name of ['node','flock','systemctl','cp','git','runuser','curl'])await writeFile(join(bin,name),mock,{mode:0o755});
 return {root,async run(){
  let result;
  try{const r=await exec('bash',[script],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`,TEST_ROOT:root,TEST_SCENARIO:scenario},timeout:5000});result={code:0,...r};}
  catch(error){result={code:error.code,stdout:error.stdout,stderr:error.stderr};}
  return {...result,state:await readFile(join(root,'service'),'utf8'),trace:await readFile(join(root,'trace'),'utf8')};
 },close:()=>rm(root,{recursive:true,force:true})};
}

test('manual updater restores a previously running service after interrupted backup or migration',async t=>{
 for(const scenario of ['backup-failure','migration-failure','hangup'])await t.test(scenario,async()=>{
  const f=await fixture(scenario);try{
   const r=await f.run();assert.notEqual(r.code,0);assert.equal(r.state,'active',r.stderr);
   assert.match(r.stderr,/Update interrupted/);assert.match(r.stderr,/Attempting to restart/);
   assert.doesNotMatch(r.stdout,/Updated successfully/);
   assert(r.trace.indexOf('systemctl stop')<r.trace.indexOf('systemctl start'));
  }finally{await f.close();}
 });
});

test('manual updater checks the migration runtime and lock before stopping the service',async t=>{
 for(const scenario of ['node-failure','locked'])await t.test(scenario,async()=>{
  const f=await fixture(scenario);try{
   const r=await f.run();assert.notEqual(r.code,0);assert.equal(r.state,'active');
   assert.doesNotMatch(r.trace,/systemctl stop|systemctl start/);
  }finally{await f.close();}
 });
});

test('manual updater preserves failed status and reports recovery failure without looping',async()=>{
 const f=await fixture('start-failure');try{
  const r=await f.run();assert.notEqual(r.code,0);assert.equal(r.state,'inactive');
  assert.match(r.stderr,/Service could not be started/);
  assert.equal(r.trace.match(/systemctl start/g)?.length,2);
 }finally{await f.close();}
});

test('manual updater does not start a previously inactive service when backup fails',async()=>{
 const f=await fixture('backup-failure',false);try{
  const r=await f.run();assert.notEqual(r.code,0);assert.equal(r.state,'inactive');
  assert.doesNotMatch(r.trace,/systemctl start/);
 }finally{await f.close();}
});

test('manual updater backs up before migrating and reports success only after health check',async()=>{
 const f=await fixture('success');try{
  const r=await f.run();assert.equal(r.code,0,r.stderr);assert.equal(r.state,'active');
  assert.match(r.stdout,/\[1\/5\].*\[2\/5\].*\[3\/5\].*\[4\/5\].*\[5\/5\].*Updated successfully/s);
  assert(r.trace.indexOf('cp -a')<r.trace.indexOf('runuser -u'));
  assert(r.trace.indexOf('runuser -u')<r.trace.indexOf('systemctl start'));
  assert(r.trace.indexOf('systemctl start')<r.trace.indexOf('curl --fail'));
 }finally{await f.close();}
});

test('failed health check leaves the running service up and fails the update',async()=>{
 const f=await fixture('health-failure');try{
  const r=await f.run();assert.notEqual(r.code,0);assert.equal(r.state,'active');
  assert.match(r.stderr,/checking service health/);assert.equal(r.trace.match(/systemctl start/g)?.length,1);
 }finally{await f.close();}
});
