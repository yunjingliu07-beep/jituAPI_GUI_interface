import {requestedSize} from '/parameters.js';
const paths={info:'M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',panel:'M4 4h16v16H4ZM9 4v16',plus:'M12 5v14M5 12h14',search:'M20 20l-5-5M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0',key:'M14 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM10 14l-7 7m3-3 2 2m0-4 2 2',more:'M5 12h.01M12 12h.01M19 12h.01',up:'m7 11 5-5 5 5M12 6v13',chevron:'m8 10 4 4 4-4',ratio:'M4 5h16v14H4ZM8 2v6M2 9h6',image:'M3 3h18v18H3Zm0 13 6-6 6 7 3-3 3 4M15 7h.01',stack:'m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',check:'m5 12 4 4L19 6',download:'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',copy:'M8 8h13v13H8ZM16 8V3H3v13h5',refresh:'M20 8a8 8 0 1 0 0 8M20 3v5h-5',edit:'m14 4 6 6M3 21l5-1L21 7l-5-5L3 15Z',close:'m6 6 12 12M6 18 18 6'};
const icon=(name)=>name==='cat'?'<img class="brand-logo" src="/brand-mark.svg" alt="">':`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.image}"/></svg>`;
function hydrate(root=document){root.querySelectorAll('[data-icon]').forEach(e=>e.innerHTML=icon(e.dataset.icon));}hydrate();
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defaults=()=>({model:'gpt-image-2.5-flare',ratio:'1:1',customRatioWidth:16,customRatioHeight:9,resolution:1024,count:1,mode:'text'});
const statusNames={submitting:'正在提交',unknown:'提交状态待核对',queued:'排队中',running:'正在生成',succeeded:'已完成',failed:'生成失败',expired:'结果已过期'};
const running=t=>['submitting','unknown','queued','running'].includes(t.status);
let user=null,apiKey='',authMode='login',activeId=null,epoch=0,openSetting=null,pollTimer=null,polling=false,toastTimer=null,searchTimer=null;
let threads=new Map(),tasks=new Map(),runtimes=new Map(),pending=new Map(),images=new Map(),querying=new Set();
let inputSnapshots=new Map();
let apiProfiles=[],selectedApiId=null,menuConversationId=null,renameTargetId=null,deleteTargetId=null,deleteAPIId=null;
let deletedConversationIds=new Set(),guideAcknowledgedThisVisit=false,guideAfterAPI=false;
let models=['gpt-image-2.5-flare','gpt-image-1k-2k-4k-th','gpt-image-2.5-sunburst','gpt-image-2','gpt-image-2.5'];
const current=()=>threads.get(activeId);
const runtime=id=>{if(!runtimes.has(id))runtimes.set(id,{});return runtimes.get(id)};
const modelName=m=>m==='gpt-image-2.5-flare'?'GPT Image 2.5 Flare':m;
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4500)}
function openDialog(id){const d=$(id);if(!d.open)d.showModal()}
function closeDialog(id){$(id).close()}
$$('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$$('dialog').forEach(d=>d.addEventListener('click',e=>{const r=d.getBoundingClientRect();if(d.id==='help-dialog'&&!hasSeenGuide())return;if(e.target===d&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))d.close()}));
function newThread(){const id=crypto.randomUUID();threads.set(id,{id,title:'新的生图会话',settings:defaults(),draft:'',files:[],fileURLs:[],mask:null,maskURL:null,createdAt:Date.now()/1000,updatedAt:Date.now()/1000,local:true,pinned:false});return id}
function clearImageCache(){images.forEach(v=>{if(v.url)URL.revokeObjectURL(v.url)});images.clear();$('#lightbox').close();$('#lightbox-image').removeAttribute('src')}
function resetWorkspace(){epoch++;storageState=null;updateDialogContext=null;storageDialogContext=null;for(const id of ['#updates-dialog','#storage-notice-dialog'])if($(id).open)$(id).close();renderStorage();guideAcknowledgedThisVisit=false;$('#key-form').reset();$('#api-key').type='password';$('#toggle-key').textContent='显示';for(const id of ['#key-dialog','#delete-api-dialog','#rename-dialog','#delete-conversation-dialog'])if($(id).open)$(id).close();apiProfiles=[];selectedApiId=null;apiKey='';deletedConversationIds.clear();closeConversationMenu();clearTimeout(pollTimer);pollTimer=null;polling=false;querying=new Set();threads.forEach(t=>{t.fileURLs.forEach(URL.revokeObjectURL);if(t.maskURL)URL.revokeObjectURL(t.maskURL)});inputSnapshots.clear();threads=new Map();tasks=new Map();runtimes=new Map();pending=new Map();clearImageCache();activeId=newThread();$('#prompt').value='';$('#mask-file').value='';render();renderAPIProfiles()}
async function api(path,opts={}){
 const requestEpoch=epoch;const headers={...opts.headers};const profileId=opts.profileId||selectedApiId;if(profileId)headers['X-API-Profile']=profileId;else if(apiKey&&!apiKey.startsWith('profile:'))headers['X-Jitu-Key']=apiKey;const {profileId:_profileId,...requestOptions}=opts;opts=requestOptions;
 if(opts.body&&!(opts.body instanceof FormData)){headers['Content-Type']='application/json';opts={...opts,body:JSON.stringify(opts.body)}}
 let response;try{response=await fetch(path,{...opts,headers,credentials:'same-origin'})}catch{const e=new Error('网络连接中断，请检查网络后恢复原提交或再次查询。');e.status=0;throw e}
 if(opts.blob&&response.ok)return response.blob();
 let data;try{data=await response.json()}catch{const e=new Error('服务暂时没有返回可读取的结果，请稍后核对原任务。');e.status=response.status>=400?response.status:502;throw e}
 if(!response.ok){if(response.status===401&&!path.includes('/auth/')&&requestEpoch===epoch){user=null;apiKey='';resetWorkspace();updateIdentity();openDialog('#auth-dialog')}
 const e=new Error(data.error||'操作未完成，请稍后重试。');e.status=response.status;e.errorInfo=data.errorInfo;throw e}return data;
}
function requireUser(){if(!user){openDialog('#auth-dialog');return false}return true}
function requireKey(){if(!requireUser())return false;if(!hasSeenGuide()){openGuide(false);return false}if(!apiKey){openDialog('#key-dialog');return false}return true}
function updateIdentity(){
 $('#account-name').textContent=user?.email.split('@')[0]||'登录 image meow';$('#account-sub').textContent=user?.email||'开启你的灵感工作室';$('#avatar').textContent=user?user.email[0].toUpperCase():'M';$('#account-email').textContent=user?.email||'';
 $('#current-password-field').hidden=!user?.hasPassword;$('#current-password').required=!!user?.hasPassword;$('#new-password-label').textContent=user?.hasPassword?'设置新密码':'设置登录密码';
 $('#connection-label').textContent=apiProfiles.find(p=>p.id===selectedApiId)?.name||'连接 API';$('#switch-api').title=selectedApiId?'当前 API：'+(apiProfiles.find(p=>p.id===selectedApiId)?.name||'已选择'):'添加或切换 API';$('#header-key').classList.toggle('connected',!!apiKey);renderSidebar();updateComposerState();
}
$('#account-open').onclick=()=>{if(user)refreshStorage();openDialog(user?'#account-dialog':'#auth-dialog')};$('#switch-api').onclick=$('#header-key').onclick=()=>{if(requireUser()){renderAPIProfiles();openDialog('#key-dialog')}};$('#help-open').onclick=()=>openGuide(false);
let announcementsReady=false;
let updateFeed=null,storageState=null,storageBusy=false,updateDialogContext=null,storageDialogContext=null;
const seenUpdatesThisVisit=new Set(),seenNoticesThisVisit=new Set();
const releaseOwner=()=>user?.email||'anonymous';
const releaseKey=()=>updateFeed?`${releaseOwner()}:${updateFeed.current.version}`:'';
function formatStorage(bytes){if(bytes<1000000)return (bytes/1000).toFixed(bytes<1000?1:0)+' KB';if(bytes<1000000000)return (bytes/1000000).toFixed(1)+' MB';return (bytes/1000000000).toFixed(2)+' GB';}
function renderStorage(){
 const s=storageState;$('#storage-usage').textContent=user?(s?`${formatStorage(s.usedBytes)} / 1 GB`:'正在读取…'):'登录后查看';
 $('#storage-progress').value=s?Math.min(s.usedBytes,s.limitBytes):0;$('#storage-progress').max=s?.limitBytes||1000000000;
 $('#storage-status').textContent=s?.cleanupError||'聊天、参考图和遮罩共用 1 GB。空间不足时按创建时间清理最早会话，包括已置顶的会话；正在生成的会话暂不清理。清理后无法恢复，请及时下载重要图片。';
 $('#storage-banner').hidden=!user||!(s?.notice||s?.cleanupError);
 $('#storage-banner-text').textContent=s?.notice?`空间整理提醒：已自动移除 ${s.notice.conversations} 段最早的聊天及其上传素材。${s.pendingCleanup?'部分文件仍待清理。':''}`:s?.cleanupError||'';
}
async function refreshStorage(syncHistory=true){
 if(!user||storageBusy)return;storageBusy=true;const token=epoch;
 try{const previous=storageState?.notice?.revision;const d=await api('/api/storage');if(token!==epoch)return;storageState=d;renderStorage();if(syncHistory&&d.notice&&d.notice.revision!==previous)await loadHistory();queueAnnouncements();}
 catch(e){if(token===epoch&&e.status!==429){$('#storage-status').textContent=e.message;}}
 finally{storageBusy=false;}
}
function showUpdates(){
 if(!updateFeed)return;const holder=$('#updates-list');holder.replaceChildren();
 for(const release of updateFeed.releases){const section=document.createElement('section');section.className='release-entry';const label=document.createElement('p');label.className='eyebrow';label.textContent=`${release.date} · ${release.version}`;const title=document.createElement('h3');title.textContent=release.title;const list=document.createElement('ul');for(const change of release.changes){const item=document.createElement('li');item.textContent=change;list.append(item);}section.append(label,title,list);holder.append(section);}
 updateDialogContext={owner:releaseOwner(),version:updateFeed.current.version,epoch};openDialog('#updates-dialog');
}
function queueAnnouncements(){
 if(!announcementsReady||document.querySelector('dialog[open]'))return;
 if(updateFeed){let seen=user?.lastSeenRelease===updateFeed.current.version;
  if(!user){try{seen=localStorage.getItem('image-meow-release-seen')===updateFeed.current.version;}catch{}}
  if(!seen&&!seenUpdatesThisVisit.has(releaseKey())){showUpdates();return;}
 }
 if(user&&storageState?.notice){const key=`${user.email}:${storageState.notice.revision}`;if(!seenNoticesThisVisit.has(key))showStorageNotice();}
}
function showStorageNotice(){
 const notice=storageState?.notice;if(!user||!notice)return;
 $('#storage-notice-content').textContent=`你的聊天与上传素材已触及 1 GB 空间上限，系统已自动移除最早的 ${notice.conversations} 段聊天（含 ${notice.tasks} 条创作记录）及其参考图、遮罩。${storageState.pendingCleanup?'部分文件仍在等待清理，请稍后再提交。':''}清理后无法恢复；账号和 API 配置会保留。`;
 storageDialogContext={owner:user.email,revision:notice.revision,epoch};openDialog('#storage-notice-dialog');
}
$('#updates-open').onclick=async()=>{if(!updateFeed){try{updateFeed=await api('/api/updates');}catch(e){toast(e.message);return;}}showUpdates();};
$('#storage-notice-open').onclick=()=>{if(storageState?.notice)showStorageNotice();else if(user)openDialog('#account-dialog');};
$('#storage-refresh').onclick=()=>refreshStorage();
$('#updates-dialog').addEventListener('close',async()=>{
 const context=updateDialogContext;updateDialogContext=null;if(!context)return;
 seenUpdatesThisVisit.add(`${context.owner}:${context.version}`);
 if(context.epoch!==epoch||context.owner!==releaseOwner())return;
 if(user){try{await api('/api/updates/seen',{method:'POST',body:{version:context.version}});if(context.epoch===epoch&&context.owner===releaseOwner())user.lastSeenRelease=context.version;}catch(e){toast('更新阅读状态暂未保存，下次打开时可能再次提示。');}}
 else{try{localStorage.setItem('image-meow-release-seen',context.version);}catch{}}
 queueAnnouncements();
});
$('#storage-notice-dialog').addEventListener('close',async()=>{
 const context=storageDialogContext;storageDialogContext=null;if(!context)return;seenNoticesThisVisit.add(`${context.owner}:${context.revision}`);
 if(context.epoch!==epoch||context.owner!==user?.email)return;
 try{await api('/api/storage/ack',{method:'POST',body:{revision:context.revision}});if(context.epoch===epoch&&storageState?.notice?.revision===context.revision){storageState.notice=null;renderStorage();}}catch{toast('清理通知的阅读状态暂未保存，下次打开时会再次提醒。');}queueAnnouncements();
});
$$('dialog').forEach(d=>d.addEventListener('close',()=>setTimeout(queueAnnouncements,0)));
setInterval(()=>{if(user&&document.visibilityState==='visible')refreshStorage();},60000);
document.addEventListener('visibilitychange',()=>{if(user&&document.visibilityState==='visible')refreshStorage();});
let authConfig={emailCodeEnabled:false},codeSending=false;
const codeCooldowns=new Map();
const emailCodeKey=()=>$('#auth-email').value.trim().toLowerCase();
function updateCodeButton(){
 const left=Math.max(0,Math.ceil(((codeCooldowns.get(emailCodeKey())||0)-Date.now())/1000));
 $('#send-auth-code').disabled=codeSending||left>0||!authConfig.emailCodeEnabled;
 $('#send-auth-code').textContent=codeSending?'正在发送…':left>0?`${left} 秒后重发`:'发送验证码';
}
function selectAuth(value){
 authMode=value;const verifying=value!=='login';
 $$('[data-auth]').forEach(b=>{b.classList.toggle('active',b.dataset.auth===value);b.setAttribute('aria-selected',b.dataset.auth===value);});
 $('#auth-title').textContent=value==='reset'?'找回你的账号':'登录，遇见你的灵感';
 $('#register-confirm-field').hidden=!verifying;$('#auth-confirm-password').required=verifying;
 $('#auth-password').minLength=verifying?10:1;$('#auth-password').autocomplete=verifying?'new-password':'current-password';
 $('#auth-password').placeholder=verifying?'设置至少 10 位密码':'输入你的密码';
 $('#auth-submit').textContent=value==='register'?'验证邮箱并注册':value==='reset'?'验证并重设密码':'登录';
 $('#auth-submit').disabled=verifying&&!authConfig.emailCodeEnabled;
 $('#auth-helper').textContent=verifying?'密码至少 10 位；请使用最新邮件中的验证码。':'首次使用请切换到「注册账号」。';
 $('#auth-code-field').hidden=!verifying;$('#auth-code').required=verifying;
 $('#forgot-password').hidden=value!=='login';
 $('#auth-service-note').textContent=authConfig.emailCodeEnabled?'注册和找回密码需验证邮箱；验证码 10 分钟内有效。':'邮件服务尚未就绪，暂时无法注册或找回密码。已有账号可使用密码登录。';
 for(const id of ['#auth-error','#auth-code-status'])$(id).textContent='';
 for(const id of ['#auth-password','#auth-confirm-password','#auth-code'])$(id).value='';
 updateCodeButton();
}
$$('[data-auth]').forEach(b=>b.onclick=()=>selectAuth(b.dataset.auth));
$('#forgot-password').onclick=()=>selectAuth('reset');selectAuth('login');
setInterval(updateCodeButton,1000);
$('#auth-email').addEventListener('input',()=>{$('#auth-code').value='';$('#auth-code-status').textContent='';updateCodeButton()});
$('#send-auth-code').onclick=async()=>{
 if(!$('#auth-email').reportValidity())return;
 const email=emailCodeKey(),purpose=authMode;
 if(!['register','reset'].includes(purpose)||codeSending)return;
 codeSending=true;$('#auth-error').textContent='';updateCodeButton();
 try{
  const d=await api('/api/auth/code/send',{method:'POST',body:{email,purpose}});
  codeCooldowns.set(email,Date.now()+d.retryAfter*1000);
  if(email===emailCodeKey()&&purpose===authMode){$('#auth-code-status').textContent=d.message;$('#auth-code').focus();}
 }catch(e){$('#auth-error').textContent=e.message;}finally{codeSending=false;updateCodeButton();}
};
$('#auth-form').onsubmit=async e=>{
 e.preventDefault();const mode=authMode;$('#auth-error').textContent='';
 if(mode!=='login'&&$('#auth-password').value!==$('#auth-confirm-password').value){$('#auth-error').textContent='两次输入的密码不一致。';return;}
 $('#auth-submit').disabled=true;
 try{
  const body={email:$('#auth-email').value,password:$('#auth-password').value,confirmPassword:$('#auth-confirm-password').value,code:$('#auth-code').value};
  const d=await api(`/api/auth/password/${mode}`,{method:'POST',body});
  if(mode==='reset'){
   user=null;resetWorkspace();updateIdentity();selectAuth('login');$('#auth-helper').textContent='密码已重设，请使用新密码登录。';toast('密码已重设，所有设备需要重新登录。');return;
  }
  user=d.user;for(const id of ['#auth-password','#auth-confirm-password','#auth-code'])$(id).value='';
  closeDialog('#auth-dialog');updateIdentity();await afterSignIn();toast(mode==='register'?'注册成功，欢迎来到你的灵感工作室。':'登录成功，欢迎回来。');
 }catch(e){$('#auth-error').textContent=e.message;}finally{$('#auth-submit').disabled=authMode!=='login'&&!authConfig.emailCodeEnabled;}
};
$('#set-password-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;$('#account-error').textContent='';if($('#new-password').value!==$('#confirm-password').value){$('#account-error').textContent='两次输入的密码不一致。';return;}button.disabled=true;try{const d=await api('/api/auth/password/set',{method:'POST',body:{password:$('#new-password').value,confirmPassword:$('#confirm-password').value,currentPassword:$('#current-password').value}});user=d.user;e.target.reset();updateIdentity();closeDialog('#account-dialog');toast('密码已保存，其他设备需要使用新密码重新登录。');if(!apiKey)openDialog('#key-dialog');}catch(e){$('#account-error').textContent=e.message;}finally{button.disabled=false;}};
$('#logout').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST',body:{}});user=null;apiKey='';$('#key-form').reset();closeDialog('#account-dialog');resetWorkspace();updateIdentity();toast('已退出登录，当前页面的账号信息已清除。')}catch(e){toast(e.message)}};
$('#toggle-key').onclick=()=>{const show=$('#api-key').type==='password';$('#api-key').type=show?'text':'password';$('#toggle-key').textContent=show?'隐藏':'显示'};
function hasSeenGuide(){if(user)return !!user.onboardingCompleted;try{return guideAcknowledgedThisVisit||localStorage.getItem('image-meow-guide-v1')==='seen'}catch{return guideAcknowledgedThisVisit;}}
function openGuide(afterAPI=false){guideAfterAPI=afterAPI;$('#guide-error').textContent='';$('#help-dialog .dialog-close').hidden=!hasSeenGuide();openDialog('#help-dialog');}
async function finishGuide(){if(user){await api('/api/onboarding/complete',{method:'POST',body:{}});user.onboardingCompleted=true;}guideAcknowledgedThisVisit=true;try{localStorage.setItem('image-meow-guide-v1','seen')}catch{}}
$('#guide-continue').onclick=async e=>{e.currentTarget.disabled=true;try{await finishGuide();closeDialog('#help-dialog');if(guideAfterAPI&&!apiKey){renderAPIProfiles();openDialog('#key-dialog')}guideAfterAPI=false;}catch(error){$('#guide-error').textContent=error.message}finally{e.target.disabled=false}};
$('#help-dialog').addEventListener('cancel',e=>{if(!hasSeenGuide())e.preventDefault()});
async function afterSignIn(){announcementsReady=false;try{await loadAPIProfiles();await refreshStorage(false);await loadHistory();if(!user.onboardingCompleted&&guideAcknowledgedThisVisit)await finishGuide();if(!hasSeenGuide())openGuide(!apiKey);else if(!apiKey){renderAPIProfiles();openDialog('#key-dialog')}}finally{announcementsReady=true;queueAnnouncements();}}
async function loadAPIProfiles(){if(!user)return;const token=epoch;const data=await api('/api/api-profiles');if(token!==epoch)return;apiProfiles=data.profiles;selectedApiId=data.selectedId;apiKey=selectedApiId?'profile:'+selectedApiId:'';runtimes.forEach(r=>{r.paused=false;r.failures=0;r.nextQueryAt=0});renderAPIProfiles();updateIdentity();startPolling();ensureActiveResults();ensureRecentThumbnails();}
function renderAPIProfiles(){const holder=$('#api-profile-list');holder.replaceChildren();if(!apiProfiles.length){const p=document.createElement('p');p.className='api-list-empty';p.textContent='还没有保存的 API，请在下方添加第一把密钥。';holder.append(p);return}for(const profile of apiProfiles){const row=document.createElement('div');row.className='api-profile-row'+(selectedApiId===profile.id?' selected':'');const use=document.createElement('button');use.type='button';use.className='api-use';use.setAttribute('aria-label','使用 API：'+profile.name);use.innerHTML=icon(selectedApiId===profile.id?'check':'key')+`<span>${esc(profile.name)}<small>${esc(profile.keyHint)}${selectedApiId===profile.id?' · 当前使用':''}</small></span>`;use.onclick=async()=>{use.disabled=true;try{await api('/api/api-profiles/'+profile.id,{method:'POST',body:{}});selectedApiId=profile.id;apiKey='profile:'+profile.id;runtimes.forEach(r=>{r.paused=false;r.failures=0;r.nextQueryAt=0});updateIdentity();renderAPIProfiles();closeDialog('#key-dialog');startPolling();ensureActiveResults();toast('已切换到 '+profile.name)}catch(e){$('#key-error').textContent=e.message}finally{use.disabled=false}};const remove=document.createElement('button');remove.type='button';remove.className='api-remove';remove.setAttribute('aria-label','移除 API：'+profile.name);remove.innerHTML=icon('close');remove.onclick=()=>{deleteAPIId=profile.id;$('#delete-api-name').textContent=profile.name;$('#delete-api-error').textContent='';openDialog('#delete-api-dialog')};row.append(use,remove);holder.append(row)}}
$('#key-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('#key-error').textContent='';try{const d=await api('/api/api-profiles',{method:'POST',body:{name:$('#api-name').value.trim(),key:$('#api-key').value.trim()}});$('#api-key').value='';$('#api-key').type='password';$('#toggle-key').textContent='显示';$('#api-name').value='';await loadAPIProfiles();selectedApiId=d.profile.id;apiKey='profile:'+d.profile.id;updateIdentity();closeDialog('#key-dialog');renderChat();startPolling();ensureActiveResults();toast('API 已加密保存，当前使用 '+d.profile.name)}catch(error){$('#key-error').textContent=error.message}finally{button.disabled=false}};
$('#confirm-delete-api').onclick=async e=>{e.currentTarget.disabled=true;try{await api('/api/api-profiles/'+deleteAPIId,{method:'DELETE'});await loadAPIProfiles();closeDialog('#delete-api-dialog');toast('已移除这把 API')}catch(error){$('#delete-api-error').textContent=error.message}finally{e.target.disabled=false}};
function threadTasks(id){return [...tasks.values()].filter(t=>t.conversationId===id).sort((a,b)=>a.createdAt-b.createdAt)}
function saveDraft(){const t=current();if(t)t.draft=$('#prompt').value}
function switchThread(id){saveDraft();activeId=id;openSetting=null;closeMobileSidebar();render();ensureActiveResults();requestAnimationFrame(()=>scrollBottom())}
function render(){if(!current())activeId=newThread();$('#chat-title').textContent=current().title;$('#prompt').value=current().draft;$('#mode').value=current().settings.mode;$('#mask-file').value='';$('#mask-field').hidden=current().settings.mode!=='mask';renderSidebar();renderChat();renderSettings();renderFiles();updateSize();updateComposerState()}
function renderSidebar(){const q=$('#search').value.trim().toLowerCase();const all=[...threads.values()].sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||b.updatedAt-a.updatedAt);$('#sessions').replaceChildren();let visible=0;
 for(const t of all){const rows=threadTasks(t.id);if(q&&!t.title.toLowerCase().includes(q)&&!rows.some(r=>r.prompt.toLowerCase().includes(q)))continue;visible++;let button=document.createElement('button');button.className='session'+(t.id===activeId?' active':'');button.dataset.session=t.id;if(t.id===activeId)button.setAttribute('aria-current','true');
 const latest=rows.at(-1);const firstImage=[...rows].reverse().map(r=>images.get(r.id+':0')?.url).find(Boolean);button.innerHTML=`${firstImage?`<img class="thumb" src="${esc(firstImage)}" alt="最近生成的图片">`:`<span class="session-placeholder">${icon('image')}</span>`}<span class="session-copy"><span class="session-title">${t.pinned?'<span class="pin-mark">置顶</span>':''}${esc(t.title)}</span><span class="session-meta ${rows.some(r=>running(r))?'running':''}">${rows.some(r=>running(r))?'<i></i> 生成中 · 可切换会话':latest?`${esc(statusNames[latest.status]||latest.status)} · ${rows.length} 次创作`:'等待你的灵感'}</span></span>`;button.onclick=()=>switchThread(t.id);const row=document.createElement('div');row.className='session-row'+(t.id===activeId?' active':'');const more=document.createElement('button');more.type='button';more.className='session-more';more.setAttribute('aria-label','会话操作：'+t.title);more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded',String(menuConversationId===t.id));more.innerHTML=icon('more');more.onclick=e=>{e.stopPropagation();openConversationMenu(t.id,more)};row.append(button,more);$('#sessions').append(row)}
 if(!visible){const empty=document.createElement('p');empty.className='sidebar-empty';empty.textContent=q?'没有找到相关会话。':user?'新建一个会话，开始你的第一次创作。':'登录后，可以找回你的创作记录。';$('#sessions').append(empty)}
}
function renderChat(){const rows=threadTasks(activeId),container=$('#messages');if(!rows.length){container.className='empty';container.innerHTML=`<div><span class="empty-mark">${icon('cat')}</span><h1>今天，想把什么变成画面？</h1><p>写下一点灵感，剩下的交给喵图。</p><div class="suggestions"><button data-suggest="一只戴绿色围巾的橘猫坐在洒满阳光的窗边，治愈系插画，柔和暖光">窗边的小猫 ↗</button><button data-suggest="一座漂浮在云端的小屋，夕阳与柔软的云朵，梦幻的 3D 插画">云端小屋 ↗</button><button data-suggest="奶油色的极简花卉手机壁纸，柔和自然光，竖版构图">手机壁纸 ↗</button></div></div>`;container.querySelectorAll('[data-suggest]').forEach(b=>b.onclick=()=>{$('#prompt').value=b.dataset.suggest;current().draft=b.dataset.suggest;if(b.dataset.suggest.includes('竖版')){current().settings.ratio='9:16';renderSettings();updateSize()}$('#prompt').focus()});return}
 container.className='chat-content';container.replaceChildren();for(const task of rows){const article=document.createElement('article');article.id='turn-'+task.id;container.append(article);renderTurn(task,article)}
}
function updateTurn(task){if(task.conversationId!==activeId)return;let el=document.getElementById('turn-'+task.id);const scroller=$('#chat-scroll'),atBottom=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<100;if(!el){renderChat()}else renderTurn(task,el);if(atBottom)requestAnimationFrame(scrollBottom);updateComposerState()}
function errorMarkup(info,message){const reason=info?.reason||message||'服务未提供详细原因，请联系 API 供应商核对。';const code=info?.code;const http=info?.httpStatus;return `<div class="error-box" role="alert"><h3>这次创作未能完成</h3>${code||http?`<div class="error-meta">${code?'错误代码：'+esc(code):''}${code&&http?' · ':''}${http?'HTTP '+esc(http):''}${info?.unknownCode?'（该代码未收录于文档）':''}</div>`:''}<p>${esc(reason)}</p>${info?.upstreamMessage?`<div class="original-error">API 返回：${esc(info.upstreamMessage)}</div>`:''}${info?.requestId?`<div class="error-meta">上游请求号：${esc(info.requestId)}</div>`:''}</div>`}
function renderTurn(task,article){const rt=runtime(task.id);const settings=task.uiSettings||{};article.innerHTML=`<div class="user-message">${esc(task.prompt)}</div><div class="user-meta"><span>${esc(modelName(task.model))}</span><span>${esc(settings.ratio==='custom'?`${settings.customRatioWidth}:${settings.customRatioHeight}`:settings.ratio||task.size.replace('x',' × '))}</span><span>${esc(task.size.replace('x',' × '))} 像素</span><span>${task.n} 张</span>${task.apiProfileId?`<span>API：${esc(apiProfiles.find(p=>p.id===task.apiProfileId)?.name||'原 API')}</span>`:''}${task.mode!=='text'?'<span>含参考图'+(task.mode==='mask'?'与遮罩':'')+'</span>':''}</div><div class="assistant"><span class="assistant-icon">${icon('cat')}</span><div class="assistant-body"><div class="assistant-name">image meow <span class="time-label">${esc(new Date(task.createdAt*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}))}</span></div><div class="turn-response"></div></div></div>`;const response=article.querySelector('.turn-response');
 if(task.status==='failed'){response.innerHTML=errorMarkup(task.errorInfo,task.error)+`<div class="reply-actions"><button data-reuse>${icon('edit')}重新编辑</button></div>`}
 else if(task.status==='expired'){response.innerHTML='<div class="error-box"><h3>图片结果已过期</h3><p>结果已超过 12 小时保留期。你可以复用提示词开始新的创作。</p></div><div class="reply-actions"><button data-reuse>重新编辑</button></div>'}
 else if(task.status==='unknown'||(task.status==='submitting'&&!rt.submitting)){response.innerHTML=errorMarkup(task.errorInfo,task.error||'提交结果尚未确认。请恢复原提交核对，不要重复发送。')+`<div class="result-note">${pending.has(task.idempotencyKey)?'恢复时将复用原参数、图片、密钥和提交标记，不创建新的付费任务。':task.references?.length?'原参考图已保存在当前账号。请先选择原 API，并在供应商控制台核对原提交，不要重复生成。':'这次原提交状态尚未确认，请在供应商控制台核对，不要重复生成。'}<br>提交标记：${esc(task.idempotencyKey)}</div>${pending.has(task.idempotencyKey)?'<div class="reply-actions"><button data-restore>恢复原提交</button></div>':''}`}
 else if(running(task)){response.innerHTML=`<div class="status" aria-live="polite"><span class="spinner"></span>${task.status==='submitting'?'正在提交你的灵感':task.status==='queued'?'请求已收到，正在排队':'正在把你的灵感变成图片…'}</div><p>你可以切换或新建其他会话，图片会在这里继续生成。</p><div class="pending-grid">${Array.from({length:Math.min(task.n,4)},()=>`<div class="placeholder">${icon('image')}<span>等待画面慢慢浮现</span></div>`).join('')}</div><div class="result-note">${apiKey?'自动查询生成状态 · 不提供完成百分比':'重新连接 API 后可继续查看进度'}</div>`}
 else if(task.status==='succeeded'){
 const count=Array.isArray(rt.result?.data)?rt.result.data.length:task.n;response.innerHTML=`<div class="status">${icon('check')}已完成 · ${count} 张图片</div><div class="image-grid"></div><div class="result-foot">请求尺寸 ${esc(task.size.replace('x',' × '))} 像素 · 以下载图片的实际尺寸为准${task.charged!=null?' · 实际扣费 ¥'+Number(task.charged).toFixed(2):''}<br>结果保留 12 小时，请及时下载。</div><div class="reply-actions"><button data-reuse>${icon('edit')}重新编辑</button><button data-copy>${icon('copy')}复制提示词</button></div>`;
 const grid=response.querySelector('.image-grid');if(count===1)grid.classList.add('single');for(let n=0;n<count;n++){const card=document.createElement('div');card.className='image-card';card.style.aspectRatio=task.size.replace('x',' / ');const img=document.createElement('img');img.alt=`生成作品 ${n+1}`;img.onload=()=>{if(img.naturalWidth&&img.naturalHeight)card.style.aspectRatio=img.naturalWidth+' / '+img.naturalHeight};const loading=document.createElement('div');loading.className='image-loading';const item=images.get(task.id+':'+n);if(item?.url){img.src=item.url;loading.hidden=true;img.onclick=()=>{$('#lightbox-image').src=item.url;openDialog('#lightbox')}}else{loading.textContent=item?.error||(!apiKey?'连接 API 后查看图片':'正在加载图片…');if(item?.error){const retry=document.createElement('button');retry.textContent='重试加载';retry.onclick=()=>{images.delete(task.id+':'+n);loadImage(task,n,true)};loading.append(retry)}}
 const label=document.createElement('span');label.className='image-count';label.textContent=`${String(n+1).padStart(2,'0')} / ${String(count).padStart(2,'0')}`;card.append(img,loading,label);if(item?.url){const save=document.createElement('button');save.className='image-save';save.setAttribute('aria-label',`下载原图 ${n+1}`);save.innerHTML=icon('download');save.onclick=()=>download(item.url,`image-meow-${task.id}-${n+1}.${item.ext}`);card.append(save);const edit=document.createElement('button');edit.className='image-edit';edit.textContent='基于此图修改';edit.onclick=()=>useImage(task,n);card.append(edit)}grid.append(card);if(!item&&apiKey)loadImage(task,n)}
 }
 if(rt.queryError){const note=document.createElement('div');note.className='query-note';note.textContent=(rt.queryErrorInfo?.code?'错误代码：'+rt.queryErrorInfo.code+' · ':'')+rt.queryError+(rt.queryErrorInfo?.upstreamMessage?' API 返回：'+rt.queryErrorInfo.upstreamMessage:'')+(rt.paused?'（自动查询已暂停）':'（稍后自动重试）');const b=document.createElement('button');b.textContent='再次查询';b.onclick=()=>{if(!requireKey())return;rt.paused=false;rt.failures=0;rt.nextQueryAt=0;queryTask(task.id);startPolling()};note.append(document.createElement('br'),b);response.append(note)}
 article.querySelector('[data-reuse]')?.addEventListener('click',()=>reeditTask(task));article.querySelector('[data-copy]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(task.prompt);toast('已复制提示词')}catch{toast('可以选中上方提示词进行复制')}});article.querySelector('[data-restore]')?.addEventListener('click',()=>{const submission=pending.get(task.idempotencyKey);if(submission)submitGeneration(submission)});
}
function download(url,name){const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove()}
async function useImage(task,index){const item=images.get(task.id+':'+index);if(!item?.blob)return;const t=current();t.restoreToken=Symbol('generated-image');t.loadingInputs=false;t.inputRestoreError=null;t.editingTaskId=null;if(t.maskURL)URL.revokeObjectURL(t.maskURL);t.mask=null;t.maskURL=null;if(t.fileURLs.length)t.fileURLs.forEach(URL.revokeObjectURL);t.files=[new File([item.blob],`image-meow-reference.${item.ext}`,{type:item.blob.type})];t.fileURLs=t.files.map(URL.createObjectURL);t.settings.mode='edit';$('#mode').value='edit';$('#mask-field').hidden=true;renderFiles();$('#prompt').value='';t.draft='';updateComposerState();$('#prompt').placeholder='描述想对这张图片做的修改…';$('#prompt').focus();toast('已将这张作品设为参考图，请描述想做的修改。')}
async function reeditTask(task){
 const t=current();if(t.loadingInputs)return;
 const selectedFiles=[...t.files],selectedMask=t.mask;
 const requestToken=Symbol('reedit');t.restoreToken=requestToken;t.editingTaskId=task.id;t.inputRestoreError=null;
 t.settings={...defaults(),...task.uiSettings,model:task.model,count:task.n,mode:task.mode};
 if(!task.uiSettings){const [w,h]=task.size.split('x').map(Number);t.settings.ratio='custom';t.settings.customRatioWidth=w;t.settings.customRatioHeight=h;t.settings.resolution=Math.max(w,h)}
 t.fileURLs.forEach(URL.revokeObjectURL);t.files=[];t.fileURLs=[];if(t.maskURL)URL.revokeObjectURL(t.maskURL);t.mask=null;t.maskURL=null;
 t.draft=task.prompt;$('#prompt').value=task.prompt;$('#mode').value=t.settings.mode;$('#mask-field').hidden=t.settings.mode!=='mask';$('#mask-file').value='';
 const snapshot=inputSnapshots.get(task.idempotencyKey)||pending.get(task.idempotencyKey);
 const refs=task.references||[];
 t.loadingInputs=refs.length>0;renderSettings();renderFiles();updateSize();updateComposerState();$('#prompt').focus();
 try {
  if(refs.length){
   const restored=[];
   // Bound memory use for multi-reference tasks by downloading one original at a time.
   for(const ref of refs){const blob=await api(`/api/tasks/${task.id}/references/${ref.index}`,{blob:true});if(threads.get(t.id)!==t||t.restoreToken!==requestToken)return;restored.push({kind:ref.kind,file:new File([blob],ref.name,{type:ref.type})})}
   if(threads.get(t.id)!==t||t.restoreToken!==requestToken)return;
   t.files=restored.filter(r=>r.kind==='image').map(r=>r.file);t.mask=restored.find(r=>r.kind==='mask')?.file||null;
  }else if(snapshot){t.files=[...snapshot.files];t.mask=snapshot.mask||null}
  else if(task.mode!=='text'){
   t.files=selectedFiles;t.mask=task.mode==='mask'?selectedMask:null;
   t.inputRestoreError=t.files.length?'这条旧记录未保存原参考图，已保留当前选中的 '+t.files.length+' 张参考图'+(t.mask?'和 PNG 遮罩':'')+'。请核对图片后再生成。':'这条旧记录未保存原参考图，请重新上传参考图'+(task.mode==='mask'?'和 PNG 遮罩':'')+'。';
  }
  t.fileURLs=t.files.map(URL.createObjectURL);
 }catch(e){if(threads.get(t.id)!==t||t.restoreToken!==requestToken)return;t.files=[];t.fileURLs=[];t.mask=null;t.inputRestoreError='原参考图读取失败：'+e.message+' 请重新点击“重新编辑”重试，或上传替换图片。'}
 finally{if(threads.get(t.id)===t&&t.restoreToken===requestToken){t.loadingInputs=false;if(activeId===t.id){renderFiles();updateComposerState()}}}
}
async function loadImage(task,index,force=false){if(!apiKey||task.conversationId!==activeId&&!force)return;const id=task.id+':'+index;if(images.has(id))return;const token=epoch;images.set(id,{loading:true});try{const blob=await api(`/api/tasks/${task.id}/images/${index}`,{blob:true});if(token!==epoch)return;const url=URL.createObjectURL(blob);images.set(id,{blob,url,ext:blob.type==='image/jpeg'?'jpg':blob.type.split('/')[1]||'png'});updateTurn(tasks.get(task.id)||task);if(index===0)renderSidebar()}catch(e){if(token!==epoch)return;images.set(id,{error:e.message});updateTurn(tasks.get(task.id)||task)}}
function upsertTask(task){if(deletedConversationIds.has(task.conversationId))return;tasks.set(task.id,task);if(task.references?.length)inputSnapshots.delete(task.idempotencyKey);const t=threads.get(task.conversationId);if(t){t.updatedAt=Math.max(t.updatedAt,task.createdAt);t.local=false}renderSidebar();updateTurn(task)}
async function queryTask(id){const token=epoch,key=apiKey;if(!key||!user||querying.has(id))return;const task=tasks.get(id);if(!task?.upstreamId)return;querying.add(id);try{const d=await api('/api/tasks/'+id);if(token!==epoch)return;const rt=runtime(id);rt.failures=0;rt.queryError=null;rt.queryErrorInfo=null;rt.nextQueryAt=Date.now()+5000;if(d.result)rt.result=d.result;upsertTask(d.task);if(d.task.status==='succeeded')loadImage(d.task,0,true)}catch(e){if(token!==epoch)return;const rt=runtime(id);rt.failures=(rt.failures||0)+1;rt.queryError=e.message;rt.queryErrorInfo=e.errorInfo;rt.paused=rt.failures>=6||e.status===422||e.status===403||e.status===404;rt.nextQueryAt=Date.now()+Math.min(30000,5000*rt.failures);updateTurn(task)}finally{if(token===epoch)querying.delete(id)}}
function startPolling(){clearTimeout(pollTimer);if(!apiKey||!user)return;const token=epoch;pollTimer=setTimeout(async()=>{if(token!==epoch||polling)return;polling=true;try{const list=[...tasks.values()].filter(t=>t.upstreamId&&['queued','running'].includes(t.status)&&!runtime(t.id).paused&&(runtime(t.id).nextQueryAt||0)<=Date.now());const task=list.sort((a,b)=>(runtime(a.id).nextQueryAt||0)-(runtime(b.id).nextQueryAt||0))[0];if(task)await queryTask(task.id)}finally{if(token===epoch){polling=false;startPolling()}}},600)}
function ensureRecentThumbnails(){if(!apiKey)return;const seen=new Set();for(const task of [...tasks.values()].sort((a,b)=>b.createdAt-a.createdAt)){if(seen.has(task.conversationId)||task.status!=='succeeded'||task.createdAt+43200<Date.now()/1000)continue;seen.add(task.conversationId);loadImage(task,0,true);if(seen.size>=5)break}}
function ensureActiveResults(){if(!apiKey||!user)return;const rows=threadTasks(activeId);for(const t of rows){if(t.status==='succeeded'&&t.createdAt+43200>Date.now()/1000){if(!runtime(t.id).result)queryTask(t.id);else loadImage(t,0)}else if(t.upstreamId&&['queued','running'].includes(t.status))runtime(t.id).nextQueryAt=0}startPolling()}
function scrollBottom(){$('#chat-scroll').scrollTop=$('#chat-scroll').scrollHeight}
async function loadHistory(){if(!user)return;const token=epoch;try{const [a,b]=await Promise.all([api('/api/conversations'),api('/api/tasks')]);if(token!==epoch)return;const oldActive=activeId;for(const c of a.conversations){const t=threads.get(c.id);const next={...t,...c,settings:t?.editingTaskId?t.settings:{...defaults(),...(c.settings||{})},draft:t?.draft||'',files:t?.files||[],fileURLs:t?.fileURLs||[],mask:t?.mask||null,local:false};if(t)Object.assign(t,next);else threads.set(c.id,next)}
 const liveIds=new Set([...a.conversations.map(c=>c.id),...b.tasks.map(t=>t.conversationId)]);for(const t of [...threads.values()])if(!t.local&&!liveIds.has(t.id))removeLocalConversation(t.id);
 for(const task of [...b.tasks].reverse()){if(deletedConversationIds.has(task.conversationId))continue;const t=threads.get(task.conversationId);if(!t)threads.set(task.conversationId,{id:task.conversationId,title:task.prompt.slice(0,60),settings:{...defaults(),...task.uiSettings,model:task.model,count:task.n,mode:task.mode},draft:'',files:[],fileURLs:[],mask:null,local:false,createdAt:task.createdAt,updatedAt:task.createdAt});const previous=[...tasks.values()].find(p=>p.idempotencyKey===task.idempotencyKey&&p.id!==task.id);if(previous){tasks.delete(previous.id);runtimes.delete(previous.id)}tasks.set(task.id,task);if(task.references?.length)inputSnapshots.delete(task.idempotencyKey);if(task.upstreamId||['succeeded','failed','expired'].includes(task.status))pending.delete(task.idempotencyKey)}
 if(threads.has(oldActive))activeId=oldActive;else if(!threads.has(activeId))activeId=[...threads.keys()][0]||newThread();render();ensureActiveResults();ensureRecentThumbnails()}catch(e){if(token===epoch)toast(e.message)}}
const settingNames={model:'选择模型',ratio:'画面比例',resolution:'图片清晰度',count:'生成数量'};const settingIcons={model:'image',ratio:'ratio',resolution:'image',count:'stack'};
function ratioPreview(settings){
 let [width,height]=settings.ratio==='custom'?[Number(settings.customRatioWidth),Number(settings.customRatioHeight)]:String(settings.ratio).split(':').map(Number);
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)width=height=1;
 const scale=16/Math.max(width,height),w=Number((width*scale).toFixed(3)),h=Number((height*scale).toFixed(3));
 return `<svg class="icon ratio-preview" viewBox="0 0 20 20" aria-hidden="true"><rect x="${(20-w)/2}" y="${(20-h)/2}" width="${w}" height="${h}" rx="1"/></svg>`;
}
function renderSettings(){for(const box of $$('.setting')){const key=box.dataset.key,s=current().settings;const value=s[key];const label=key==='model'?modelName(value):key==='count'?value+' 张':key==='resolution'?Number(value)/1024+'K':value==='custom'?`${s.customRatioWidth}:${s.customRatioHeight}`:value;
 let choices=key==='model'?models:key==='ratio'?['1:1','3:4','4:3','16:9','9:16','custom']:key==='resolution'?[1024,2048,4096]:[1,2,4,8,16];if(key==='model'&&!choices.includes(value))choices=[value,...choices];
 box.innerHTML=`<button type="button" class="setting-toggle" aria-expanded="${openSetting===key}" aria-label="${esc(settingNames[key])}：${esc(label)}">${key==='ratio'?ratioPreview(s):icon(settingIcons[key])}<span>${esc(label)}</span>${icon('chevron').replace('class="icon"','class="icon chev"')}</button><div class="popover" ${openSetting===key?'':'hidden'}><div class="pop-title">${settingNames[key]}</div>${choices.map(v=>`<button type="button" class="option ${v===value?'selected':''}" data-choice="${esc(v)}"><span class="opt-left">${key==='ratio'&&v!=='custom'?`<i class="ratio-icon ${({'3:4':'portrait','4:3':'landscape','16:9':'wide','9:16':'tall'})[v]||''}"></i>`:''}${esc(key==='model'?modelName(v):key==='ratio'&&v==='custom'?'自定义比例':key==='resolution'?v/1024+'K':key==='count'?v+' 张':v)}</span><small>${key==='ratio'?({'1:1':'方形','3:4':'竖图','4:3':'横图','16:9':'宽屏','9:16':'手机壁纸','custom':'输入宽 : 高'})[v]:key==='resolution'?({1024:'标准',2048:'精细',4096:'超清'})[v]:''}</small>${v===value?icon('check'):''}</button>`).join('')}${key==='ratio'?`<div class="custom-ratio" ${value==='custom'?'':'hidden'}><label>自定义宽高比例</label><div class="ratio-inputs"><input type="number" aria-label="自定义比例宽" id="ratio-width" min="0.001" max="10000" step="any" value="${esc(s.customRatioWidth)}"><span>:</span><input type="number" aria-label="自定义比例高" id="ratio-height" min="0.001" max="10000" step="any" value="${esc(s.customRatioHeight)}"></div><p>输入比例数值；像素尺寸根据清晰度计算，并取整到 8 的倍数。</p><p class="inline-error" id="ratio-error" role="alert"></p><button type="button" class="apply" id="apply-ratio">应用比例</button></div>`:''}${key==='count'?`<div class="custom-ratio"><label for="custom-count">自定义张数（1–16）</label><input class="count-input" type="number" id="custom-count" value="${s.count}" min="1" max="16"><button type="button" class="apply" id="apply-count">应用数量</button></div>`:''}${key==='model'?`<button type="button" class="option" id="refresh-models">${icon('refresh')}更新可用模型</button><a class="render-link" target="_blank" rel="noopener noreferrer" href="https://www.jituapi.cn/models/${encodeURIComponent(s.model)}">查看模型支持的参数 ↗</a>`:''}</div>`;
 box.querySelector('.setting-toggle').onclick=()=>{openSetting=openSetting===key?null:key;renderSettings()};box.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>{const v=b.dataset.choice;s[key]=['count','resolution'].includes(key)?Number(v):v;if(!(key==='ratio'&&v==='custom'))openSetting=null;renderSettings();updateSize()});
 if(key==='ratio'){box.querySelector('#apply-ratio').onclick=()=>{const trial={...s,customRatioWidth:Number($('#ratio-width').value),customRatioHeight:Number($('#ratio-height').value),ratio:'custom'};try{requestedSize(trial);Object.assign(s,trial);openSetting=null;renderSettings();updateSize()}catch(e){$('#ratio-error').textContent=e.message}}}
 if(key==='count')box.querySelector('#apply-count').onclick=()=>{const count=Number($('#custom-count').value);if(!Number.isInteger(count)||count<1||count>16){toast('生成数量请填写 1 至 16 的整数。');return}s.count=count;openSetting=null;renderSettings()};
 if(key==='model')box.querySelector('#refresh-models').onclick=async e=>{if(!requireKey())return;const button=e.currentTarget;button.disabled=true;try{const {models:raw}=await api('/api/models');const list=Array.isArray(raw)?raw:raw?.data||raw?.models;if(!Array.isArray(list))throw new Error('返回的模型列表无法读取。');const ids=[...new Set(list.map(m=>typeof m==='string'?m:m.id||m.model||m.model_id||m.name).filter(m=>typeof m==='string'&&/^[\w.:-]{1,150}$/.test(m)))];if(!ids.length)throw new Error('当前没有读取到可用模型。');models=ids;renderSettings();toast('已更新模型列表，请确认模型支持的尺寸和张数。')}catch(e){toast(e.message)}finally{button.disabled=false}};
 }}
function updateSize(){try{const d=requestedSize(current().settings);$('#size-description').textContent=`${d.width} × ${d.height} 像素`}catch(e){$('#size-description').textContent='请调整画面比例';}updateComposerState()}
function updateComposerState(){if(!current())return;const t=current();const generating=threadTasks(activeId).some(t=>running(t));const blocking=generating||!!t.loadingInputs;$('#generate').disabled=blocking;$('#generate').title=blocking?'当前会话正在生成，可新建其他会话':'发送生图请求';$('#attach').disabled=!!t.loadingInputs;$('#mode').disabled=!!t.loadingInputs;$('#mask-file').disabled=!!t.loadingInputs;$('#composer-hint').hidden=!blocking&&!t.editingTaskId&&!t.inputRestoreError;$('#composer-hint').textContent=t.loadingInputs?'正在恢复原参考图与遮罩…':generating?'当前会话正在处理，你可以先写下一条灵感，或新建其他生图会话。':t.inputRestoreError||t.editingTaskId&&'正在重新编辑：可修改提示词、添加或移除参考图，再点击发送重新生成。'||'';$('#reference-storage-note').hidden=t.settings.mode==='text';$('#prompt').placeholder=blocking?'先写下下一条灵感，或切换到其他会话…':current().settings.mode==='text'?'描述你想要的画面…':'描述想做的修改；生图时将使用上方选中的参考图…'}
function renderFiles(){const t=current();$('#attachments').hidden=!t.files.length&&!t.mask;$('#attachments').replaceChildren();
 function thumb(file,url,label,remove){const wrap=document.createElement('div');wrap.className='file-thumb';const img=document.createElement('img');img.src=url;img.alt=label;img.title=file.name;const b=document.createElement('button');b.type='button';b.textContent='×';b.setAttribute('aria-label','移除'+label);b.disabled=!!t.loadingInputs;b.onclick=remove;wrap.append(img,b);$('#attachments').append(wrap)}
 t.files.forEach((file,index)=>thumb(file,t.fileURLs[index],'参考图片 '+(index+1),()=>{URL.revokeObjectURL(t.fileURLs[index]);t.files.splice(index,1);t.fileURLs.splice(index,1);renderFiles();updateComposerState()}));
 if(t.files.length){const label=document.createElement('span');label.className='attachment-count';label.textContent=`${t.files.length} / 16 张参考图`;$('#attachments').append(label)}
 if(t.mask){if(!t.maskURL)t.maskURL=URL.createObjectURL(t.mask);thumb(t.mask,t.maskURL,'PNG 遮罩',()=>{URL.revokeObjectURL(t.maskURL);t.mask=null;t.maskURL=null;$('#mask-file').value='';renderFiles();updateComposerState()});const label=document.createElement('span');label.className='attachment-count';label.textContent='PNG 遮罩';$('#attachments').append(label)}
}
function addFiles(incoming){const t=current(),list=[...incoming];if(t.loadingInputs){toast('请等待原参考图恢复完成。');return}if(t.files.length+list.length>16){toast('最多上传 16 张参考图。');return}for(const f of list){if(!['image/png','image/jpeg','image/webp'].includes(f.type)||f.size>20*1024*1024){toast('请选择每张不超过 20 MiB 的 PNG、JPG 或 WebP 图片。');return}}if([...t.files,...list].reduce((a,f)=>a+f.size,0)+(t.mask?.size||0)>49*1024*1024){toast('参考图与遮罩合计请小于 49 MiB，为上传请求预留空间。');return}t.files.push(...list);t.fileURLs.push(...list.map(URL.createObjectURL));if(t.settings.mode==='text'){t.settings.mode='edit';$('#mode').value='edit'}t.inputRestoreError=null;renderFiles();updateComposerState()}
$('#attach').onclick=()=>$('#reference-files').click();$('#reference-files').onchange=e=>{addFiles(e.target.files);e.target.value=''};$('#mask-file').onchange=e=>{const file=e.target.files[0];if(file&&(file.type!=='image/png'||file.size>20*1024*1024)){toast('遮罩必须是 20 MiB 以内的 PNG 文件。');e.target.value='';return}if(current().maskURL)URL.revokeObjectURL(current().maskURL);current().maskURL=null;current().mask=file||null;current().inputRestoreError=null;renderFiles();updateComposerState()};
$('#mode').onchange=e=>{current().settings.mode=e.target.value;$('#mask-field').hidden=e.target.value!=='mask';updateComposerState()};
$('#generation-form').addEventListener('dragover',e=>e.preventDefault());$('#generation-form').addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer?.files.length)addFiles(e.dataTransfer.files)});
function captureSubmission(){const t=current(),s={...t.settings};if(t.loadingInputs)throw new Error('请等待原参考图恢复完成。');const p={conversationId:t.id,uiSettings:s,mode:s.mode,model:s.model,prompt:$('#prompt').value.trim(),size:requestedSize(s).size,n:Number(s.count)};if(!p.prompt)throw new Error('先写下一点你想生成的画面吧。');if(!Number.isInteger(p.n)||p.n<1||p.n>16)throw new Error('生成数量请填写 1 至 16 张。');if(s.mode!=='text'&&!t.files.length)throw new Error('图生图需要先添加参考图片。');if(s.mode==='mask'&&!t.mask)throw new Error('局部编辑还需要 PNG 遮罩。');return {id:crypto.randomUUID(),p,files:s.mode==='text'?[]:[...t.files],mask:s.mode==='mask'?t.mask:null,originalKey:apiKey,apiProfileId:selectedApiId,createdAt:Date.now()/1000,localId:null}}
async function submitGeneration(submission){if(!requireKey())return;const t=threads.get(submission.p.conversationId);if(!t)return;if(!submission.apiProfileId&&submission.originalKey!==apiKey){toast('恢复原提交需要重新连接原来的 API 密钥。');return}let local=submission.localId&&tasks.get(submission.localId);if(local&&runtime(local.id).submitting)return;if(!local){const found=[...tasks.values()].find(x=>x.idempotencyKey===submission.id);if(found){submission.localId=found.id;local=found}else{const id='local-'+submission.id;submission.localId=id;local={id,conversationId:t.id,idempotencyKey:submission.id,mode:submission.p.mode,prompt:submission.p.prompt,model:submission.p.model,size:submission.p.size,n:submission.p.n,uiSettings:submission.p.uiSettings,apiProfileId:submission.apiProfileId,createdAt:submission.createdAt,status:'submitting'};tasks.set(id,local)}}
 const token=epoch;runtime(local.id).submitting=true;local.status='submitting';inputSnapshots.set(submission.id,{files:[...submission.files],mask:submission.mask});t.editingTaskId=null;t.inputRestoreError=null;pending.set(submission.id,submission);if(t.title==='新的生图会话')t.title=submission.p.prompt.slice(0,60);t.updatedAt=Date.now()/1000;if(activeId===t.id){$('#chat-title').textContent=t.title;renderChat();updateComposerState();requestAnimationFrame(scrollBottom)}renderSidebar();
 try{let body=submission.p;if(body.mode!=='text'){body=new FormData();Object.entries(submission.p).forEach(([k,v])=>body.set(k,k==='uiSettings'?JSON.stringify(v):String(v)));submission.files.forEach(f=>body.append(submission.files.length===1?'image':'image[]',f));if(submission.mask)body.set('mask',submission.mask)}const d=await api('/api/tasks',{method:'POST',profileId:apiProfiles.some(p=>p.id===submission.apiProfileId)?submission.apiProfileId:selectedApiId,headers:{'Idempotency-Key':submission.id},body});if(token!==epoch)return;tasks.delete(local.id);runtimes.delete(local.id);pending.delete(submission.id);submission.localId=d.task.id;if(d.result)runtime(d.task.id).result=d.result;upsertTask(d.task);if(activeId===t.id){renderChat();updateComposerState();requestAnimationFrame(scrollBottom)}startPolling();if(d.task.status==='succeeded')loadImage(d.task,0);}
 catch(e){if(token!==epoch)return;const ambiguous=!e.status||e.status>=500||[429,409].includes(e.status);local.status=ambiguous?'unknown':'failed';local.error=e.message;local.errorInfo=e.errorInfo;runtime(local.id).submitting=false;if(!ambiguous)pending.delete(submission.id);upsertTask(local);await loadHistory()}
 finally{if(token===epoch){runtime(submission.localId).submitting=false;updateComposerState();await refreshStorage()}}
}
$('#generation-form').onsubmit=e=>{e.preventDefault();if(!requireKey())return;if(threadTasks(activeId).some(t=>running(t))){toast('当前会话仍在处理，可以新建另一个生图会话。');return}try{const submission=captureSubmission();current().draft='';$('#prompt').value='';submitGeneration(submission)}catch(e){toast(e.message)}};
$('#prompt').addEventListener('input',saveDraft);$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#generation-form').requestSubmit()}});
$('#new-chat').onclick=()=>{saveDraft();const id=newThread();switchThread(id);$('#prompt').focus()};$('#search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(renderSidebar,80)};$('#history-refresh').onclick=()=>{saveDraft();if(requireUser())loadHistory()};
async function ensureRemoteConversation(t){if(t.local&&user){await api('/api/conversations',{method:'POST',body:{id:t.id,title:t.title,pinned:!!t.pinned,settings:t.settings}});t.local=false;}}
function closeConversationMenu(){menuConversationId=null;if($('#conversation-menu'))$('#conversation-menu').hidden=true;$$('.session-more[aria-expanded=true]').forEach(b=>b.setAttribute('aria-expanded','false'));}
function openConversationMenu(id,anchor){if(menuConversationId===id){closeConversationMenu();return}menuConversationId=id;const t=threads.get(id);$('#pin-conversation').textContent=t.pinned?'取消置顶':'置顶会话';const menu=$('#conversation-menu');menu.hidden=false;const rect=anchor.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(rect.right-170,innerWidth-178))+'px';menu.style.top=Math.max(8,Math.min(rect.bottom+4,innerHeight-145))+'px';anchor.setAttribute('aria-expanded','true');menu.querySelector('button').focus();}
function renameConversation(id){const t=threads.get(id);if(!t)return;renameTargetId=id;$('#conversation-name').value=t.title;$('#rename-error').textContent='';closeConversationMenu();openDialog('#rename-dialog');$('#conversation-name').focus();}
$('#pin-conversation').onclick=async()=>{const t=threads.get(menuConversationId);closeConversationMenu();if(!t||!requireUser())return;try{await ensureRemoteConversation(t);await api('/api/conversations/'+t.id,{method:'PATCH',body:{pinned:!t.pinned}});t.pinned=!t.pinned;renderSidebar()}catch(e){toast(e.message)}};
$('#menu-rename').onclick=()=>renameConversation(menuConversationId);
$('#menu-delete').onclick=()=>{const t=threads.get(menuConversationId);if(!t)return;deleteTargetId=t.id;$('#delete-conversation-name').textContent=t.title;$('#delete-conversation-error').textContent='';closeConversationMenu();openDialog('#delete-conversation-dialog')};
function removeLocalConversation(id){const t=threads.get(id);if(!t)return;t.fileURLs.forEach(URL.revokeObjectURL);if(t.maskURL)URL.revokeObjectURL(t.maskURL);threads.delete(id);for(const task of [...tasks.values()])if(task.conversationId===id){tasks.delete(task.id);runtimes.delete(task.id);querying.delete(task.id);pending.delete(task.idempotencyKey);inputSnapshots.delete(task.idempotencyKey);for(const [key,item]of images)if(key.startsWith(task.id+':')){if(item.url)URL.revokeObjectURL(item.url);images.delete(key);}}}
$('#confirm-delete-conversation').onclick=async e=>{e.currentTarget.disabled=true;try{const t=threads.get(deleteTargetId);if(!t)return;if(!t.local)await api('/api/conversations/'+t.id,{method:'DELETE'});deletedConversationIds.add(t.id);removeLocalConversation(t.id);if(activeId===t.id)activeId=[...threads.keys()][0]||newThread();closeDialog('#delete-conversation-dialog');render();ensureActiveResults();await refreshStorage(false);toast('会话已删除')}catch(error){$('#delete-conversation-error').textContent=error.message}finally{e.target.disabled=false}};
$('#rename-chat').onclick=()=>renameConversation(activeId);$('#rename-form').onsubmit=async e=>{e.preventDefault();const t=threads.get(renameTargetId),title=$('#conversation-name').value.trim();if(!t)return;if(!title){$('#rename-error').textContent='请输入会话名称。';return}const button=e.submitter;button.disabled=true;try{if(user){await ensureRemoteConversation(t);await api('/api/conversations/'+t.id,{method:'PATCH',body:{title}});}t.title=title;renderSidebar();if(activeId===t.id)$('#chat-title').textContent=title;closeDialog('#rename-dialog')}catch(error){$('#rename-error').textContent=error.message}finally{button.disabled=false}};
document.addEventListener('click',e=>{if(!e.composedPath().some(node=>node instanceof Element&&(node.closest('.session-more')||node.id==='conversation-menu')))closeConversationMenu()});
$('#conversation-menu').addEventListener('keydown',e=>{const buttons=[...e.currentTarget.querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus()}});
const sidebarMedia=matchMedia('(max-width:700px)');
function syncSidebarState(){const expanded=sidebarMedia.matches?$('#app').classList.contains('menu-open'):!$('#app').classList.contains('sidebar-collapsed');$('#mobile-menu').setAttribute('aria-expanded',String(expanded));$('#collapse').setAttribute('aria-expanded',String(expanded));$('.sidebar').inert=!expanded;}
function setSidebarOpen(open){if(sidebarMedia.matches)$('#app').classList.toggle('menu-open',open);else{$('#app').classList.toggle('sidebar-collapsed',!open);$('#app').classList.remove('menu-open')}syncSidebarState();$(open?'#collapse':'#mobile-menu').focus();}
function closeMobileSidebar(){const wasOpen=$('#app').classList.contains('menu-open');$('#app').classList.remove('menu-open');syncSidebarState();if(wasOpen&&sidebarMedia.matches)$('#mobile-menu').focus();}
$('#mobile-menu').onclick=()=>setSidebarOpen(true);$('#shade').onclick=closeMobileSidebar;$('#collapse').onclick=()=>setSidebarOpen(false);
sidebarMedia.addEventListener('change',()=>{$('#app').classList.remove('menu-open');syncSidebarState()});syncSidebarState();
// Let editing inputs keep their values when clicking inside an open parameter menu.
document.addEventListener('click',e=>{if(!e.composedPath().some(node=>node instanceof Element&&node.matches('.setting'))&&openSetting){openSetting=null;renderSettings()}});document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.closest('.popover')){e.preventDefault();const apply=e.target.closest('.popover').querySelector('#apply-ratio,#apply-count');apply?.click();return}if(e.key==='Escape'){closeConversationMenu();openSetting=null;renderSettings();closeMobileSidebar()}});
window.addEventListener('beforeunload',e=>{if(pending.size){e.preventDefault();e.returnValue=''}});
activeId=newThread();render();updateIdentity();renderStorage();try{updateFeed=await api('/api/updates');}catch{}try{authConfig=await api('/api/config');selectAuth(authMode);}catch{$('#auth-service-note').textContent='暂时无法确认邮件服务状态，请稍后重试。';}try{const d=await api('/api/me');user=d.user;updateIdentity();if(user){await loadAPIProfiles();await refreshStorage(false);await loadHistory();if(!hasSeenGuide())openGuide(false)}else if(!hasSeenGuide())openGuide(false)}catch(e){toast(e.message)}
announcementsReady=true;queueAnnouncements();
