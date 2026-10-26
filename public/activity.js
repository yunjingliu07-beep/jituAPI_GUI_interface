const time=value=>value==null?'—':new Date(value*1000).toLocaleString('zh-CN',{timeZone:'Asia/Singapore',hour12:false});
const roles={owner:'站长',admin:'管理员',member:'成员'};
const outcomes={pending:'等待响应',accepted:'已受理',rejected:'已拒绝',unknown:'待核对',historical:'历史回填'};
const statuses={submitting:'正在提交',unknown:'待核对',queued:'排队中',running:'生成中',succeeded:'成功',failed:'失败',expired:'结果过期',timed_out:'生图超时'};

export function mountActivity({api,getUser,getEpoch,openDialog}){
 const $=id=>document.getElementById(id),dialog=$('activity-dialog');
 let tab='users',offset=0,next=null,request=0,loading=false,accountId=null;
 const owner=()=>getUser()?.role==='owner';
 function reset(){
  request++;loading=false;offset=0;next=null;tab='users';accountId=null;
  $('activity-filter').reset();$('activity-head').replaceChildren();$('activity-body').replaceChildren();$('activity-summary').replaceChildren();
  $('activity-error').textContent='';$('activity-page').textContent='';
  if(dialog.open)dialog.close();buttons();
 }
 function buttons(){
  $('activity-previous').disabled=loading||offset===0;$('activity-next').disabled=loading||next===null;
  $('activity-refresh').disabled=loading;
  for(const b of dialog.querySelectorAll('[data-activity-tab]')){b.disabled=loading;b.setAttribute('aria-pressed',String(b.dataset.activityTab===tab));}
  $('activity-date-label').textContent=tab==='users'?'按注册日期筛选':'按调用日期筛选';
 }
 function cell(row,value){const td=document.createElement('td');td.textContent=value??'—';row.append(td);return td;}
 function metric(label,value){const box=document.createElement('div'),number=document.createElement('strong'),title=document.createElement('span');number.textContent=value;title.textContent=label;box.append(number,title);$('activity-summary').append(box);}
 function render(data){
  $('activity-summary').replaceChildren();metric('注册账号总数',data.totalUsers);
  if(tab==='users')metric('符合筛选的账号',data.total);
  else{metric('实时调用次数',data.summary.calls);metric('涉及任务数（含历史）',data.summary.tasks);metric('涉及账号数',data.summary.activeUsers);}
  const head=$('activity-head'),body=$('activity-body');head.replaceChildren();body.replaceChildren();const tr=document.createElement('tr');
  const titles=tab==='users'?['邮箱','身份','注册时间','任务数（含历史）','实时调用次数','最近实时调用']:['邮箱','调用时间','模型 / 模式','申请张数','请求结果','任务最后状态','任务编号'];
  for(const title of titles){const th=document.createElement('th');th.scope='col';th.textContent=title;tr.append(th);}head.append(tr);
  for(const item of data[tab]){
   const row=document.createElement('tr');
   if(tab==='users'){
    const td=cell(row,'');const button=document.createElement('button');button.type='button';button.className='activity-email';button.textContent=item.email;button.title='查看此账号的调用记录';
    button.onclick=()=>{$('activity-email').value=item.email;accountId=item.id;tab='calls';offset=0;$('activity-from').value='';$('activity-to').value='';load();};td.append(button);
    for(const value of [roles[item.role]||item.role,time(item.createdAt),item.taskCount,item.callCount,time(item.lastCallAt)])cell(row,value);
   }else{
    cell(row,item.email);const date=cell(row,time(item.startedAt));
    if(item.source==='historical'){const note=document.createElement('small');note.textContent='历史任务创建时间';date.append(note);}
    cell(row,item.model+' / '+({text:'文生图',edit:'图生图',mask:'局部编辑'}[item.mode]||item.mode));cell(row,item.requestedCount);
    const result=cell(row,(outcomes[item.outcome]||item.outcome)+(item.httpStatus?' · HTTP '+item.httpStatus:''));
    if(item.respondedAt){const note=document.createElement('small');note.textContent='响应 '+time(item.respondedAt);result.append(note);}
    cell(row,statuses[item.taskStatus]||item.taskStatus);
    const id=cell(row,item.upstreamId||'未取得上游编号');const local=document.createElement('small');local.textContent='本站 '+item.taskId;id.append(local);
   }
   body.append(row);
  }
  if(!data[tab].length){const row=document.createElement('tr'),td=cell(row,'没有符合条件的记录。');td.colSpan=titles.length;td.className='activity-empty';body.append(row);}
  next=data.nextOffset;$('activity-page').textContent=data.total?`第 ${Math.floor(offset/50)+1} 页 · 共 ${data.total} 条`:'共 0 条';
 }
 async function load(){
  if(!owner())return;const token=++request,epoch=getEpoch();loading=true;next=null;buttons();
  $('activity-error').textContent='';$('activity-body').replaceChildren();$('activity-summary').replaceChildren();$('activity-page').textContent='正在读取…';
  const params=new URLSearchParams({offset:String(offset)});
  if(accountId)params.set('userId',accountId);
  for(const name of ['email','from','to']){const value=$('activity-'+name).value.trim();if(value)params.set(name,value);}
  try{
   const data=await api(`/api/admin/activity/${tab}?${params}`);
   if(token===request&&epoch===getEpoch()&&owner())render(data);
  }catch(e){if(token===request&&epoch===getEpoch()){$('activity-error').textContent=e.message;$('activity-page').textContent='查询未完成';}}
  finally{if(token===request){loading=false;buttons();}}
 }
 $('activity-open').onclick=()=>{if(!owner())return;openDialog('#activity-dialog');load();};
 $('activity-filter').onsubmit=e=>{e.preventDefault();accountId=null;offset=0;load();};
 $('activity-email').addEventListener('input',()=>{accountId=null;});
 $('activity-refresh').onclick=()=>load();
 $('activity-clear').onclick=()=>{$('activity-filter').reset();accountId=null;offset=0;load();};
 $('activity-previous').onclick=()=>{if(loading)return;offset=Math.max(0,offset-50);load();};
 $('activity-next').onclick=()=>{if(loading||next===null)return;offset=next;load();};
 for(const button of dialog.querySelectorAll('[data-activity-tab]'))button.onclick=()=>{if(loading)return;tab=button.dataset.activityTab;offset=0;load();};
 dialog.addEventListener('close',()=>{request++;loading=false;$('activity-head').replaceChildren();$('activity-body').replaceChildren();$('activity-summary').replaceChildren();$('activity-error').textContent='';buttons();});
 return {reset,updateIdentity(){const visible=owner();$('activity-open').hidden=!visible;if(!visible)reset();}};
}
