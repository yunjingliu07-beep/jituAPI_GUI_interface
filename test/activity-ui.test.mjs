import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountActivity} from '../public/activity.js';

// Minimal DOM surface: exercise the real async panel logic without a browser dependency.
class Element{
 constructor(){this.children=[];this.listeners={};this.value='';this.dataset={};this.attributes={};this.open=false;this._text='';}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this._text='';this.children=children;}
 setAttribute(key,value){this.attributes[key]=value;}
 addEventListener(event,handler){this.listeners[event]=handler;}
 close(){this.open=false;this.listeners.close?.();}
}
function setup(){
 const nodes=new Map(),tabs=['users','calls'].map(tab=>{const node=new Element();node.dataset.activityTab=tab;return node;});
 const doc={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},createElement(){return new Element();}};
 const original=globalThis.document;globalThis.document=doc;
 const node=id=>doc.getElementById('activity-'+id);node('dialog').querySelectorAll=()=>tabs;
 node('filter').reset=()=>{for(const id of ['email','from','to'])node(id).value='';};
 let user={role:'owner'},epoch=0;const requests=[];
 const panel=mountActivity({getUser:()=>user,getEpoch:()=>epoch,openDialog(){node('dialog').open=true;},api(path){return new Promise((resolve,reject)=>requests.push({path,resolve,reject}));}});
 return {node,tabs,panel,requests,logout(){user=null;epoch++;panel.reset();panel.updateIdentity();},close(){globalThis.document=original;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const users=(email='member@example.com')=>({totalUsers:51,total:51,nextOffset:50,users:[{id:'a'.repeat(36),email,role:'member',createdAt:1,taskCount:2,callCount:1,lastCallAt:2}]});

test('owner panel renders untrusted emails as text, paginates and drills into the exact account',async()=>{
 const a=setup();try{
  a.panel.updateIdentity();assert.equal(a.node('open').hidden,false);a.node('open').onclick();assert(a.node('dialog').open);
  const email='<img src=x onerror=alert(1)>@example.com';a.requests[0].resolve(users(email));await settle();
  const button=a.node('body').children[0].children[0].children[0];assert.equal(button.textContent,email);assert.equal(button.children.length,0);
  assert.equal(a.node('next').disabled,false);a.node('next').onclick();assert.match(a.requests[1].path,/offset=50/);a.requests[1].resolve({...users(email),nextOffset:null});await settle();
  a.node('body').children[0].children[0].children[0].onclick();assert.match(a.requests[2].path,/\/calls\?/);assert.match(a.requests[2].path,/userId=/);assert.match(a.requests[2].path,/offset=0/);
  a.requests[2].resolve({totalUsers:51,total:0,nextOffset:null,summary:{calls:0,tasks:0,activeUsers:0},calls:[]});await settle();assert.match(a.node('body').textContent,/没有符合条件/);
 }finally{a.close();}
});

test('logout or dialog close prevents a late response from restoring private account data',async()=>{
 const a=setup();try{
  a.node('open').onclick();a.logout();assert.equal(a.node('open').hidden,true);assert.equal(a.node('dialog').open,false);
  a.requests[0].resolve(users());await settle();assert.equal(a.node('body').children.length,0);assert.equal(a.node('summary').children.length,0);
 }finally{a.close();}
 const b=setup();try{
  b.node('open').onclick();b.node('dialog').close();b.requests[0].resolve(users());await settle();assert.equal(b.node('body').children.length,0);
 }finally{b.close();}
});
