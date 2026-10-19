import {cp,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const archive=process.argv[2];
if(!archive||!isAbsolute(archive))throw new Error('Usage: node scripts/package-sites.mjs /absolute/path/deployment.tar.gz (after npm run build)');
const stage=await mkdtemp(join(tmpdir(),'image-meow-package-'));
try{
 await mkdir(join(stage,'.openai'));await mkdir(join(stage,'dist/server'),{recursive:true});
 await cp('.openai/hosting.json',join(stage,'.openai/hosting.json'));
 await cp('dist/server/index.js',join(stage,'dist/server/index.js'));
 // Sites discovers hosted migrations at archive-root drizzle/, not dist/drizzle/.
 await cp('dist/drizzle',join(stage,'drizzle'),{recursive:true});
 await promisify(execFile)('tar',['-czf',archive,'-C',stage,'.']);
 console.log(`Packaged Worker and hosted migrations: ${archive}`);
}finally{await rm(stage,{recursive:true,force:true});}
