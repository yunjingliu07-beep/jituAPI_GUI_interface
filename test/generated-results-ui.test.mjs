import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const stored={id:'saved',conversationId:'chat',upstreamId:'upstream',prompt:'cat',model:'model',size:'1024x1024',n:1,status:'succeeded',createdAt:1,resultCount:1,resultsSaved:true,savedImages:[{index:0,size:1,type:'image/png'}]};
test('saved images and old thumbnails load without a selected API; unsaved expired images do not',async()=>{
 const calls=[],queries=[],images=new Map(),tasks=new Map([[stored.id,stored]]),runtimes=new Map();
 const context=vm.createContext({apiKey:'',user:{},activeId:'chat',epoch:1,images,tasks,Date,URL:{createObjectURL:()=> 'blob:stored'},runtime:id=>{if(!runtimes.has(id))runtimes.set(id,{});return runtimes.get(id);},threadTasks:()=>[...tasks.values()],queryTask:id=>queries.push(id),startPolling(){},updateTurn(){},renderSidebar(){},api:async path=>{calls.push(path);return new Blob(['image'],{type:'image/png'});}});
 vm.runInContext(extract('function hasSavedImage','function expireLocalTasks')+extract('function ensureRecentThumbnails','function scrollBottom'),context);
 vm.runInContext('ensureActiveResults()',context);assert.deepEqual(queries,['saved']);
 await vm.runInContext('loadImage(tasks.get("saved"),0)',context);assert.deepEqual(calls,['/api/tasks/saved/images/0']);assert.equal(images.get('saved:0').url,'blob:stored');
 images.clear();tasks.set('old',{...stored,id:'old',savedImages:[],resultsSaved:false});calls.length=0;
 vm.runInContext('ensureRecentThumbnails()',context);await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['/api/tasks/saved/images/0']);
});
class Element{
 constructor(){this.style={};this.classList={add(){}};this.children=[];this.nodes=new Map();this.innerHTML='';this.listeners={};}
 append(...children){this.children.push(...children);}
 setAttribute(){}
 addEventListener(type,listener){this.listeners[type]=listener;}
 querySelector(selector){
  if(selector.startsWith('[data-')&&!this.innerHTML.includes(selector.slice(1,-1))&&![...this.nodes.values()].some(n=>n.innerHTML.includes(selector.slice(1,-1))))return null;
  if(!this.nodes.has(selector))this.nodes.set(selector,new Element());return this.nodes.get(selector);
 }
}
test('saved results show personal-space retention; partial failures show the saved count and a retry action',()=>{
 const loaded=[],article=new Element();
 const context=vm.createContext({apiKey:'',apiProfiles:[],images:new Map(),document:{createElement:()=>new Element()},runtime:()=>({}),icon:()=>'',modelName:s=>s,running:()=>false,Date,loadImage:(task,index)=>loaded.push(index),hasSavedImage:(task,index)=>task.savedImages.some(f=>f.index===index),continueConversation(){}});
 vm.runInContext(source.slice(source.indexOf('const esc='),source.indexOf('\n',source.indexOf('const esc=')))+extract('function renderTurn','function download('),context);
 context.task=stored;context.article=article;vm.runInContext('renderTurn(task,article)',context);
 const saved=article.querySelector('.turn-response');assert.match(saved.innerHTML,/已保存到个人空间/);assert(!saved.innerHTML.includes('12 小时'));assert.equal(article.querySelector('[data-save-retry]'),null);assert.deepEqual(loaded,[0]);
 context.task={...stored,resultCount:2,n:2,resultsSaved:false,saveError:'<img src=x onerror=alert(1)>'};context.article=new Element();vm.runInContext('renderTurn(task,article)',context);
 const partial=context.article.querySelector('.turn-response');assert.match(partial.innerHTML,/已保存 1 \/ 2 张/);assert.match(partial.innerHTML,/&lt;img/);assert(!partial.innerHTML.includes('<img src=x'));assert(context.article.querySelector('[data-save-retry]').listeners.click);
});
