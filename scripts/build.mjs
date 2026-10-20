import {readFile,mkdir,writeFile,cp,rm} from 'node:fs/promises';
const assets={};
for(const [name,type] of [['index.html','text/html; charset=utf-8'],['style.css','text/css; charset=utf-8'],['app.js','application/javascript; charset=utf-8'],['parameters.js','application/javascript; charset=utf-8'],['activity.js','application/javascript; charset=utf-8'],['brand-mark.svg','image/svg+xml']]) assets['/'+name]={type,content:await readFile('public/'+name,'utf8')};
for(const name of ['cathead.png','cathead+logo.png']) assets['/'+name]={type:'image/png',encoding:'base64',content:(await readFile('public/'+name)).toString('base64')};
assets['/favicon.svg']=assets['/brand-mark.svg'];
const core=await readFile('worker/core.js','utf8');
await mkdir('worker',{recursive:true});
const bundled=core+'\nconst assets='+JSON.stringify(assets)+';\nfor(const asset of Object.values(assets))if(asset.encoding===\"base64\")asset.content=Uint8Array.from(atob(asset.content),c=>c.charCodeAt(0));\nexport default createHandler(assets);\n';
await writeFile('worker/index.js',bundled);
await rm('dist',{recursive:true,force:true});await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});
await writeFile('dist/server/index.js',bundled);await cp('.openai/hosting.json','dist/.openai/hosting.json');await cp('drizzle','dist/drizzle',{recursive:true});
// Preserve the already-applied Ubuntu migration. Hosted D1 migrations are schema-only.
await cp('drizzle/sites/0006_owner_activity.sql','dist/drizzle/0006_owner_activity.sql');
await rm('dist/drizzle/sites',{recursive:true,force:true});
console.log('Built Worker and embedded assets.');
