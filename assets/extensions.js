(function(){
  const LT=String.fromCharCode(60),GT=String.fromCharCode(62);
  const m=value=>String(value).replaceAll('[',LT).replaceAll(']',GT);
  const extRead=(key,fallback=[])=>{try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback))}catch{return fallback}};
  const extWrite=(key,value)=>localStorage.setItem(key,JSON.stringify(value));
  const rawFetch=globalThis.fetch.bind(globalThis);
  let authUser=null,authRefreshPending=false;
  const PAGE_ACCESS={overview:[],workflow:[],assets:['资产查看','资产上传','资产管理'],quality:['规则管理','运行质检','资产查看'],qc:['运行质检','资产管理'],issues:['问题查看','问题处置'],datasets:['数据集查看','数据集发布','训练调度'],training:['训练调度','数据集查看','失败样本回流'],episodes:['资产查看','标注查看','标注审核'],annotation:['标注查看','标注审核'],exports:['数据集发布'],tasks:['采集任务'],nodes:['节点管理'],users:['成员管理'],audit:['成员管理','平台设置']};
  const can=(...required)=>authUser?.role==='数据治理负责人'||required.some(permission=>(authUser?.permissions||[]).includes(permission));
  function applyAccessUi(){if(!authUser)return;document.querySelectorAll('.nav button[data-page]').forEach(button=>{const required=PAGE_ACCESS[button.dataset.page]||[];button.hidden=required.length&&!can(...required)});const create=document.getElementById('createBtn');if(create)create.hidden=!can('采集任务');const scope=document.getElementById('accessScope');if(scope)scope.textContent=`${authUser.role} · ${authUser.domain}`}
  function applyAuthUser(user){authUser=user||null;const box=document.querySelector('.user');if(!box||!user)return;const avatar=box.querySelector('.avatar'),name=box.querySelector('b'),role=box.querySelector('small');if(avatar)avatar.textContent=(user.name||'用户').slice(0,1);if(name)name.textContent=user.name;if(role)role.textContent=`${user.role} · ${user.domain}`;if(!document.getElementById('securityBtn'))box.insertAdjacentHTML('beforeend',m('[button class="auth-logout" id="securityBtn" title="账号安全"][i data-lucide="shield-check"][/i][/button][button class="auth-logout" id="logoutBtn" title="退出登录"][i data-lucide="log-out"][/i][/button]'));document.getElementById('securityBtn').onclick=openSecurity;document.getElementById('logoutBtn').onclick=logout;applyAccessUi();lucide.createIcons()}
  function openSecurity(){const dialog=document.getElementById('securityDialog');if(!dialog)return;document.getElementById('securityIdentity').textContent=`${authUser.name} · ${authUser.email} · ${authUser.role} · ${authUser.domain}`;['currentPassword','newPassword','confirmPassword'].forEach(id=>document.getElementById(id).value='');const error=document.getElementById('securityError');error.textContent='';error.hidden=true;dialog.classList.add('show');document.getElementById('currentPassword').focus()}
  async function changePassword(event){event.preventDefault();const currentPassword=document.getElementById('currentPassword').value,newPassword=document.getElementById('newPassword').value,confirmPassword=document.getElementById('confirmPassword').value,error=document.getElementById('securityError'),button=event.currentTarget.querySelector('button[type="submit"]');if(newPassword!==confirmPassword){error.textContent='两次输入的新密码不一致';error.hidden=false;return}button.disabled=true;error.hidden=true;try{const response=await fetch('/api/auth/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword,newPassword})}),data=await response.json();if(!response.ok)throw new Error(data.error||'密码修改失败');document.getElementById('securityDialog').classList.remove('show');showToast('密码已更新，其他登录会话已失效')}catch(cause){error.textContent=cause.message;error.hidden=false}finally{button.disabled=false}}
  function installAuthGate(){if(document.getElementById('authGate'))return;document.body.insertAdjacentHTML('beforeend',m('[div class="auth-gate" id="authGate"][section class="auth-card"][div class="auth-brand"][span]D[/span][div][b]具身数据质量管控平台[/b][small]生产访问控制[/small][/div][/div][div id="authContent"][/div][/section][/div]'))}
  function renderAuthGate(status,message=''){installAuthGate();const setup=status.setupRequired===true,retry=message.includes('认证服务')?`[button type="button" class="btn auth-retry" id="authRetry"]重新连接认证服务[/button]`:'',content=document.getElementById('authContent'),gate=document.getElementById('authGate');content.innerHTML=m(`[div class="auth-copy"][h1]${setup?'初始化平台管理员':'登录平台'}[/h1][p]${setup?'首次启用需要创建数据治理负责人账号。密码只保存为加盐哈希。':'使用已启用的平台账号继续工作。'}[/p][/div]${message?`[div class="auth-error"]${escapeHtml(message)}[/div]`:''}${retry}[form id="authForm"]${setup?'[label]管理员姓名[/label][input id="authName" autocomplete="name" required placeholder="姓名" /]':''}[label]工作邮箱[/label][input id="authEmail" type="email" autocomplete="username" required placeholder="name@company.com" /][label]密码[/label][input id="authPassword" type="password" autocomplete="${setup?'new-password':'current-password'}" required placeholder="至少 10 位，包含字母和数字" /]${setup?'[label]确认密码[/label][input id="authConfirm" type="password" autocomplete="new-password" required placeholder="再次输入密码" /]':''}[button class="btn primary auth-submit" type="submit"]${setup?'创建管理员并进入平台':'登录'}[/button][/form][div class="auth-security"]本地账号 · HttpOnly 签名会话 · 服务端角色鉴权[/div]`);gate.classList.add('show');document.body.classList.add('auth-locked');document.getElementById('authForm').onsubmit=event=>submitAuth(event,setup);document.getElementById('authRetry')?.addEventListener('click',()=>initAuth());setTimeout(()=>document.getElementById(setup?'authName':'authEmail')?.focus(),50)}
  async function submitAuth(event,setup){event.preventDefault();const button=event.currentTarget.querySelector('button'),name=document.getElementById('authName')?.value.trim()||'',email=document.getElementById('authEmail').value.trim(),password=document.getElementById('authPassword').value,confirm=document.getElementById('authConfirm')?.value||password;if(setup&&password!==confirm){renderAuthGate({setupRequired:true},'两次输入的密码不一致');return}button.disabled=true;button.textContent=setup?'正在初始化…':'正在登录…';try{const response=await rawFetch(setup?'/api/auth/setup':'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email,password})}),data=await response.json();if(!response.ok)throw new Error(data.error||'认证失败');document.getElementById('authGate').classList.remove('show');document.body.classList.remove('auth-locked');applyAuthUser(data.user);await syncServerState();showToast(setup?'管理员账号已创建':'登录成功')}catch(error){renderAuthGate({setupRequired:setup},error.message)}}
  async function requestAuthStatus(){let lastError;for(let attempt=0;attempt<4;attempt++){try{const response=await rawFetch('/api/auth/status',{cache:'no-store'});if(!response.ok)throw new Error(`认证服务返回 ${response.status}`);return await response.json()}catch(error){lastError=error;if(attempt<3)await new Promise(resolve=>setTimeout(resolve,Math.min(1200,300*2**attempt)))}}throw lastError||new Error('认证服务不可用')}
  async function initAuth(){try{const status=await requestAuthStatus();if(status.authenticated){document.getElementById('authGate')?.classList.remove('show');document.body.classList.remove('auth-locked');applyAuthUser(status.user);return true}renderAuthGate(status);return false}catch(error){renderAuthGate({setupRequired:false},'认证服务暂时不可用，请检查平台服务');return false}}
  async function logout(){await rawFetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});authUser=null;renderAuthGate({setupRequired:false},'已安全退出')}
  globalThis.fetch=async(...args)=>{const response=await rawFetch(...args);const url=String(args[0]||'');if(response.status===401&&!url.includes('/api/auth/')&&!authRefreshPending){authRefreshPending=true;setTimeout(async()=>{await initAuth();authRefreshPending=false},0)}return response};
  async function apiPost(path,payload){try{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.error||'服务端请求失败');return data}catch(error){console.warn('[platform-api]',path,error.message);return null}}
  async function syncEngineCapabilities(){try{const response=await fetch('/api/engine/capabilities',{cache:'no-store'});if(!response.ok)return;extWrite('embodiedEngineCapabilities',await response.json())}catch(error){console.warn('[platform-api] engine capability sync unavailable',error.message)}}
  async function syncServerState(){try{const response=await fetch('/api/state',{cache:'no-store'});if(!response.ok)return;const remote=await response.json();if(remote.currentUser)applyAuthUser(remote.currentUser);saveAssets(remote.assets||[]);writeStore(storageKey.tasks,remote.tasks||[]);extWrite('embodiedBundles',remote.bundles||[]);extWrite('embodiedQcBatches',remote.qcBatches||[]);extWrite('embodiedAudit',remote.audit||[]);extWrite('embodiedEpisodeTags',remote.episodeTags||{});extWrite('embodiedIssues',remote.issues||[]);extWrite('embodiedAnnotations',remote.annotations||[]);extWrite('embodiedExports',remote.exports||[]);extWrite('embodiedDatasets',remote.datasets||[]);extWrite('embodiedTrainingJobs',remote.trainingJobs||[]);extWrite('embodiedFeedbackSamples',remote.feedbackSamples||[]);extWrite('embodiedNodes',remote.nodes||[]);extWrite('embodiedMembers',remote.members||[]);extWrite('embodiedRolePolicies',remote.rolePolicies||{});extWrite('embodiedAuthMode',remote.authMode||'local');extWrite('embodiedQualityRules',remote.rules||[]);extWrite('embodiedQualitySettings',remote.settings||{});await syncEngineCapabilities();const nodes=remote.nodes||[],online=nodes.filter(node=>node.status==='在线').length,syncStatus=document.getElementById('syncStatus'),syncTime=document.getElementById('syncTime');if(syncStatus)syncStatus.textContent=`已连接 · ${online}/${nodes.length} 个节点在线`;if(syncTime)syncTime.textContent=`最近同步：${new Date().toLocaleString('zh-CN',{hour12:false})}`;updateProductionIndicators();updateRulesOverview();refreshNotifications();setTimeout(()=>{if(['workflow','assets','episodes','quality','qc','issues','annotation','exports','datasets','training','nodes','users'].includes(currentPage))showPage(currentPage)},0)}catch(error){const syncStatus=document.getElementById('syncStatus');if(syncStatus)syncStatus.textContent='服务连接异常';console.warn('[platform-api] sync unavailable',error.message)}}
  globalThis.platformUploadAsset=async(file,metadata)=>{const prepared={...metadata,size:file.size,status:'上传中',score:0,serverFile:null,serverManaged:false},knownNodes=new Set(extRead('embodiedNodes',[]).map(node=>node.id));if(prepared.node&&prepared.node!=='未绑定'&&prepared.node!=='本地导入'&&!knownNodes.has(prepared.node))delete prepared.node;const created=await fetch('/api/assets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(prepared)});const createdData=await created.json();if(!created.ok)throw new Error(createdData.error||'无法创建资产记录');const response=await fetch(`/api/assets/${encodeURIComponent(prepared.id)}/content`,{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file});const data=await response.json();if(response.status===409)throw new Error(`重复文件：${data.duplicateName||data.duplicateId}`);if(!response.ok)throw new Error(data.error||'流式上传失败');return data.asset};
  async function inspectMediaFile(file){if(!/^video\//.test(file.type)&&!/[.](mp4|mov|webm|avi)$/i.test(file.name))return null;return new Promise(resolve=>{const video=document.createElement('video'),url=URL.createObjectURL(file),finish=value=>{URL.revokeObjectURL(url);resolve(value)};video.preload='metadata';video.onloadedmetadata=()=>finish({duration:Number(video.duration||0),width:video.videoWidth||0,height:video.videoHeight||0,mime:file.type||''});video.onerror=()=>finish({duration:0,width:0,height:0,mime:file.type||'',decodeError:true});video.src=url})}
  globalThis.platformPersistTask=task=>apiPost('/api/tasks',task);
  const nowLabel=()=>new Date().toLocaleString('zh-CN',{hour12:false});
  const episodeSeed=[
    {id:'EP-UMI-0916-042',type:'UMI',scene:'厨房抓取',task:'餐具整理',duration:'02:48',frames:'5,040',score:96.4,status:'已通过',sync:99.2,complete:99.8,action:97.4,node:'UMI-07'},
    {id:'EP-TELE-0916-118',type:'遥操',scene:'双臂装配',task:'连接器插接',duration:'01:36',frames:'2,880',score:89.7,status:'待复核',sync:91.4,complete:98.6,action:88.9,node:'OP-12'},
    {id:'EP-EGO-0916-207',type:'EGO',scene:'家庭整理',task:'衣物折叠',duration:'04:12',frames:'7,560',score:92.8,status:'待复核',sync:97.5,complete:94.1,action:91.6,node:'EGO-03'},
    {id:'EP-UMI-0916-019',type:'UMI',scene:'零售分拣',task:'货架补货',duration:'02:06',frames:'3,780',score:97.1,status:'已通过',sync:99.6,complete:99.3,action:96.5,node:'UMI-11'},
    {id:'EP-TELE-0916-096',type:'遥操',scene:'精密插接',task:'线束装配',duration:'01:18',frames:'2,340',score:78.6,status:'问题',sync:72.3,complete:96.7,action:81.2,node:'OP-09'},
    {id:'EP-EGO-0916-031',type:'EGO',scene:'仓储拣选',task:'料箱盘点',duration:'03:24',frames:'6,120',score:94.6,status:'已通过',sync:98.4,complete:97.8,action:93.2,node:'EGO-06'}
  ];
  const assetSeed=[
    {id:'AST-0001',name:'厨房抓取-UMI-042',type:'UMI',scene:'家庭服务',format:'MCAP',size:2264924160,records:'2,184 Episodes',node:'UMI-07',model:'ACT-HM-032',qcTemplate:'标准质检',annotationStatus:'已标注',createdAt:'2026/9/12 14:20',score:94.2,status:'已通过'},
    {id:'AST-0002',name:'家庭整理-EGO-207',type:'EGO',scene:'家庭服务',format:'MP4',size:4915200000,records:'218 小时',node:'EGO-03',model:'GR00T-EGO-004',qcTemplate:'标准质检',annotationStatus:'已标注',createdAt:'2026/9/13 09:05',score:90.8,status:'待复核'},
    {id:'AST-0003',name:'双臂装配-OP-118',type:'遥操',scene:'工业装配',format:'HDF5',size:1572864000,records:'4,920 Episodes',node:'OP-12',model:'DP-DA-018',qcTemplate:'全量质检',annotationStatus:'已标注',createdAt:'2026/9/14 16:48',score:88.7,status:'待复核'},
    {id:'AST-0004',name:'零售分拣-UMI-019',type:'UMI',scene:'零售仓储',format:'LeRobot',size:943718400,records:'1,860 Episodes',node:'UMI-11',model:'SmolVLA-RT-011',qcTemplate:'标准质检',annotationStatus:'已标注',createdAt:'2026/9/15 11:12',score:96.1,status:'已通过'}
  ];
  const modelSeed=[
    {id:'ACT-HM-032',policy:'ACT',type:'UMI',dataset:'Household-Manipulation v3.2.1',datasetCount:6,status:'已上线',metric:'成功率 86.4%',updated:'2026/9/12'},
    {id:'DP-DA-018',policy:'Diffusion Policy',type:'遥操',dataset:'DualArm-Assembly v1.8.3',datasetCount:4,status:'已上线',metric:'成功率 91.2%',updated:'2026/9/14'},
    {id:'SmolVLA-RT-011',policy:'SmolVLA',type:'UMI',dataset:'Retail v2.6.0',datasetCount:3,status:'评测中',metric:'成功率 78.9%',updated:'2026/9/15'},
    {id:'GR00T-EGO-004',policy:'GR00T N1',type:'EGO',dataset:'Ego-Pretrain-CN v2.1.0',datasetCount:5,status:'已上线',metric:'成功率 83.5%',updated:'2026/9/13'}
  ];
  const DATA_TYPES=['UMI','EGO','遥操'];
  const IMPORT_GROUPS=[
    {id:'meta',label:'元数据 / 配置',hint:'info、stats、标定、schema、任务配置'},
    {id:'trajectory',label:'轨迹 / 状态',hint:'Parquet、JSONL、CSV、MCAP、关节与传感器流'},
    {id:'media',label:'视频 / 图像',hint:'MP4、MOV、WebM、图片序列或相机流'},
  ];
  const IMPORT_PRESETS={
    遥操:[{id:'lerobot-v21',label:'LeRobot v2.1 三组数据包',required:true},{id:'standard-3',label:'遥操标准三组数据包',required:true},{id:'single',label:'单文件 / 多文件兼容导入',required:false}],
    UMI:[{id:'standard-3',label:'UMI 标准三组数据包',required:true},{id:'single',label:'单文件 / 多文件兼容导入',required:false}],
    EGO:[{id:'standard-3',label:'EGO 标准三组数据包',required:true},{id:'single',label:'单文件 / 多文件兼容导入',required:false}],
  };
  const QC_TEMPLATES=['快速质检','标准质检','全量质检','仅同步检测'];
  const ROLE_NAMES=['数据治理负责人','质量工程师','标注审核员','算法工程师','采集运维'];
  let activeAnnotationId='';
  let activeWorkflowBundleId='';
  const selectedAssetIds=new Set();
  function ensureData(){
    const episodes=extRead('embodiedEpisodes',[]),demoIds=new Set(episodeSeed.map(item=>item.id));
    if(!localStorage.getItem('embodiedProductionEpisodeMigration')){extWrite('embodiedEpisodes',episodes.filter(item=>!demoIds.has(item.id)));localStorage.setItem('embodiedProductionEpisodeMigration','1')}
    else if(!localStorage.getItem('embodiedEpisodes'))extWrite('embodiedEpisodes',[]);
    if(!localStorage.getItem('embodiedWorkflowMigration')){extWrite('embodiedAnnotations',[]);extWrite('embodiedExports',[]);localStorage.setItem('embodiedWorkflowMigration','1')}
    else{if(!localStorage.getItem('embodiedAnnotations'))extWrite('embodiedAnnotations',[]);if(!localStorage.getItem('embodiedExports'))extWrite('embodiedExports',[])}
    if(!localStorage.getItem('embodiedNodeMigration')){extWrite('embodiedNodes',[]);extWrite('embodiedMembers',[]);localStorage.setItem('embodiedNodeMigration','1')}
    else{if(!localStorage.getItem('embodiedNodes'))extWrite('embodiedNodes',[]);if(!localStorage.getItem('embodiedMembers'))extWrite('embodiedMembers',[])}
    if(!localStorage.getItem('embodiedAudit'))extWrite('embodiedAudit',[]);
  }
  function addAudit(action,target,detail){const entry={time:nowLabel(),user:authUser?.name||'当前用户',action,target,detail};const logs=extRead('embodiedAudit');logs.unshift(entry);extWrite('embodiedAudit',logs.slice(0,100));apiPost('/api/audit',entry)}
  function typeBadge(type){const cls=type==='UMI'?'type-umi':type==='EGO'?'type-ego':'type-teleop';return m(`[span class="data-type ${cls}"]${escapeHtml(type)}[/span]`)}
  function statusBadge(status){const cls=status==='已通过'||status==='已完成'||status==='在线'||status==='正常'||status==='已发布'?'low':status==='问题'||status==='离线'||status==='已驳回'||status==='已停用'?'high':'medium';return m(`[span class="status ${cls}"]${escapeHtml(status)}[/span]`)}
  function scoreClass(score){return score>=93?'good':score>=85?'warn':'bad'}
  function updateTrendChart(){
    const box=document.querySelector('.chart-wrap');if(!box)return;
    const runs=extRead('embodiedRuns',[]).filter(run=>run?.summary&&Number.isFinite(Number(run.summary.passRate))).slice(0,7).reverse();
    if(!runs.length){box.innerHTML=m('[div class="empty-inline" style="padding:76px 20px"]尚无真实质检运行记录，执行一次质检后显示趋势[/div]');return}
    const width=700,height=220,padX=50,padY=24,usableW=width-padX*2,usableH=height-48,values=runs.map(run=>Number(run.summary.passRate)),points=values.map((value,index)=>`${padX+(runs.length===1?usableW/2:index*usableW/(runs.length-1))},${padY+(100-Math.max(0,Math.min(100,value)))*usableH/100}`).join(' '),labels=runs.map(run=>String(run.createdAt||run.finishedAt||'').slice(5,10));
    box.innerHTML=`<div class="legend"><span><i style="background:#1d6fe8"></i>质检通过率</span><span><i style="background:#7559d5"></i>运行批次</span></div><svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><line class="gridline" x1="42" y1="22" x2="680" y2="22"/><line class="gridline" x1="42" y1="65" x2="680" y2="65"/><line class="gridline" x1="42" y1="108" x2="680" y2="108"/><line class="gridline" x1="42" y1="151" x2="680" y2="151"/><line class="axis" x1="42" y1="194" x2="680" y2="194"/><text x="9" y="26">100</text><text x="14" y="69">95</text><text x="14" y="112">90</text><text x="14" y="155">85</text><text x="14" y="198">80</text><polyline class="la" points="${points}"/>${runs.map((run,index)=>`<circle class="pa" cx="${padX+(runs.length===1?usableW/2:index*usableW/(runs.length-1))}" cy="${padY+(100-Math.max(0,Math.min(100,Number(run.summary.passRate))))*usableH/100}" r="3.5"/>`).join('')}${labels.map((label,index)=>`<text x="${padX+(runs.length===1?usableW/2:index*usableW/(runs.length-1))-12}" y="214">${escapeHtml(label||'--')}</text>`).join('')}</svg>`;
  }
  function updateProductionIndicators(){
    const assets=getAssets(),allAssets=getAllAssets(),issues=extRead('embodiedIssues',[]),open=issues.filter(item=>item.status!=='已关闭'),qcAssets=assets.filter(item=>item.lastQcAt),scored=qcAssets.filter(item=>Number.isFinite(Number(item.score))),passed=qcAssets.filter(item=>item.status==='已通过');
    document.querySelector('#overviewContent .kpi-top')?.firstChild?.replaceWith('已执行质检平均分');
    const trendSubtitle=document.querySelector('.layout-top .panel .panel-sub');if(trendSubtitle)trendSubtitle.textContent='质检通过率随运行变化';
    const healthSubtitle=document.querySelector('.layout-top .panel:nth-child(2) .panel-sub');if(healthSubtitle)healthSubtitle.textContent='三类数据已执行质检平均分';
    const average=scored.length?(scored.reduce((sum,item)=>sum+Number(item.score),0)/scored.length).toFixed(1):'--',passRate=qcAssets.length?`${(passed.length/qcAssets.length*100).toFixed(1)}%`:'--';
    const set=(id,value)=>{const node=document.getElementById(id);if(node)node.textContent=value};set('assetNavCount',assets.length);set('issueNavCount',open.length);set('overviewQualityScore',average);set('overviewPassedAssets',passed.length);set('overviewPassRate',passRate);set('overviewIssueCount',open.length);set('healthScore',average);
    const byType=type=>{const list=scored.filter(item=>item.type===type);return list.length?Number((list.reduce((sum,item)=>sum+Number(item.score),0)/list.length).toFixed(1)):null};[['UMI','healthUmi','healthUmiBar'],['EGO','healthEgo','healthEgoBar'],['遥操','healthTeleop','healthTeleopBar']].forEach(([type,label,bar])=>{const value=byType(type);set(label,value==null?'--':`${value}%`);const node=document.getElementById(bar);if(node)node.style.width=`${value||0}%`});
     const blocked=open.some(item=>item.level==='高');set('healthState',blocked?'存在高优先级问题':open.length?'存在待复核项':'无未关闭质量问题');set('healthSummary',`${qcAssets.length} 个资产已执行证据质检 · ${assets.filter(item=>item.serverFile).length} 个保有原始文件${allAssets.filter(item=>item.isDemo&&!item.serverFile).length?` · ${allAssets.filter(item=>item.isDemo&&!item.serverFile).length} 个未接入资产待补传`:''}`);const ring=document.getElementById('healthRing');if(ring)ring.style.background=`conic-gradient(${blocked?'var(--red)':open.length?'var(--amber)':'var(--green)'} 0 ${Number(average)||0}%,#e9f1ee ${Number(average)||0}%)`;
     const all=document.getElementById('allIssues');if(all)all.textContent=`查看全部 ${open.length} 条 →`;
     updateTrendChart();
    const body=document.getElementById('issueBody');if(body){const top=open.slice(0,4);body.innerHTML=top.length?top.map(issue=>m(`[tr data-type="${escapeHtml(issue.type)}" data-level="${escapeHtml(issue.level)}"][td]${escapeHtml(issue.metric)}：${escapeHtml(issue.detail)}[/td][td]${typeBadge(issue.type)}[/td][td]${escapeHtml(issue.assetName||issue.assetId)}[/td][td]${escapeHtml(issue.metric)}[/td][td]${escapeHtml(issue.updatedAt||issue.createdAt||'--')}[/td][td][span class="status ${issue.level==='高'?'high':'medium'}"]${escapeHtml(issue.level)}[/span][/td][/tr]`)).join(''):m('[tr][td colspan="6"][div class="empty-inline"]当前没有未关闭质量问题[/div][/td][/tr]')}
  }
  function qualityHealthSnapshot(){
    const assets=getAssets(),issues=extRead('embodiedIssues',[]),openIssues=issues.filter(item=>item.status!=='已关闭'),qcAssets=assets.filter(item=>item.lastQcAt),scored=qcAssets.filter(item=>Number.isFinite(Number(item.score))),passed=qcAssets.filter(item=>item.status==='已通过'),withOriginal=assets.filter(item=>item.serverFile),batches=extRead('embodiedQcBatches',[]);
    const average=scored.length?Number((scored.reduce((sum,item)=>sum+Number(item.score),0)/scored.length).toFixed(1)):null,passRate=qcAssets.length?Number((passed.length/qcAssets.length*100).toFixed(1)):0,evidenceRate=assets.length?Number((withOriginal.length/assets.length*100).toFixed(1)):0;
    const byType=DATA_TYPES.map(type=>{const typed=assets.filter(item=>item.type===type),typedQc=qcAssets.filter(item=>item.type===type),typedScored=scored.filter(item=>item.type===type),typedPassed=passed.filter(item=>item.type===type);return {type,total:typed.length,original:typed.filter(item=>item.serverFile).length,qc:typedQc.length,passed:typedPassed.length,average:typedScored.length?Number((typedScored.reduce((sum,item)=>sum+Number(item.score),0)/typedScored.length).toFixed(1)):null,openIssues:openIssues.filter(item=>item.type===type).length}});
    return {assets,openIssues,qcAssets,scored,passed,withOriginal,batches,average,passRate,evidenceRate,highIssues:openIssues.filter(item=>item.level==='高').length,byType};
  }
  function packageHealthRows(snapshot){
    const bundles=new Map();
    snapshot.assets.filter(asset=>asset.bundleId).forEach(asset=>{if(!bundles.has(asset.bundleId))bundles.set(asset.bundleId,{id:asset.bundleId,name:asset.bundleName||asset.bundleId,type:asset.type,files:[],roles:new Set()});const bundle=bundles.get(asset.bundleId);bundle.files.push(asset);if(asset.bundleRole)bundle.roles.add(asset.bundleRole)});
    const storedBundles=new Map(extRead('embodiedBundles',[]).map(item=>[item.id,item]));
    return [...bundles.values()].map(bundle=>{const stored=storedBundles.get(bundle.id)||{},episodes=bundle.files.filter(asset=>asset.bundleRole==='trajectory'&&/episode_\d+\.parquet$/i.test(asset.relativePath||asset.name)),episodeIds=new Set(episodes.map(asset=>asset.id)),issues=snapshot.openIssues.filter(issue=>bundle.files.some(asset=>asset.id===issue.assetId)),annotations=extRead('embodiedAnnotations',[]).filter(item=>episodeIds.has(item.assetId)),annotationPending=episodes.filter(asset=>!annotations.some(item=>item.assetId===asset.id&&item.status==='已通过'&&String(item.instruction||'').trim()&&['success','failure'].includes(item.outcome))),episodeMediaPending=episodes.filter(asset=>!bundle.files.some(media=>media.bundleRole==='media'&&new RegExp(`episode_0*${Number(/episode_(\d+)\.parquet$/i.exec(asset.relativePath||asset.name)[1])}(?:\\D|$)`,'i').test(media.relativePath||media.name))).length,original=bundle.files.filter(asset=>asset.serverFile).length,qc=bundle.files.filter(asset=>asset.lastQcAt).length,complete=episodes.length>0&&['meta','trajectory','media'].every(role=>bundle.roles.has(role)),ready=complete&&episodeMediaPending===0&&original===bundle.files.length&&qc===bundle.files.length&&bundle.files.every(asset=>asset.status==='已通过')&&!issues.length&&!annotationPending.length,derivedStatus=ready?'可提交验收':issues.length?'需处理':episodeMediaPending||!complete?'待补齐':annotationPending.length?'待标注':'待质检',status=ready&&stored.gateVersion==='episode-v2'&&['待验收','已验收','已归档'].includes(stored.status)?stored.status:derivedStatus;return {...bundle,...stored,issueCount:issues.length,annotationCount:annotations.length,annotationPending:annotationPending.length,episodeMediaPending,episodeCount:episodes.length,original,qc,complete,ready,status}});
  }
  function bundleBlockers(item){
    const blockers=[];
    if(!item.complete)blockers.push(`缺少 ${['meta','trajectory','media'].filter(role=>!item.roles?.has?.(role)&&!item.roles?.includes?.(role)).map(role=>role==='trajectory'?'data':role).join('、')||'数据分组'}`);
    if(item.original<item.files.length)blockers.push(`原始文件 ${item.original}/${item.files.length}`);
    if(item.qc<item.files.length)blockers.push(`未质检 ${item.files.length-item.qc} 个文件`);
    if(item.files.some(asset=>asset.status!=='已通过'))blockers.push(`${item.files.filter(asset=>asset.status!=='已通过').length} 个文件尚未通过质检`);
    if(item.episodeMediaPending)blockers.push(`${item.episodeMediaPending} 个 Episode 缺少匹配视频`);
    if(item.issueCount)blockers.push(`${item.issueCount} 条未关闭质量问题`);
    if(item.annotationPending)blockers.push(`${item.annotationPending}/${item.episodeCount} 个 Episode 尚未完成标注`);
    return blockers;
  }
  async function updateBundleStatus(id,status){
    try{const response=await fetch('/api/bundles/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,status,note:status==='待验收'?'数据包已满足文件、质检和问题闭环门禁':status==='已验收'?'数据包验收签署完成':'数据包已归档'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'数据包验收状态更新失败');extWrite('embodiedBundles',data.bundles||[]);showToast(status==='待验收'?'数据包已提交验收':status==='已验收'?'数据包已验收通过':'数据包已归档');openHealthDetail()}catch(error){showToast(error.message)}}
  function openHealthDetail(){
    const snapshot=qualityHealthSnapshot(),packages=packageHealthRows(snapshot),box=document.getElementById('healthDetailDialog');if(!box)return;
    const state=snapshot.highIssues?'存在验收阻断':snapshot.openIssues.length?'存在待复核项':'质量门禁已通过',score=snapshot.average==null?'--':snapshot.average.toFixed(1),lastBatch=snapshot.batches[0];
    const typeRows=snapshot.byType.map(item=>`[tr][td]${typeBadge(item.type)}[/td][td]${item.total}[/td][td]${item.original}[/td][td]${item.qc}[/td][td]${item.average==null?'尚无评分':item.average.toFixed(1)}[/td][td]${item.passed}[/td][td]${item.openIssues}[/td][/tr]`).join('');
    const completePackages=packages.filter(item=>item.ready).length,packageRows=packages.length?packages.map(item=>{const action=item.status==='可提交验收'&&item.ready?`[button class="btn" data-bundle-status="待验收" data-bundle-id="${escapeHtml(item.id)}"]提交验收[/button]`:item.status==='待验收'?`[button class="btn primary" data-bundle-status="已验收" data-bundle-id="${escapeHtml(item.id)}"]签署验收[/button]`:item.status==='已验收'?`[button class="btn" data-bundle-status="已归档" data-bundle-id="${escapeHtml(item.id)}"]归档[/button]`:'[span style="color:#98a2b4"]—[/span]';return `[tr][td][b]${escapeHtml(item.name)}[/b][br][small]${escapeHtml(item.id)}[/small][/td][td]${typeBadge(item.type)}[/td][td]${item.files.length}[/td][td]${item.complete?'完整':'缺少分组'}[/td][td]${item.original}/${item.files.length}[/td][td]${item.qc}/${item.files.length}[/td][td]${item.issueCount}[/td][td]${statusBadge(item.status)}[/td][td]${action}[/td][/tr]`}).join(''):m('[tr][td colspan="9"][div class="empty-inline"]当前没有成组数据包，请从导入向导按组导入数据[/div][/td][/tr]');
    box.innerHTML=m(`
      [div class="search-box" style="width:min(900px,calc(100vw - 30px))"]
        [div class="popover-head"][span]质量健康度详情[/span][button class="close" id="healthDetailClose" title="关闭"][i data-lucide="x"][/i][/button][/div]
        [div style="padding:18px;max-height:72vh;overflow:auto"]
          [div class="ext-kpis"]
            [div class="ext-kpi"][span]综合质量分[/span][b]${score}[/b][small]仅统计已执行证据质检的资产[/small][/div]
            [div class="ext-kpi"][span]证据覆盖率[/span][b]${snapshot.evidenceRate.toFixed(1)}%[/b][small]${snapshot.withOriginal.length}/${snapshot.assets.length} 个资产保有原始文件[/small][/div]
            [div class="ext-kpi"][span]质检通过率[/span][b]${snapshot.passRate.toFixed(1)}%[/b][small]${snapshot.passed.length}/${snapshot.qcAssets.length} 个已检资产通过[/small][/div]
            [div class="ext-kpi"][span]未关闭问题[/span][b]${snapshot.openIssues.length}[/b][small]其中 ${snapshot.highIssues} 个高优先级阻断[/small][/div]
            [div class="ext-kpi"][span]数据包可验收率[/span][b]${packages.length?`${(completePackages/packages.length*100).toFixed(1)}%`:'--'}[/b][small]${completePackages}/${packages.length} 个数据包满足三组与质检门禁[/small][/div]
          [/div]
          [section style="margin-top:18px"]
            [div class="panel-head" style="padding:0 0 10px"][div][div class="panel-title"]当前判定：${state}[/div][div class="panel-sub"]数据来自服务端真实资产、原始文件、质检结果和问题单，不使用演示数据[/div][/div][/div]
            [div class="table-scroll"][table class="module-table ext-table"][thead][tr][th]数据类型[/th][th]资产数[/th][th]原始文件[/th][th]已质检[/th][th]平均分[/th][th]已通过[/th][th]未关闭问题[/th][/tr][/thead][tbody]${typeRows}[/tbody][/table][/div]
          [/section]
          [section style="margin-top:18px"]
            [div class="panel-head" style="padding:0 0 10px"][div][div class="panel-title"]数据包验收门禁</div][div class="panel-sub"]以 meta、data、video 三组为最小交付单元，全部原始文件已接入、质检完成且问题关闭后才可验收[/div][/div]
            [div class="table-scroll"][table class="module-table ext-table"][thead][tr][th]数据包[/th][th]类型[/th][th]文件数[/th][th]分组完整性[/th][th]原始文件[/th][th]已质检[/th][th]问题数[/th][th]状态[/th][th]操作[/th][/tr][/thead][tbody]${packageRows}[/tbody][/table][/div]
          [/section]
          [section style="margin-top:18px"]
            [div class="panel-title" style="font-size:12px;margin-bottom:10px"]验收覆盖[/div]
            [div class="metric"][div class="metric-line"][span]原始证据覆盖率[/span][b]${snapshot.evidenceRate.toFixed(1)}%[/b][/div][div class="progress"][i style="width:${snapshot.evidenceRate}%"][/i][/div][/div]
            [div class="metric" style="margin-top:12px"][div class="metric-line"][span]已质检资产通过率[/span][b]${snapshot.passRate.toFixed(1)}%[/b][/div][div class="progress"][i class="${snapshot.passRate<90?'warn':''}" style="width:${snapshot.passRate}%"][/i][/div][/div]
          [/section]
          [section style="margin-top:18px;padding-top:15px;border-top:1px solid rgba(120,150,190,.18)"][div class="panel-title" style="font-size:12px"]最近质检批次[/div][div class="panel-sub" style="margin-top:7px"]${lastBatch?`${escapeHtml(lastBatch.id)} · ${escapeHtml(lastBatch.template||'标准质检')} · 通过率 ${Number(lastBatch.passRate||0).toFixed(1)}% · ${escapeHtml(lastBatch.createdAt||lastBatch.time||'时间未知')}`:'尚未产生质检批次'}</div][/section]
        [/div]
        [div class="modal-foot"][button class="btn" id="healthDetailCancel"]关闭[/button][button class="btn primary" id="healthDetailQc"][i data-lucide="shield-check"][/i]前往质量检测中心[/button][/div]
      [/div]`);
    box.classList.add('show');lucide.createIcons();
    const close=()=>box.classList.remove('show');document.getElementById('healthDetailClose').onclick=close;document.getElementById('healthDetailCancel').onclick=close;document.getElementById('healthDetailQc').onclick=()=>{close();navigate('qc',document.querySelector('.nav button[data-page="qc"]'))};box.querySelectorAll('[data-bundle-status]').forEach(button=>button.onclick=()=>updateBundleStatus(button.dataset.bundleId,button.dataset.bundleStatus));box.querySelectorAll('tbody tr').forEach(row=>{const id=row.querySelector('small')?.textContent?.trim(),cell=row.lastElementChild;if(!id||!cell||cell.querySelector('[data-bundle-report]'))return;const button=document.createElement('button');button.className='btn';button.dataset.bundleReport=id;button.title='下载数据包验收报告';button.innerHTML='<i data-lucide="file-check-2"></i>报告';button.onclick=async()=>{button.disabled=true;try{const response=await fetch(`/api/bundles/${encodeURIComponent(id)}/report`,{cache:'no-store'});if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'验收报告生成失败')}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`${id}-acceptance-report.json`;link.click();URL.revokeObjectURL(url)}catch(error){showToast(error.message)}finally{button.disabled=false}};cell.appendChild(button)});lucide.createIcons();
  }
  function getEpisodes(){
    return getAssets().filter(asset=>asset.bundleRole==='trajectory'&&/episode_\d+\.parquet$/i.test(asset.relativePath||asset.name)).map(asset=>{
      const index=Number(/episode_(\d+)\.parquet$/i.exec(asset.relativePath||asset.name)[1]);
      return {id:`${asset.bundleId}:EP-${String(index).padStart(6,'0')}`,assetId:asset.id,bundleId:asset.bundleId,episodeIndex:index,type:asset.type,scene:asset.scene,task:asset.bundleName||asset.name,duration:'--',frames:asset.serverFile?.contentCheck?.recordCount??'--',score:asset.lastQcAt?asset.score:0,status:asset.status||'待质检'};
    });
  }
  function normalizeAsset(asset,index){
    const score=Number(asset.score||0),type=DATA_TYPES.includes(asset.type)?asset.type:'待确认';
    const normalizedStatus=type==='待确认'?'待确认类型':asset.status||(score?(score>=90?'已通过':'待复核'):'待质检');
    return {id:asset.id||'AST-'+String(index+1).padStart(4,'0'),name:asset.name,type,scene:asset.scene||'本地导入',format:asset.format||'RAW',size:asset.size||0,records:asset.records??'已接入',node:asset.node||'本地导入',taskId:asset.taskId||'',taskName:asset.taskName||'',model:asset.model||'未关联',qcTemplate:asset.qcTemplate||'标准质检',annotationStatus:asset.annotationStatus||'未标注',createdAt:asset.createdAt||nowLabel(),score,status:normalizedStatus,lastQcAt:asset.lastQcAt||'',inspection:asset.inspection||null,mediaMetadata:asset.mediaMetadata||null,bundleId:asset.bundleId||'',bundleName:asset.bundleName||'',bundlePreset:asset.bundlePreset||'',bundleRole:asset.bundleRole||'',bundleRoleLabel:asset.bundleRoleLabel||'',bundleFileIndex:asset.bundleFileIndex||0,bundleFileCount:asset.bundleFileCount||0,relativePath:asset.relativePath||asset.name||'',sourceRoot:asset.sourceRoot||'',sourceFolder:asset.sourceFolder||'',isDemo:Boolean(asset.isDemo),serverFile:asset.serverFile||null,serverManaged:Boolean(asset.serverManaged)};
  }
  function getAllAssets(){return extRead(storageKey.assets).map(normalizeAsset)}
  function getAssets(){return getAllAssets().filter(asset=>!asset.isDemo)}
  function findAsset(name){return getAssets().find(item=>item.name===name)}
  function daysFromNow(){return new Date().toLocaleString('zh-CN',{hour12:false})}
  function saveAssets(list){extWrite(storageKey.assets,list.map((item,index)=>normalizeAsset(item,index)))}
  function ensureAssets(){
    const existing=getAssets();
    if(!existing.length)saveAssets([]);
    localStorage.setItem('embodiedAssetsSeeded','production-disabled');
  }
  function getModels(){const assets=getAssets();return [...new Set(assets.map(asset=>asset.model).filter(model=>model&&model!=='未关联'))].map(id=>({id,type:assets.find(asset=>asset.model===id)?.type||'待确认'}))}
  function modelOf(name){return getModels().find(model=>model.id===name)}
  function installNavigation(){
    Object.assign(pageNames,{workflow:['生产批次','围绕一个批次完成导入、自动质检、问题处理、验收和交付。'],qc:['质量检测中心','选择检测范围与规则模板，执行质检并查看报告与问题明细。'],runs:['运行记录','查看每次质检运行的证据摘要。'],episodes:['Episode 浏览','查看轨迹、对应视频、质检状态和标注。'],annotation:['标注与审核','逐个 Episode 标注，审核结果参与交付门禁。'],exports:['导出与交付','生成原始文件引用清单、质检证据和标注 JSONL。'],nodes:['采集节点','查看已登记节点的连接状态、容量和版本。'],audit:['审计日志','追踪数据、规则、审核和导出操作。']});
    pageNames.overview=['质量总览','查看 UMI、EGO、遥操资产的质检证据、问题与批次进度。'];
    const make=(page,icon,label)=>{const button=document.createElement('button');button.dataset.page=page;button.innerHTML=m(`[i data-lucide="${icon}"][/i][span]${label}[/span]`);button.onclick=()=>navigate(page,button);return button};
    const primary=document.querySelectorAll('.nav')[0];
    primary.insertBefore(make('workflow','route','生产批次'),primary.children[1]);
    const qcButton=make('qc','shield-check','质量检测中心');
    primary.insertBefore(qcButton,primary.children[3]);
    primary.append(make('episodes','gallery-horizontal-end','Episode 浏览'),make('annotation','scan-search','标注与审核'),make('exports','package-check','导出与交付'),make('runs','list-tree','运行记录'));
    const admin=document.querySelectorAll('.nav')[1];
    admin.insertBefore(make('nodes','radio-tower','采集节点'),admin.children[1]);
    admin.insertBefore(make('audit','scroll-text','审计日志'),admin.lastElementChild);
  }
  function navigate(key,button){
    const required=PAGE_ACCESS[key]||[];
    if(authUser&&required.length&&!can(...required)){showToast('当前角色无权访问该模块');key='overview';button=document.querySelector('.nav button[data-page="overview"]')}
    document.querySelectorAll('.nav button').forEach(item=>item.classList.remove('active'));
    if(button)button.classList.add('active');
    const page=pageNames[key]||pageNames.overview;
    document.getElementById('pageTitle').textContent=page[0];
    document.getElementById('crumbCurrent').textContent=page[0];
    document.getElementById('pageDesc').textContent=page[1];
    showPage(key);
  }
  function workflowStages(selected,assets,openIssues,batches,exportsList,accepted,delivered){
    const episodes=assets.filter(asset=>asset.bundleRole==='trajectory'&&/episode_\d+\.parquet$/i.test(asset.relativePath||asset.name)),episodeIds=new Set(episodes.map(asset=>asset.id)),annotations=extRead('embodiedAnnotations',[]).filter(item=>episodeIds.has(item.assetId)),approved=episodes.filter(asset=>annotations.some(item=>item.assetId===asset.id&&item.status==='已通过'&&String(item.instruction||'').trim()&&['success','failure'].includes(item.outcome))).length;
    const cleanCount=assets.filter(asset=>asset.serverFile&&asset.inspection?.empty!==true&&asset.serverFile.contentCheck?.valid!==false&&asset.serverFile.deepCheck?.status!=='invalid').length;
    const assetIds=new Set(assets.map(asset=>asset.id));
    const cleanDone=assets.length>0&&cleanCount===assets.length, qcDone=assets.length>0&&assets.every(item=>item.lastQcAt), annotationDone=episodes.length>0&&approved===episodes.length, issueDone=qcDone&&openIssues.length===0&&annotationDone, issueAction=openIssues.length?'issues':annotationDone?'issues':'annotation', latestBatch=batches.find(batch=>Array.isArray(batch.targetIds)&&batch.targetIds.some(id=>assetIds.has(id))), latestExport=exportsList.find(job=>selected&&String(job.name||'').startsWith(String(selected.name||'')));
    return [
      {key:'import',label:'导入批次',done:assets.length>0,detail:assets.length?`${assets.length} 个资产已入库`:'等待选择总文件夹',action:'import'},
      {key:'qc',label:'自动质检',done:qcDone,detail:latestBatch?`${latestBatch.id} · 通过率 ${latestBatch.passRate}% · 基础检查 ${cleanCount}/${assets.length}`:`基础检查 ${cleanCount}/${assets.length}，等待执行证据质检`,action:'qc'},
      {key:'annotation',label:'Episode 标注',done:annotationDone,detail:!qcDone?'质检完成后生成 Episode 标注队列':episodes.length?`${approved}/${episodes.length} 个 Episode 已审核`:selected?'未识别 Episode 轨迹':'等待导入数据包',action:'annotation'},
      {key:'issues',label:'问题处理',done:issueDone,detail:!qcDone?'质检完成后生成问题单':openIssues.length?`${openIssues.length} 条问题未关闭`:annotationDone?'无未关闭问题':'等待 Episode 标注完成',action:issueAction},
      {key:'accept',label:'批次验收',done:accepted,detail:accepted?'已签署验收':selected?.status==='待验收'?'等待负责人签署':selected&&!selected.ready?`仍有 ${bundleBlockers(selected).length} 项门禁未满足`:'问题清零后提交验收',action:'accept'},
      {key:'deliver',label:'交付',done:delivered,detail:delivered?'已有交付记录':latestExport?'已生成交付 Manifest，等待打包':'验收后生成可追溯交付包',action:'exports'},
    ];
  }
  function workflowTemplate(){
    const snapshot=qualityHealthSnapshot(),packages=packageHealthRows(snapshot),batches=extRead('embodiedQcBatches',[]),exportsList=extRead('embodiedExports',[]),latestAsset=[...snapshot.assets].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))[0];
    if(!activeWorkflowBundleId&&packages[0])activeWorkflowBundleId=packages[0].id;
    const selected=packages.find(item=>item.id===activeWorkflowBundleId)||packages[0]||null,assets=selected?selected.files:snapshot.assets,openIssues=selected?snapshot.openIssues.filter(issue=>assets.some(asset=>asset.id===issue.assetId)):snapshot.openIssues,annotationPending=selected?.annotationPending||0,qcDone=assets.length>0&&assets.every(item=>item.lastQcAt),ready=Boolean(selected?.ready),accepted=selected?.status==='已验收',delivered=exportsList.some(job=>selected&&String(job.name||'').startsWith(String(selected.name||''))),typeSummary=['UMI','EGO','遥操'].map(type=>`${type} ${assets.filter(item=>item.type===type).length}`).join(' · '),batchName=selected?.name||latestAsset?.scene||'尚未导入生产批次',stages=workflowStages(selected,assets,openIssues,batches,exportsList,accepted,delivered),latestBatch=batches.find(batch=>Array.isArray(batch.targetIds)&&batch.targetIds.some(id=>assets.some(asset=>asset.id===id))),latestExport=exportsList.find(job=>selected&&String(job.name||'').startsWith(String(selected.name||''))),roleSummary=selected?.roles instanceof Set?[...selected.roles].join(' / '):Array.isArray(selected?.roles)?selected.roles.join(' / '):String(selected?.roles||''),blockers=selected?bundleBlockers(selected):['请先导入一个完整数据包'];
    if(selected?.roles instanceof Set) selected.roles=[...selected.roles];
     const firstPending=stages.find(stage=>!stage.done)||stages[stages.length-1],actionText=firstPending.key==='import'?'导入总文件夹':firstPending.key==='qc'?'运行自动质检':firstPending.action==='annotation'?'进入标注审核':firstPending.key==='issues'?'处理问题':firstPending.key==='accept'?(selected?.status==='待验收'?'签署批次验收':selected&&!selected.ready?'完成门禁':'提交批次验收'):firstPending.action==='assets'?'查看数据资产':'生成交付包';
    const batchOptions=packages.map(item=>`[option value="${escapeHtml(item.id)}"${item.id===selected?.id?' selected':''}]${escapeHtml(item.name)} · ${escapeHtml(item.status)} · ${item.files.length} 个文件[/option]`).join('');
    return m(`
       [div class="ext-kpis"][div class="ext-kpi"][span]当前生产批次[/span][b style="font-size:18px"]${escapeHtml(batchName)}[/b][small]${escapeHtml(typeSummary||'尚未导入数据')}[/small][/div][div class="ext-kpi"][span]批次资产[/span][b]${assets.length}[/b][small]${selected?'已按批次隔离':'全部生产资产'}[/small][/div][div class="ext-kpi"][span]待处理事项[/span][b class="${openIssues.length||annotationPending?'danger':''}">${openIssues.length+annotationPending}[/b][small]${openIssues.length?`${openIssues.length} 条问题待处置`:annotationPending?`${annotationPending} 条标注待审核`:'质量门禁无阻断'}</small][/div][div class="ext-kpi"][span]批次状态[/span][b]${accepted?'已验收':selected?.status||'待导入'}[/b][small]${delivered?'已有交付记录':'状态由服务端门禁计算'}[/small][/div][/div]
      [section class="panel workflow-panel"][div class="panel-head"][div][div class="panel-title"]生产批次工作台</div][div class="panel-sub"]当前页面直接执行批次动作；系统会自动保存质检、验收和交付结果。</div][/div][/div]
        [div class="workflow-toolbar"][label]当前批次[/label][select class="select" id="workflowBatchSelect" ${packages.length?'':'disabled'}][option value=""]${packages.length?'选择一个数据包':'尚无可选数据包，请先导入总文件夹'}[/option]${batchOptions}[/select][button class="btn" id="workflowRefresh" type="button"][i data-lucide="refresh-cw"][/i]刷新状态[/button][/div]
        [div class="workflow-steps"]${stages.map((stage,index)=>`[button class="workflow-step ${stage.done?'done':''} ${stage.key===firstPending.key?'current':''}" data-workflow-action="${stage.action}" type="button"][span class="workflow-index"]${stage.done?'✓':index+1}[/span][span][b]${stage.label}[/b][small]${stage.detail}[/small][/span][i data-lucide="chevron-right"][/i][/button]`).join('')}[/div]
        [div class="workflow-blockers"][div][span class="eyebrow"]当前门禁${blockers.length?'未通过':'已通过'}</span][b]${blockers.length?escapeHtml(blockers.join(' · ')):'文件、质检、问题与审核均已满足'}</b][/div][div class="row-actions"][button class="btn" id="workflowRecheckIssues" type="button"${openIssues.length?'':' disabled'}][i data-lucide="scan-search"][/i]复检问题${openIssues.length?`（${openIssues.length}）`:''}[/button][button class="btn" id="workflowDeepCheck" type="button"${openIssues.filter(issue=>issue.metric==='语义深度解析').length?'':' disabled'}][i data-lucide="file-check-2"][/i]深度校验[/button][/div][/div]
        [div class="workflow-next"][div][span class="eyebrow"]${blockers.length?'当前门禁阻断':'下一步建议'}</span][b]${firstPending.label}</b><small>${blockers.length?escapeHtml(blockers.join('；')):firstPending.detail}</small>[/div][div style="display:flex;gap:8px;flex-wrap:wrap"][button class="btn primary" data-workflow-action="${firstPending.action}" type="button"${blockers.length?' disabled':''}][i data-lucide="arrow-right"][/i]${actionText}[/button][button class="btn" data-workflow-action="issues" type="button"][i data-lucide="triangle-alert"][/i]查看问题[/button][/div][/div]
      [section class="panel workflow-lineage"][div class="panel-head"][div][div class="panel-title"]批次证据链</div][div class="panel-sub"]输入、处理结果、版本和交付证据绑定到同一个批次，可从运行记录复现。</div][/div][/div][div class="lineage-grid"][div class="lineage-item"][span]输入快照[/span][b]${escapeHtml(selected?.id||'--')} · ${assets.length} 个资产[/b][small]${escapeHtml((selected?.roles||[]).join(' / ')||'等待分组')}[/small][/div][div class="lineage-item"][span]清洗 / 筛选[/span][b]${assets.filter(asset=>asset.inspection&&asset.serverFile).length}/${assets.length} 通过基础检查</b][small]${openIssues.length?'仍有问题需要处置':'当前没有未关闭问题'}</small][/div][div class="lineage-item"][span]质检运行[/span][b]${escapeHtml(latestBatch?.id||'尚未执行')}</b][small]${latestBatch?`通过率 ${latestBatch.passRate}% · ${latestBatch.issueCount} 个问题`:'执行后生成不可变运行快照'}</small][/div][div class="lineage-item"][span]交付产物[/span][b]${escapeHtml(latestExport?.id||'尚未生成')}</b][small]${accepted?'批次已验收，可生成当前有效交付':'验收通过后才允许交付'}</small][/div][/div][/section]
      [/section]
      [section class="panel"][div class="panel-head"][div][div class="panel-title"]批次门禁明细</div][div class="panel-sub"]原始文件、三组分区、证据质检和问题闭环共同决定能否验收。</div][/div][/div][div class="detail-grid"][div class="detail-card"][span]数据类型[/span][b]${escapeHtml(typeSummary||'待识别')}[/b][/div][div class="detail-card"][span]原始文件[/span][b]${selected?`${selected.original}/${selected.files.length}`:`${snapshot.withOriginal.length}/${snapshot.assets.length}`}[/b][/div][div class="detail-card"][span]已质检[/span][b]${selected?`${selected.qc}/${selected.files.length}`:`${snapshot.qcAssets.length}/${snapshot.assets.length}`}[/b][/div][div class="detail-card"][span]三组完整性[/span][b]${selected?(selected.complete?'已完整':'缺少分组'):'待导入'}</b></div][div class="detail-card"][span]质检批次[/span][b]${batches.length||'--'}[/b][/div][div class="detail-card"][span]最近导入[/span][b]${escapeHtml(latestAsset?.createdAt||'--')}[/b][/div][/div][/section>`);
  }
  async function workflowQc(){const snapshot=qualityHealthSnapshot(),packages=packageHealthRows(snapshot),selected=packages.find(item=>item.id===activeWorkflowBundleId),targets=selected?.files||[],ids=targets.filter(item=>item.serverFile&&!item.lastQcAt).map(item=>item.id);if(!targets.length){showToast('请先导入一个生产批次');return}if(!ids.length){showToast('当前批次已全部执行质检；可重新质检来验证修复结果');return}try{const batch=await createQcBatch('当前生产批次','标准质检','全部模型',ids);if(batch){await syncServerState();moduleTemplates.workflow=workflowTemplate();showPage('workflow');showToast(`当前批次质检完成：通过率 ${batch.passRate}%，发现 ${batch.issueCount} 个问题`)} }catch(error){showToast(error.message)}}
  async function workflowDeepCheck(){const snapshot=qualityHealthSnapshot(),item=packageHealthRows(snapshot).find(row=>row.id===activeWorkflowBundleId),deep=snapshot.openIssues.filter(issue=>item?.files.some(asset=>asset.id===issue.assetId)&&issue.metric==='语义深度解析'),assetIds=[...new Set(deep.map(issue=>issue.assetId))];if(!assetIds.length){showToast('当前批次没有待执行的 LeRobot 深度校验');return}const button=document.getElementById('workflowDeepCheck');if(button)button.disabled=true;try{const response=await fetch('/api/assets/lerobot-deep-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetIds,template:'标准质检'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'LeRobot 深度校验失败');if(data.assets)saveAssets(data.assets);extWrite('embodiedIssues',data.issues||[]);if(data.batch)extWrite('embodiedQcBatches',[data.batch,...extRead('embodiedQcBatches',[]).filter(row=>row.id!==data.batch.id)].slice(0,100));extWrite('embodiedRuns',data.runs||extRead('embodiedRuns',[]));await syncServerState();moduleTemplates.workflow=workflowTemplate();showPage('workflow');const pluginSummary=(data.embodied||[]).map(report=>`${report.detection?.format||'dataset'} ${report.info?.episodes??'?'} Episode · ${report.validation?.score??'?'} 分`).join('；');showToast(`深度校验完成：解析 ${assetIds.length} 个 Parquet${pluginSummary?`；Embodied Data：${pluginSummary}`:''}，当前仍有 ${(data.issues||[]).filter(issue=>deep.some(item=>item.id===issue.id)).length} 条相关问题`)}catch(error){showToast(error.message)}finally{if(button)button.disabled=false}}
  async function workflowAcceptance(){const snapshot=qualityHealthSnapshot(),item=packageHealthRows(snapshot).find(row=>row.id===activeWorkflowBundleId);if(!item){showToast('请先选择一个已导入的数据包');return}const next=item.status==='待验收'?'已验收':'待验收';if(next==='待验收'&&!item.ready){showToast(`当前批次尚未达到验收门禁：${bundleBlockers(item).join('；')}`);return}try{const response=await fetch('/api/bundles/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,status:next,note:next==='已验收'?'生产批次工作台签署验收':'生产批次工作台提交验收'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'批次验收状态更新失败');extWrite('embodiedBundles',data.bundles||[]);await syncServerState();moduleTemplates.workflow=workflowTemplate();showPage('workflow');showToast(next==='已验收'?'批次验收已签署':'批次已提交验收，等待负责人签署')}catch(error){showToast(error.message)}}
  async function workflowExport(){const snapshot=qualityHealthSnapshot(),item=packageHealthRows(snapshot).find(row=>row.id===activeWorkflowBundleId),name=`${item?.name||'Embodied-Quality'}-交付-${new Date().toISOString().slice(0,10)}`,assetIds=item?.files.map(asset=>asset.id);try{const response=await fetch('/api/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,assetIds,format:'LeRobot',contents:['原始文件','质量报告','标注清单'],user:authUser?.name||'当前用户'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'交付清单生成失败');extWrite('embodiedExports',data.exports||[]);await syncServerState();moduleTemplates.workflow=workflowTemplate();showPage('workflow');showToast(`当前批次交付 Manifest 已生成：${data.job.id}`)}catch(error){showToast(error.message)}}
  function bindWorkflow(){
    const select=document.getElementById('workflowBatchSelect');if(select)select.onchange=()=>{activeWorkflowBundleId=select.value;moduleTemplates.workflow=workflowTemplate();showPage('workflow')};
    document.querySelectorAll('[data-workflow-action]').forEach(button=>button.onclick=async()=>{const key=button.dataset.workflowAction;button.disabled=true;try{if(key==='import'){startImportWizard();return}if(key==='qc'){await workflowQc();return}if(key==='accept'){await workflowAcceptance();return}if(key==='exports'){await workflowExport();return}if(key==='assets'){navigate('assets',document.querySelector('.nav button[data-page="assets"]'));return}if(key==='annotation'){navigate('annotation',document.querySelector('.nav button[data-page="annotation"]'));return}navigate('issues',document.querySelector('.nav button[data-page="issues"]'))}finally{button.disabled=false}});
    const refresh=document.getElementById('workflowRefresh');if(refresh)refresh.onclick=async()=>{refresh.disabled=true;await syncServerState();moduleTemplates.workflow=workflowTemplate();showPage('workflow');showToast('批次状态已从服务端刷新');refresh.disabled=false};
    const recheck=document.getElementById('workflowRecheckIssues');if(recheck)recheck.onclick=async()=>{const snapshot=qualityHealthSnapshot(),selected=packageHealthRows(snapshot).find(row=>row.id===activeWorkflowBundleId),ids=snapshot.openIssues.filter(issue=>selected?.files.some(asset=>asset.id===issue.assetId)).map(issue=>issue.id);if(!ids.length)return;await recheckIssues(ids,recheck);await syncServerState();moduleTemplates.workflow=workflowTemplate();showPage('workflow')};
    const deepCheck=document.getElementById('workflowDeepCheck');if(deepCheck)deepCheck.onclick=workflowDeepCheck;
  }
  function episodeTemplate(){const episodes=getEpisodes(),playable=episodes.filter(item=>getAssets().some(asset=>asset.bundleId===item.bundleId&&asset.bundleRole==='media'&&new RegExp(`episode_0*${item.episodeIndex}(?:\\D|$)`,'i').test(asset.relativePath||asset.name)&&asset.serverFile)).length,pending=episodes.filter(item=>['待深检','待复核','待质检'].includes(item.status)).length,blocked=episodes.filter(item=>item.status!=='已通过').length;return m(`
    [div class="ext-kpis"]
      [div class="ext-kpi"][span]已登记 Episode[/span][b]${episodes.length}[/b][small]已排除演示资产[/small][/div]
      [div class="ext-kpi"][span]可播放视频[/span][b]${playable}[/b][small]原始视频已存入服务端[/small][/div]
      [div class="ext-kpi"][span]待人工复核[/span][b]${pending}[/b][small]待深检、待复核或待质检[/small][/div]
      [div class="ext-kpi"][span]质量门禁拦截[/span][b]${blocked}[/b][small]待补传或存在高优先级问题[/small][/div]
    [/div]
    [section class="panel"]
      [div class="panel-head"][div][div class="panel-title"]Episode 与轨迹浏览[/div][div class="panel-sub"]查看真实轨迹、对应视频和已有质检证据[/div][/div][button class="btn primary" id="runQcBtn"][i data-lucide="play-circle"][/i]运行批量质检[/button][/div]
      [div class="ext-toolbar"]
        [div class="search"][i data-lucide="search"][/i][input id="episodeSearch" placeholder="搜索 Episode、场景或任务" /][/div]
        [select class="filter-select" id="episodeType"][option value="all"]全部类型[/option][option]UMI[/option][option]EGO[/option][option]遥操[/option][/select]
        [select class="filter-select" id="episodeStatus"][option value="all"]全部状态[/option][option]已通过[/option][option]待深检[/option][option]待补传[/option][option]问题[/option][option]待质检[/option][/select]
        [span class="spacer"][/span][button class="btn" id="episodeExport"][i data-lucide="download"][/i]导出筛选结果[/button]
      [/div]
      [div class="table-scroll"][table class="module-table ext-table"][thead][tr][th]Episode[/th][th]类型[/th][th]场景 / 任务[/th][th]时长[/th][th]帧数[/th][th]质量分[/th][th]状态[/th][/tr][/thead][tbody id="episodeRows"][/tbody][/table][/div]
    [/section]`)}
  function renderEpisodeRows(){
    const body=document.getElementById('episodeRows');if(!body)return;
    const query=(document.getElementById('episodeSearch')?.value||'').toLowerCase(),type=document.getElementById('episodeType')?.value||'all',status=document.getElementById('episodeStatus')?.value||'all';
    const rows=getEpisodes().filter(ep=>(type==='all'||ep.type===type)&&(status==='all'||ep.status===status)&&(`${ep.id} ${ep.scene} ${ep.task}`.toLowerCase().includes(query)));
    body.innerHTML=rows.length?rows.map(ep=>m(`[tr data-id="${escapeHtml(ep.id)}"][td]${escapeHtml(ep.id)}[/td][td]${typeBadge(ep.type)}[/td][td][b]${escapeHtml(ep.scene)}[/b][br][small]${escapeHtml(ep.task)}[/small][/td][td]${ep.duration}[/td][td]${escapeHtml(ep.frames)}[/td][td][span class="quality-score ${scoreClass(ep.score)}"]${ep.score?ep.score.toFixed(1):'--'}[/span][/td][td]${statusBadge(ep.status)}[/td][/tr]`)).join(''):m('[tr][td colspan="7"][div class="empty-inline"]没有符合条件的 Episode[/div][/td][/tr]');
    body.querySelectorAll('tr[data-id]').forEach(row=>row.onclick=()=>openEpisode(row.dataset.id));
  }
  function bindEpisodes(){
    renderEpisodeRows();
    ['episodeSearch','episodeType','episodeStatus'].forEach(id=>document.getElementById(id).addEventListener(id==='episodeSearch'?'input':'change',renderEpisodeRows));
    document.getElementById('runQcBtn').onclick=runQualityChecks;
    document.getElementById('episodeExport').onclick=()=>downloadCsv('episode-filter.csv',getEpisodes().map(ep=>({Episode:ep.id,类型:ep.type,场景:ep.scene,任务:ep.task,质量分:ep.score,状态:ep.status})));
  }
  function evalAsset(){throw new Error('本地模拟质检已停用，请使用服务端证据型质检')}
  function qcTargets(scope,model,targetIds){
    let list=getAssets();
    if(Array.isArray(targetIds))list=list.filter(asset=>targetIds.includes(asset.id));
    if(scope==='待质检数据')list=list.filter(asset=>asset.type!=='待确认'&&(!asset.score||asset.status==='待质检'));
    if(scope==='UMI 数据'||scope==='EGO 数据'||scope==='遥操 数据'){const want=scope.split(' ')[0];list=list.filter(asset=>asset.type===want)}
    if(scope==='未关联模型的数据')list=list.filter(asset=>!asset.model||asset.model==='未关联');
    if(model&&model!=='全部模型')list=list.filter(asset=>asset.model===model);
    return list;
  }
  async function createQcBatch(scope,template,model,targetIds){
    const response=await fetch('/api/qc/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope,template,model,targetIds})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'服务端质检失败');
    if(!data.batch?.total)return null;
    saveAssets(data.assets||getAssets());const batches=extRead('embodiedQcBatches').filter(item=>item.id!==data.batch.id);batches.unshift(data.batch);extWrite('embodiedQcBatches',batches.slice(0,100));extWrite('embodiedRuns',data.runs||extRead('embodiedRuns',[]));extWrite('embodiedIssues',data.issues||[]);updateProductionIndicators();updateRulesOverview();return data.batch;
  }
  async function runQualityChecks(){
    const button=document.getElementById('runQcBtn');
    const targets=qcTargets('待质检数据','全部模型');
    if(!targets.length){showToast('当前没有待质检数据，可前往质量检测中心检测全部数据');return}
    button.disabled=true;button.textContent='正在执行质检…';
    try{const batch=await createQcBatch('待质检数据','标准质检','全部模型');if(!batch){showToast('当前没有待质检数据');return}renderEpisodeRows();showToast(`证据型质检完成：通过 ${batch.passRate}%，发现 ${batch.issueCount} 个问题`)}catch(error){showToast(error.message)}finally{button.disabled=false;button.innerHTML=m('[i data-lucide="play-circle"][/i]运行批量质检');lucide.createIcons()}
  }
  function openEpisode(id){
    const ep=getEpisodes().find(item=>item.id===id);if(!ep)return;
    const assets=getAssets(),trajectory=assets.find(item=>item.id===ep.assetId),videos=assets.filter(item=>item.bundleId===ep.bundleId&&item.bundleRole==='media'&&new RegExp(`episode_0*${ep.episodeIndex}(?:\\D|$)`,'i').test(item.relativePath||item.name)&&item.serverFile),video=videos[0];
    const annotations=extRead('embodiedAnnotations',[]),annotation=annotations.find(item=>item.assetId===ep.assetId),issues=extRead('embodiedIssues',[]).filter(item=>item.assetId===ep.assetId&&item.status!=='已关闭');
    const media=video?`[div][select class="filter-select" id="episodeVideoSelect" aria-label="视频机位" style="margin:8px"]${videos.map(item=>`[option value="${escapeHtml(item.id)}"]${escapeHtml(item.relativePath||item.name)}[/option]`).join('')}[/select][video id="episodeVideo" class="episode-video" controls preload="metadata" playsinline src="/api/assets/${encodeURIComponent(video.id)}/media"][/video][/div]`:`[div class="episode-media-empty"][i data-lucide="video-off"][/i][b]未找到同编号视频[/b][small]请检查 video 文件夹与 Episode 编号[/small][/div]`;
    const dialog=document.getElementById('episodeDialog');dialog.innerHTML=m(`[div class="search-box" style="width:min(920px,calc(100vw - 30px))"][div class="popover-head"][span]${escapeHtml(ep.id)}[/span][button class="close" data-close-dialog][i data-lucide="x"][/i][/button][/div][div style="padding:17px;max-height:76vh;overflow:auto"][div class="viewer" style="min-height:280px"]${media}[/div][div class="detail-grid" style="margin-top:16px"][div class="detail-card"][span]轨迹文件[/span][b]${escapeHtml(trajectory?.relativePath||'--')}[/b][/div][div class="detail-card"][span]视频文件[/span][b]${escapeHtml(video?.relativePath||'缺失')}[/b][/div][div class="detail-card"][span]质检状态[/span][b]${escapeHtml(ep.status)}[/b][/div][div class="detail-card"][span]标注状态[/span][b]${escapeHtml(annotation?.status||'未生成')}[/b][/div][div class="detail-card"][span]未关闭问题[/span][b]${issues.length}[/b][/div][/div][/div][div class="modal-foot"][button class="btn" data-episode-export]导出明细[/button][button class="btn primary" data-episode-annotation]前往标注[/button][/div][/div]`);dialog.classList.add('show');lucide.createIcons();
    dialog.querySelector('[data-close-dialog]').onclick=()=>dialog.classList.remove('show');dialog.querySelector('[data-episode-export]').onclick=()=>downloadJson(`${ep.id.replace(/[^a-z0-9_-]/gi,'_')}.json`,{episode:ep,trajectory:trajectory?.relativePath||null,videos:videos.map(item=>item.relativePath||item.name),annotation:annotation||null,openIssues:issues});dialog.querySelector('[data-episode-annotation]').onclick=()=>{dialog.classList.remove('show');activeAnnotationId=annotation?.id||'';navigate('annotation',document.querySelector('.nav button[data-page="annotation"]'))};
    const videoSelect=dialog.querySelector('#episodeVideoSelect');if(videoSelect)videoSelect.onchange=()=>{const player=dialog.querySelector('#episodeVideo');player.src=`/api/assets/${encodeURIComponent(videoSelect.value)}/media`;player.load();dialog.querySelector('.detail-card:nth-child(2) b').textContent=videos.find(item=>item.id===videoSelect.value)?.relativePath||'--'};
  }
  function annotationTemplate(){
    const list=extRead('embodiedAnnotations',[]),selected=list.find(item=>item.id===activeAnnotationId)||list[0];activeAnnotationId=selected?.id||'';
    const generate=`[button class="btn" id="generateAnnotations"][i data-lucide="refresh-cw"][/i]同步 Episode[/button]`;
    if(!selected)return m(`[section class="panel"][div class="panel-head"][div][div class="panel-title"]Episode 标注[/div][div class="panel-sub"]质检完成后生成真实 Episode 任务[/div][/div]${generate}[/div][div class="empty-inline" style="padding:48px"]暂无标注任务[/div][/section]`);
    const assets=getAssets(),trajectory=assets.find(item=>item.id===selected.assetId),videos=assets.filter(item=>item.bundleId===selected.bundleId&&item.bundleRole==='media'&&new RegExp(`episode_0*${selected.episodeIndex}(?:\\D|$)`,'i').test(item.relativePath||item.name));
    const preview=videos.length?`[div][select class="filter-select" id="annotationVideoSelect" aria-label="视频机位" style="margin:8px"]${videos.map(item=>`[option value="${escapeHtml(item.id)}"]${escapeHtml(item.relativePath||item.name)}[/option]`).join('')}[/select][video id="annotationVideo" class="episode-video" controls preload="metadata" playsinline src="/api/assets/${encodeURIComponent(videos[0].id)}/media"][/video][/div]`:`[div class="episode-media-empty"][i data-lucide="video-off"][/i][b]该 Episode 暂无匹配视频[/b][small]检查 video 文件名中的 episode 编号[/small][/div]`;
    const segments=(selected.segments||[]).map(item=>`${item.startFrame},${item.endFrame},${item.skill},${item.object||''}`).join('\n');
    return m(`[div class="review-layout"][section class="panel"][div class="panel-head"][div][div class="panel-title"]${escapeHtml(selected.title)}[/div][div class="panel-sub"]${escapeHtml(selected.id)} · ${escapeHtml(selected.status)} · ${escapeHtml(trajectory?.relativePath||'轨迹缺失')}[/div][/div][/div][div style="padding:0 18px 16px"][div class="viewer" style="min-height:280px"]${preview}[/div][/div][div class="ext-form"][label for="annotationInstruction"]任务指令[/label][textarea id="annotationInstruction" placeholder="描述本次任务的实际目标"]${escapeHtml(selected.instruction||'')}[/textarea][div class="form-row"][div][label for="annotationOutcome"]执行结果[/label][select id="annotationOutcome"][option value=""]未判定[/option][option value="success" ${selected.outcome==='success'?'selected':''}]成功[/option][option value="failure" ${selected.outcome==='failure'?'selected':''}]失败[/option][/select][/div][div][label for="annotationAssignee"]标注负责人[/label][input id="annotationAssignee" class="input" value="${escapeHtml(selected.assignee==='未分配'?'':selected.assignee||'')}" /][/div][/div][label for="annotationSegments"]动作分段（每行：开始帧,结束帧,技能,对象）[/label][textarea id="annotationSegments" placeholder="0,120,抓取,线缆"]${escapeHtml(segments)}[/textarea][label for="reviewNote"]审核意见[/label][textarea id="reviewNote"]${escapeHtml(selected.note||'')}[/textarea][div class="modal-foot" style="padding:13px 0 0"][button class="btn" id="saveAnnotation"]保存草稿[/button][button class="btn danger" id="rejectAnnotation"]退回修改[/button][button class="btn success" id="approveAnnotation"]审核通过[/button][/div][/div][/section][section class="panel"][div class="panel-head"][div][div class="panel-title"]Episode 队列[/div][div class="panel-sub"]${list.length} 个真实任务[/div][/div]${generate}[/div][div class="annotation-list"]${list.map(item=>annotationCard(item,selected.id)).join('')}[/div][/section][/div]`);
  }
  function annotationCard(item,selectedId){return `[div class="annotation-card ${item.id===selectedId?'active':''}" data-annotation-id="${item.id}"][div][b]${escapeHtml(item.title)}[/b][p]${item.episode} · ${item.assignee} · ${item.progress}%[/p][/div]${statusBadge(item.status)}[/div]`}
  function bindAnnotation(){
    const videoSelect=document.getElementById('annotationVideoSelect');if(videoSelect)videoSelect.onchange=()=>{const player=document.getElementById('annotationVideo');player.src=`/api/assets/${encodeURIComponent(videoSelect.value)}/media`;player.load()};
    const confirmInstruction=()=>{const instruction=document.getElementById('annotationInstruction').value.trim();if(!instruction){showToast('请填写该 Episode 的真实任务指令');return false}return true};
    document.querySelectorAll('[data-annotation-id]').forEach(card=>card.onclick=()=>{activeAnnotationId=card.dataset.annotationId;moduleTemplates.annotation=annotationTemplate();showPage('annotation')});
    const generate=document.getElementById('generateAnnotations');if(generate)generate.onclick=async()=>{generate.disabled=true;try{const response=await fetch('/api/annotations/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:authUser?.name||'当前用户'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'生成任务失败');extWrite('embodiedAnnotations',data.annotations||[]);activeAnnotationId=data.annotations?.[0]?.id||'';moduleTemplates.annotation=annotationTemplate();showPage('annotation');showToast(data.created?`已生成 ${data.created} 个 Episode 标注任务`:'没有新增的已完成质检 Episode')}catch(error){showToast(error.message)}finally{generate.disabled=false}};
    document.querySelectorAll('[data-annotation-main]').forEach(card=>card.onclick=()=>{activeAnnotationId=card.dataset.annotationId;moduleTemplates.annotation=annotationTemplate();showPage('annotation')});
    const selected=extRead('embodiedAnnotations',[]).find(item=>item.id===activeAnnotationId);if(!selected)return;
    document.getElementById('approveAnnotation').onclick=()=>{if(confirmInstruction())updateAnnotation(selected.id,'已通过')};
    document.getElementById('rejectAnnotation').onclick=()=>updateAnnotation(selected.id,'已驳回');
    const save=document.getElementById('saveAnnotation');if(save)save.onclick=()=>{if(confirmInstruction())updateAnnotation(selected.id,selected.status)};
  }
  async function updateAnnotation(id,status){
    const instruction=document.getElementById('annotationInstruction').value.trim(),outcome=document.getElementById('annotationOutcome').value,assignee=document.getElementById('annotationAssignee').value.trim(),note=document.getElementById('reviewNote').value.trim();
    const segments=document.getElementById('annotationSegments').value.split(/\r?\n/).map(row=>row.trim()).filter(Boolean).map(row=>{const [startFrame,endFrame,skill,object='']=row.split(',').map(value=>value.trim());return {startFrame:Number(startFrame),endFrame:Number(endFrame),skill,object}});
    const buttons=['approveAnnotation','rejectAnnotation','saveAnnotation'].map(id=>document.getElementById(id)).filter(Boolean);buttons.forEach(button=>button.disabled=true);
    try{const response=await fetch('/api/annotations/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,status,instruction,outcome,segments,assignee,note,user:authUser?.name||'当前用户'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'标注保存失败');extWrite('embodiedAnnotations',data.annotations||[]);activeAnnotationId=id;moduleTemplates.annotation=annotationTemplate();showPage('annotation');showToast(status==='已通过'?'Episode 标注已审核通过':status==='已驳回'?'Episode 标注已退回':'标注草稿已保存')}catch(error){buttons.forEach(button=>button.disabled=false);showToast(error.message)}
  }
  function exportsTemplate(){
    const jobs=extRead('embodiedExports',[]),assets=getAssets(),accepted=new Set(packageHealthRows(qualityHealthSnapshot()).filter(item=>item.status==='已验收'&&item.ready).map(item=>item.id)),issues=extRead('embodiedIssues',[]),blocked=new Set(issues.filter(item=>item.status!=='已关闭').map(item=>item.assetId)),eligible=assets.filter(item=>item.bundleId&&accepted.has(item.bundleId)&&item.serverFile&&item.status==='已通过'&&!blocked.has(item.id));
    return m(`[div class="ext-grid"][section class="panel"][div class="panel-head"][div][div class="panel-title"]创建交付清单[/div][div class="panel-sub"]保留原始格式，记录文件哈希、质检证据和 Episode 标注[/div][/div][/div][div class="ext-form"][label for="exportName"]清单名称[/label][input class="input" style="width:100%" id="exportName" value="Embodied-Quality-Release" /][p]当前有 ${eligible.length} 个已验收批次资产满足交付条件[/p][div class="tag-cloud" style="padding:0"][button class="tag-option selected" data-export-content="原始文件"]原始文件引用[/button][button class="tag-option selected" data-export-content="质量报告"]质检证据[/button][button class="tag-option selected" data-export-content="标注清单"]标注 JSONL[/button][/div][div class="modal-foot" style="padding:16px 0 0"][button class="btn primary" id="createExport"][i data-lucide="package-plus"][/i]生成清单[/button][/div][/div][/section][section class="panel"][div class="panel-head"][div][div class="panel-title"]交付门禁[/div][div class="panel-sub"]须先完成原文件、质检、Episode 标注与批次验收[/div][/div][/div][div class="check-list"]${gateMarkup('已存原文件',assets.filter(item=>item.serverFile).length,assets.length,'hard-drive')}${gateMarkup('质检通过',assets.filter(item=>item.serverFile&&item.status==='已通过'&&!blocked.has(item.id)).length,assets.length,'shield-check')}${gateMarkup('可交付资产',eligible.length,assets.length,'package-check')}[/div][/section][/div][section class="panel" style="margin-top:17px"][div class="panel-head"][div][div class="panel-title"]交付记录[/div][div class="panel-sub"]清单只提供原始文件下载地址，不包含转换后的数据包[/div][/div][button class="btn" id="exportManifest"][i data-lucide="file-down"][/i]导出记录 CSV[/button][/div][div class="table-scroll"][table class="module-table"][thead][tr][th]编号[/th][th]清单名称[/th][th]格式[/th][th]资产数[/th][th]创建时间[/th][th]状态[/th][th]下载[/th][/tr][/thead][tbody]${jobs.length?jobs.map(exportRow).join(''):m('[tr][td colspan="7"][div class="empty-inline"]尚无交付清单[/div][/td][/tr]')}[/tbody][/table][/div][/section]`);
  }
  function gateMarkup(name,current,total,icon){const ok=total>0&&current===total;return m(`[div class="check-item"][div class="check-icon ${ok?'green':'red'}"][i data-lucide="${ok?'check':icon}"][/i][/div][div class="check-copy"][b]${name}[/b][small]${ok?'全部生产资产满足':'存在未满足门禁的资产'}[/small][/div][span class="check-value"]${current}/${total}[/span][/div]`)}
  function exportRow(job){return `[tr][td]${escapeHtml(job.id)}[/td][td]${escapeHtml(job.name)}[/td][td]${escapeHtml(job.format)}[/td][td]${Number(job.assetCount||0)}[/td][td]${escapeHtml(job.createdAt?new Date(job.createdAt).toLocaleString('zh-CN',{hour12:false}):'--')}[/td][td]${statusBadge(job.status)}[/td][td][a class="btn" href="/api/exports/${encodeURIComponent(job.id)}/download" download]Manifest[/a] ${Number(job.annotationCount||0)?`[a class="btn" href="/api/exports/${encodeURIComponent(job.id)}/annotations" download]标注 JSONL[/a]`:''}[/td][/tr]`}
  function bindExports(){
    const accepted=packageHealthRows(qualityHealthSnapshot()).some(item=>item.status==='已验收'&&item.ready);
    document.getElementById('createExport').disabled=!accepted;
    document.getElementById('createExport').title=accepted?'生成已验收批次的原始格式清单':'请先完成质检、标注和批次验收';
    let format='LeRobot';document.querySelectorAll('[data-format]').forEach(card=>card.onclick=()=>{document.querySelectorAll('[data-format]').forEach(x=>x.classList.remove('selected'));card.classList.add('selected');format=card.dataset.format});
    document.querySelectorAll('[data-export-content]').forEach(button=>button.onclick=()=>button.classList.toggle('selected'));
    document.getElementById('createExport').onclick=async()=>{const name=document.getElementById('exportName').value.trim(),button=document.getElementById('createExport'),contents=[...document.querySelectorAll('[data-export-content].selected')].map(item=>item.dataset.exportContent);if(!name){showToast('请输入交付包名称');return}if(!contents.length){showToast('至少选择一项包含内容');return}button.disabled=true;try{const response=await fetch('/api/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,format,contents,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'交付清单生成失败');extWrite('embodiedExports',data.exports||[]);moduleTemplates.exports=exportsTemplate();showPage('exports');showToast(`服务端 Manifest 已生成：${data.job.assetCount} 个资产`)}catch(error){showToast(error.message)}finally{button.disabled=false}};
    document.getElementById('exportManifest').onclick=()=>downloadCsv('export-jobs.csv',extRead('embodiedExports',[]));
  }
  function datasetsTemplate(){const datasets=extRead('embodiedDatasets',[]),assets=getAssets(),issues=extRead('embodiedIssues',[]),accepted=new Set(packageHealthRows(qualityHealthSnapshot()).filter(item=>item.status==='已验收'&&item.ready).map(item=>item.id)),openIds=new Set(issues.filter(item=>item.status!=='已关闭').map(item=>item.assetId)),eligible=assets.filter(item=>item.bundleId&&accepted.has(item.bundleId)&&item.serverFile&&item.status==='已通过'&&!openIds.has(item.id)),published=datasets.filter(item=>item.status==='已发布').length,frozen=datasets.filter(item=>item.status==='已冻结').length,uniqueAssets=new Set(datasets.flatMap(item=>(item.assets||[]).map(asset=>asset.id))).size;return m(`
    [div class="ext-kpis"][div class="ext-kpi"][span]数据集版本[/span][b]${datasets.length}[/b][small]服务端资产快照[/small][/div][div class="ext-kpi"][span]已冻结[/span][b]${frozen}[/b][small]保留文件哈希[/small][/div][div class="ext-kpi"][span]已发布[/span][b]${published}[/b][small]可供外部系统查询[/small][/div][div class="ext-kpi"][span]纳入资产[/span][b]${uniqueAssets}[/b][small]按资产编号去重[/small][/div][/div]
    [section class="panel"][div class="panel-head"][div][div class="panel-title"]冻结数据集版本[/div][div class="panel-sub"]仅快照原始文件、质量和标注门禁全部通过的资产，当前 ${eligible.length} 个[/div][/div][/div][div class="ext-form"][div class="form-row"][div][label]数据集名称[/label][input class="input" id="datasetName" style="width:100%" placeholder="例如：Teleop-Assembly" /][/div][div][label]版本号[/label][input class="input" id="datasetVersion" style="width:100%" placeholder="v1.0.0" /][/div][/div][div class="modal-foot" style="padding:14px 0 0"][button class="btn primary" id="datasetBuild"][i data-lucide="layers-3"][/i]冻结当前门禁资产[/button][/div][/div][/section]
    [section class="panel" style="margin-top:17px"][div class="panel-head"][div][div class="panel-title"]版本目录[/div][div class="panel-sub"]记录资产哈希、类型构成和快照校验和[/div][/div][/div][div class="table-scroll"][table class="module-table"][thead][tr][th]数据集 / 版本[/th][th]资产数[/th][th]类型构成[/th][th]校验和[/th][th]更新时间[/th][th]状态[/th][th]操作[/th][/tr][/thead][tbody data-server-managed="true" id="serverDatasetRows"]${datasets.length?datasets.map(datasetRow).join(''):m('[tr][td colspan="7"][div class="empty-inline"]尚未冻结数据集版本[/div][/td][/tr]')}[/tbody][/table][/div][/section]`)}
  function datasetRow(item){const composition=Object.entries(item.composition||{}).filter(([,count])=>count).map(([type,count])=>`${type} ${count}`).join(' · ')||'—',action=item.status==='已冻结'?`[button class="btn primary" data-dataset-status="已发布" data-dataset-id="${escapeHtml(item.id)}"]发布[/button]`:item.status==='已发布'?`[button class="btn" data-dataset-status="已归档" data-dataset-id="${escapeHtml(item.id)}"]归档[/button]`:'—';return m(`[tr][td][b]${escapeHtml(item.name)} ${escapeHtml(item.version)}[/b][br][small]${escapeHtml(item.id)}[/small][/td][td]${Number(item.assetCount||0)}[/td][td]${escapeHtml(composition)}[/td][td][code]${escapeHtml(String(item.checksum||'').slice(0,16))}[/code][/td][td]${escapeHtml(item.updatedAt?new Date(item.updatedAt).toLocaleString('zh-CN',{hour12:false}):'--')}[/td][td]${statusBadge(item.status)}[/td][td]${action}[/td][/tr]`)}
  function bindDatasets(){const build=document.getElementById('datasetBuild');build.disabled=!packageHealthRows(qualityHealthSnapshot()).some(item=>item.status==='已验收'&&item.ready);build.title=build.disabled?'请先完成质检、标注和批次验收':'冻结已验收批次资产';build.onclick=async()=>{const name=document.getElementById('datasetName').value.trim(),version=document.getElementById('datasetVersion').value.trim();if(!name||!version){showToast('请填写数据集名称和版本号');return}build.disabled=true;try{const response=await fetch('/api/datasets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,version,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'数据集冻结失败');extWrite('embodiedDatasets',data.datasets||[]);moduleTemplates.datasets=datasetsTemplate();showPage('datasets');showToast(`数据集 ${data.dataset.name} ${data.dataset.version} 已冻结`)}catch(error){showToast(error.message)}finally{build.disabled=false}};document.querySelectorAll('[data-dataset-status]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{const response=await fetch('/api/datasets/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:button.dataset.datasetId,status:button.dataset.datasetStatus,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'数据集状态更新失败');extWrite('embodiedDatasets',data.datasets||[]);moduleTemplates.datasets=datasetsTemplate();showPage('datasets');showToast(`数据集状态已更新为：${button.dataset.datasetStatus}`)}catch(error){button.disabled=false;showToast(error.message)}})}
  function trainingTemplate(){const jobs=extRead('embodiedTrainingJobs',[]),feedback=extRead('embodiedFeedbackSamples',[]),datasets=extRead('embodiedDatasets',[]).filter(item=>item.status==='已冻结'||item.status==='已发布'),running=jobs.filter(item=>item.status==='运行中').length,completed=jobs.filter(item=>item.status==='已完成').length,failed=jobs.filter(item=>item.status==='已失败').length,feedbackCount=feedback.reduce((sum,item)=>sum+Number(item.count||0),0),datasetOptions=datasets.length?datasets.map(item=>`[option value="${escapeHtml(item.id)}"]${escapeHtml(item.name)} ${escapeHtml(item.version)} · ${item.status}[/option]`).join(''):'[option value=""]暂无可训练数据集[/option]',jobOptions=jobs.length?jobs.map(item=>`[option value="${escapeHtml(item.id)}"]${escapeHtml(item.name)} · ${escapeHtml(item.status)}[/option]`).join(''):'[option value=""]暂无训练任务[/option]';return m(`
    [div class="ext-kpis"][div class="ext-kpi"][span]训练任务[/span][b]${jobs.length}[/b][small]仅记录调度与验收状态[/small][/div][div class="ext-kpi"][span]运行中[/span][b]${running}[/b][small]等待外部训练系统回报[/small][/div][div class="ext-kpi"][span]已完成[/span][b]${completed}[/b][small]保留数据集血缘[/small][/div][div class="ext-kpi"][span]回流样本[/span][b]${feedbackCount}[/b][small]${failed} 个失败任务[/small][/div][/div]
    [div class="ext-grid"][section class="panel"][div class="panel-head"][div][div class="panel-title"]创建训练任务[/div][div class="panel-sub"]绑定冻结数据集和算法，不模拟 GPU 执行[/div][/div][/div][div class="ext-form"][label]任务名称[/label][input class="input" id="trainingName" style="width:100%" placeholder="例如：遥操作业策略训练" /][div class="form-row"][div][label]数据集版本[/label][select class="select" id="trainingDataset" style="width:100%"]${datasetOptions}[/select][/div][div][label]算法[/label][select class="select" id="trainingAlgorithm" style="width:100%"][option]ACT[/option][option]Diffusion Policy[/option][option]SmolVLA[/option][option]GR00T N1[/option][/select][/div][/div][label]关联模型编号（可选）[/label][input class="input" id="trainingModel" style="width:100%" placeholder="例如：ACT-TELEOP-001" /][div class="modal-foot" style="padding:14px 0 0"][button class="btn primary" id="trainingCreate"][i data-lucide="play"][/i]创建调度记录[/button][/div][/div][/section]
    [section class="panel"][div class="panel-head"][div][div class="panel-title"]失败样本回流[/div][div class="panel-sub"]登记评测或线上运行中发现的失败样本[/div][/div][/div][div class="ext-form"][div class="form-row"][div][label]训练任务[/label][select class="select" id="feedbackTraining" style="width:100%"]${jobOptions}[/select][/div][div][label]数据类型[/label][select class="select" id="feedbackType" style="width:100%"]${DATA_TYPES.map(type=>`[option]${type}[/option]`).join('')}[/select][/div][/div][div class="form-row"][div][label]样本数[/label][input class="input" id="feedbackCount" type="number" min="1" value="1" style="width:100%" /][/div][div][label]场景[/label][input class="input" id="feedbackScene" style="width:100%" placeholder="例如：精密插接" /][/div][/div][label]失败原因[/label][input class="input" id="feedbackReason" style="width:100%" placeholder="例如：遮挡导致末端定位漂移" /][div class="modal-foot" style="padding:14px 0 0"][button class="btn" id="feedbackSave"][i data-lucide="rotate-ccw"][/i]登记回流[/button][/div][/div][/section][/div]
    [section class="panel" style="margin-top:17px"][div class="panel-head"][div][div class="panel-title"]训练调度记录[/div][div class="panel-sub"]状态由人工或外部训练系统确认[/div][/div][/div][div class="table-scroll"][table class="module-table"][thead][tr][th]任务 / 编号[/th][th]数据集</th][th]算法 / 模型[/th][th]进度[/th][th]成功率[/th][th]状态[/th][th]操作[/th][/tr][/thead][tbody data-server-managed="true" id="serverTrainingRows"]${jobs.length?jobs.map(trainingRow).join(''):m('[tr][td colspan="7"][div class="empty-inline"]尚未创建训练任务[/div][/td][/tr]')}[/tbody][/table][/div][/section]
    [section class="panel" style="margin-top:17px"][div class="panel-head"][div][div class="panel-title"]失败样本清单[/div][div class="panel-sub"]用于后续归因、补采和新版本数据集构建[/div][/div][/div][div class="table-scroll"][table class="module-table"][thead][tr][th]记录编号[/th][th]训练任务[/th][th]类型</th][th]场景[/th][th]样本数[/th][th]原因[/th][th]状态[/th][/tr][/thead][tbody]${feedback.length?feedback.map(item=>m(`[tr][td]${escapeHtml(item.id)}[/td][td]${escapeHtml(item.training)}[/td][td]${typeBadge(item.type)}[/td][td]${escapeHtml(item.scene)}[/td][td]${Number(item.count||0)}[/td][td]${escapeHtml(item.reason)}[/td][td]${statusBadge(item.status)}[/td][/tr]`)).join(''):m('[tr][td colspan="7"][div class="empty-inline"]尚未登记失败样本[/div][/td][/tr]')}[/tbody][/table][/div][/section]`)}
  function trainingRow(job){const actions=job.status==='排队中'?`[button class="btn primary" data-training-status="运行中" data-training-id="${escapeHtml(job.id)}"]启动[/button]`:job.status==='运行中'?`[button class="btn" data-training-status="已暂停" data-training-id="${escapeHtml(job.id)}"]暂停[/button][button class="btn success" data-training-status="已完成" data-training-id="${escapeHtml(job.id)}"]完成[/button]`:job.status==='已暂停'?`[button class="btn primary" data-training-status="运行中" data-training-id="${escapeHtml(job.id)}"]继续[/button]`:'—';return m(`[tr][td][b]${escapeHtml(job.name)}[/b][br][small]${escapeHtml(job.id)}[/small][/td][td]${escapeHtml(job.dataset)}[/td][td]${escapeHtml(job.algorithm)}[br][small]${escapeHtml(job.modelId||'未关联')}[/small][/td][td]${Number(job.progress||0)}%[/td][td]${job.successRate==null?'--':`${Number(job.successRate)}%`}[/td][td]${statusBadge(job.status)}[/td][td][div class="row-actions"]${actions}[/div][/td][/tr]`)}
  async function updateTrainingStatus(id,status,button){button.disabled=true;try{const response=await fetch('/api/training/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,status,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'训练状态更新失败');extWrite('embodiedTrainingJobs',data.trainingJobs||[]);moduleTemplates.training=trainingTemplate();showPage('training');showToast(`训练任务已更新为：${status}`)}catch(error){button.disabled=false;showToast(error.message)}}
  function bindTraining(){const create=document.getElementById('trainingCreate');create.onclick=async()=>{const name=document.getElementById('trainingName').value.trim(),datasetId=document.getElementById('trainingDataset').value,algorithm=document.getElementById('trainingAlgorithm').value,modelId=document.getElementById('trainingModel').value.trim();if(!name||!datasetId){showToast('请填写任务名称并选择可训练数据集');return}create.disabled=true;try{const response=await fetch('/api/training',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,datasetId,algorithm,modelId,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'训练任务创建失败');extWrite('embodiedTrainingJobs',data.trainingJobs||[]);moduleTemplates.training=trainingTemplate();showPage('training');showToast(`训练调度记录已创建：${data.job.id}`)}catch(error){showToast(error.message)}finally{create.disabled=false}};document.querySelectorAll('[data-training-status]').forEach(button=>button.onclick=()=>updateTrainingStatus(button.dataset.trainingId,button.dataset.trainingStatus,button));const save=document.getElementById('feedbackSave');save.onclick=async()=>{const trainingId=document.getElementById('feedbackTraining').value,count=Number(document.getElementById('feedbackCount').value),type=document.getElementById('feedbackType').value,scene=document.getElementById('feedbackScene').value.trim(),reason=document.getElementById('feedbackReason').value.trim();if(!trainingId||!count||!reason){showToast('请选择训练任务，并填写样本数和失败原因');return}save.disabled=true;try{const response=await fetch('/api/training/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trainingId,count,type,scene,reason,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'失败样本登记失败');extWrite('embodiedFeedbackSamples',data.feedbackSamples||[]);moduleTemplates.training=trainingTemplate();showPage('training');showToast(`已登记 ${data.record.count} 条失败样本`)}catch(error){showToast(error.message)}finally{save.disabled=false}}}
  function tasksTemplate(){
    const tasks=readStore(storageKey.tasks),running=tasks.filter(task=>task.status==='进行中').length,pending=tasks.filter(task=>task.status==='待验收').length,completed=tasks.filter(task=>task.status==='已完成').length,accepted=tasks.reduce((sum,task)=>sum+Number(task.metrics?.accepted||0),0);
    return m(`
      [div class="ext-kpis"]
        [div class="ext-kpi"][span]任务总数[/span][b]${tasks.length}[/b][small]服务端持久化任务[/small][/div]
        [div class="ext-kpi"][span]进行中[/span][b]${running}[/b][small]正在采集生产数据[/small][/div]
        [div class="ext-kpi"][span]待验收[/span][b]${pending}[/b][small]等待治理负责人签署[/small][/div]
        [div class="ext-kpi"][span]验收产出[/span][b]${accepted}[/b][small]${completed} 个任务已完成[/small][/div]
      [/div]
      [section class="panel"]
        [div class="panel-head"][div][div class="panel-title"]采集生产工单[/div][div class="panel-sub"]节点、资产、质检问题和验收签署形成可追溯闭环[/div][/div][button class="btn primary" id="taskCreateInline"][i data-lucide="plus"][/i]新建任务[/button][/div]
        [div class="table-scroll"][table class="module-table task-table"][thead][tr][th]任务 / 场景[/th][th]类型 / 节点[/th][th]负责人 / 截止[/th][th]产出进度[/th][th]验收门槛[/th][th]状态[/th][th]操作[/th][/tr][/thead][tbody id="taskRows"][/tbody][/table][/div]
      [/section]`);
  }
  function taskActions(task){const status=task.status||'待启动',metrics=task.metrics||{},actions=[];actions.push(`[button class="btn" data-task-detail="${escapeHtml(task.id)}"]详情[/button]`);if(status==='待启动')actions.push(`[button class="btn primary" data-task-status="进行中" data-task-id="${escapeHtml(task.id)}"]启动[/button]`);if(status==='进行中'){actions.push(`[button class="btn" data-task-status="已暂停" data-task-id="${escapeHtml(task.id)}"]暂停[/button]`);actions.push(`[button class="btn success" data-task-status="待验收" data-task-id="${escapeHtml(task.id)}"${metrics.acceptanceReady?'':' disabled title="尚未达到验收门槛"'}]提交验收[/button]`)}if(status==='已暂停')actions.push(`[button class="btn primary" data-task-status="进行中" data-task-id="${escapeHtml(task.id)}"]继续[/button]`);if(status==='待验收'&&authUser?.role==='数据治理负责人'){actions.push(`[button class="btn" data-task-status="进行中" data-task-id="${escapeHtml(task.id)}"]退回[/button]`);actions.push(`[button class="btn success" data-task-status="已完成" data-task-id="${escapeHtml(task.id)}"]验收通过[/button]`)}actions.push(`[button class="btn" data-task-report="${escapeHtml(task.id)}" title="下载验收报告"][i data-lucide="file-down"][/i][/button]`);return actions.join('')}
  async function openTaskDetail(taskId){
    const task=readStore(storageKey.tasks).find(item=>item.id===taskId);if(!task)return;
    const box=document.getElementById('modelPicker');if(!box)return;
    box.innerHTML=m(`[div class="search-box" style="width:min(920px,calc(100vw - 30px))"][div class="popover-head"][span]生产工单详情 · ${escapeHtml(task.name)}[/span][button class="close" id="taskDetailClose"][i data-lucide="x"][/i][/button][/div][div style="padding:17px;max-height:72vh;overflow:auto"][div class="ext-kpis" style="margin:0 0 16px"][div class="ext-kpi"][span]产出进度[/span][b]${Number(task.metrics?.assetCount||0)} / ${Number(task.metrics?.targetCount||task.targetCount||0)}[/b][small]${Number(task.metrics?.progress||0)}%[/small][/div][div class="ext-kpi"][span]原始文件[/span][b]${Number(task.metrics?.uploaded||0)}[/b][small]已上传到服务端[/small][/div][div class="ext-kpi"][span]验收通过[/span][b]${Number(task.metrics?.accepted||0)}[/b][small]最低 ${Number(task.metrics?.acceptanceScore||task.acceptanceScore||90)} 分[/small][/div][div class="ext-kpi"][span]未关闭问题[/span][b]${Number(task.metrics?.openIssues||0)}[/b][small]阻断验收[/small][/div][/div][div class="issue-evidence" style="margin-bottom:16px"][b]${escapeHtml(task.status||'待启动')} · ${escapeHtml(task.type)} · ${escapeHtml(task.scene||'未填写场景')}[/b][span]负责人：${escapeHtml(task.owner||'未分配')} · 截止：${escapeHtml(task.deadline||'未设置')} · 节点：${escapeHtml((task.nodeIds||[]).join('、')||'未绑定')}[/span][p]${escapeHtml(task.description||'未填写任务说明')}</p></div><div class="table-scroll" id="taskDetailTable"][div class="empty-inline" style="padding:28px"]正在读取关联资产…[/div][/div][/div][div class="modal-foot"][button class="btn" id="taskDetailReport"][i data-lucide="file-down"][/i]下载验收报告[/button][button class="btn primary" id="taskDetailCloseBottom"]关闭</button][/div][/div]`);box.classList.add('show');lucide.createIcons();const close=()=>box.classList.remove('show');document.getElementById('taskDetailClose').onclick=close;document.getElementById('taskDetailCloseBottom').onclick=close;document.getElementById('taskDetailReport').onclick=()=>{window.location.href=`/api/tasks/${encodeURIComponent(task.id)}/report`};
    try{const [assetResponse,issueResponse]=await Promise.all([fetch('/api/assets',{cache:'no-store'}),fetch('/api/issues',{cache:'no-store'})]),assetData=await assetResponse.json(),issueData=await issueResponse.json();if(!assetResponse.ok)throw new Error(assetData.error||'资产读取失败');const assets=(assetData.assets||[]).filter(asset=>asset.taskId===task.id),issues=issueResponse.ok?(issueData.issues||[]):[],issueCount=asset=>issues.filter(issue=>issue.assetId===asset.id&&issue.status!=='已关闭').length,table=document.getElementById('taskDetailTable');table.innerHTML=assets.length?m(`[table class="module-table ext-table"][thead][tr][th]资产[/th][th]类型[/th][th]原始文件[/th][th]质量分[/th][th]问题[/th][th]状态[/th][/tr][/thead][tbody]${assets.map(asset=>`[tr][td][b]${escapeHtml(asset.name)}[/b][br][small]${escapeHtml(asset.id)}[/small][/td][td]${typeBadge(asset.type)}[/td][td]${asset.serverFile?'已存入服务端':'未上传'}[/td][td]${asset.score?Number(asset.score).toFixed(1):'--'}[/td][td]${issueCount(asset)}[/td][td]${statusBadge(asset.status||'待质检')}[/td][/tr>`).join('')}[/tbody][/table]`):m('[div class="empty-inline" style="padding:28px"]当前任务尚未关联资产，请在导入数据时选择该任务[/div]');lucide.createIcons()}catch(error){document.getElementById('taskDetailTable').innerHTML=m(`[div class="empty-inline" style="padding:28px"]无法读取关联资产：${escapeHtml(error.message)}[/div]`)}
  }
  function renderTaskRows(){
    const body=document.getElementById('taskRows');if(!body)return;const tasks=readStore(storageKey.tasks);
    body.innerHTML=tasks.length?tasks.map(task=>{const status=task.status||'待启动',metrics=task.metrics||{},progress=Number(metrics.progress||0),nodes=(task.nodeIds||[]).join('、')||'未绑定';return m(`[tr][td][b]${escapeHtml(task.name)}[/b][br][small]${escapeHtml(task.id)} · ${escapeHtml(task.scene||'未填写场景')}[/small][/td][td]${typeBadge(task.type)}[br][small]${escapeHtml(nodes)}[/small][/td][td]${escapeHtml(task.owner||'未分配')}[br][small]${escapeHtml(task.deadline||'未设置截止日期')}[/small][/td][td][b]${Number(metrics.assetCount||0)} / ${Number(metrics.targetCount||task.targetCount||0)}</b][div class="mini-progress task-progress"][i style="width:${progress}%"][/i][/div][small]原文件 ${Number(metrics.uploaded||0)}</small][/td][td][b]通过 ${Number(metrics.accepted||0)}</b][br][small]≥ ${Number(metrics.acceptanceScore||task.acceptanceScore||90)} 分 · 阻断 ${Number(metrics.openIssues||0)}</small][/td][td]${statusBadge(status)}[/td][td][div class="row-actions"]${taskActions(task)}[/div][/td][/tr]`)}).join(''):m('[tr][td colspan="7"][div class="empty-inline"]尚未创建采集任务[/div][/td][/tr]');
    body.querySelectorAll('[data-task-status]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{const response=await fetch('/api/tasks/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:button.dataset.taskId,status:button.dataset.taskStatus,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'任务状态更新失败');writeStore(storageKey.tasks,data.tasks);moduleTemplates.tasks=tasksTemplate();showPage('tasks');showToast(`任务状态已更新为：${button.dataset.taskStatus}`)}catch(error){button.disabled=false;showToast(error.message)}});
    body.querySelectorAll('[data-task-detail]').forEach(button=>button.onclick=event=>{event.stopPropagation();openTaskDetail(button.dataset.taskDetail)});
    body.querySelectorAll('[data-task-report]').forEach(button=>button.onclick=()=>{window.location.href=`/api/tasks/${encodeURIComponent(button.dataset.taskReport)}/report`});
  }
  function populateTaskForm(){const type=document.getElementById('taskType')?.value||'UMI',select=document.getElementById('taskNode');if(!select)return;const nodes=extRead('embodiedNodes',[]).filter(node=>node.type===type);select.innerHTML=`<option value="">暂不绑定节点</option>`+nodes.map(node=>`<option value="${escapeHtml(node.id)}">${escapeHtml(node.id)} · ${escapeHtml(node.site)} · ${escapeHtml(node.status)}</option>`).join('');const owner=document.getElementById('taskOwner');if(owner&&!owner.value)owner.value=authUser?.name||''}
  function bindTasksPage(){renderTaskRows();document.getElementById('taskCreateInline').onclick=()=>{populateTaskForm();document.getElementById('createBtn').click()};lucide.createIcons()}
  function nodesTemplate(){const nodes=extRead('embodiedNodes',[]),onlineNodes=nodes.filter(node=>node.status==='在线'),online=onlineNodes.length,latencies=onlineNodes.map(node=>Number(node.latency)).filter(Number.isFinite),average=latencies.length?Math.round(latencies.reduce((sum,value)=>sum+value,0)/latencies.length):null,highDisk=nodes.filter(node=>Number(node.disk)>=85).length,queued=nodes.reduce((sum,node)=>sum+Number(node.queue||0),0);return m(`
    [div class="ext-kpis"][div class="ext-kpi"][span]在线节点[/span][b]${online} / ${nodes.length}[/b][small]5 分钟心跳窗口[/small][/div][div class="ext-kpi"][span]平均上行延迟[/span][b]${average==null?'--':average+' ms'}[/b][small]仅统计在线节点[/small][/div][div class="ext-kpi"][span]上传队列[/span][b]${queued}[/b][small]节点待上传对象数[/small][/div][div class="ext-kpi"][span]磁盘预警[/span][b]${highDisk}[/b][small]使用率达到 85%</small][/div][/div]
    [section class="panel"][div class="panel-head"][div][div class="panel-title"]登记采集节点[/div][div class="panel-sub"]节点上线状态只接受服务端心跳，不使用固定演示数据[/div][/div][/div][div class="ext-form"][div class="form-row"][div][label]节点编号[/label][input class="input" id="nodeId" style="width:100%" placeholder="例如：TELEOP-01" /][/div][div][label]数据类型[/label][select class="select" id="nodeType" style="width:100%"]${DATA_TYPES.map(type=>`[option]${type}[/option]`).join('')}[/select][/div][/div][div class="form-row"][div][label]部署位置[/label][input class="input" id="nodeSite" style="width:100%" placeholder="例如：上海实验室" /][/div][div][label]Agent 版本[/label][input class="input" id="nodeVersion" style="width:100%" placeholder="例如：2.4.0" /][/div][/div][label]本地容量（GB）[/label][input class="input" id="nodeCapacity" type="number" min="0" value="0" style="width:100%" /][div class="modal-foot" style="padding:14px 0 0"][button class="btn primary" id="nodeRegister"][i data-lucide="server-cog"][/i]登记节点[/button][/div][/div][/section]
    [section class="panel" style="margin-top:17px"][div class="panel-head"][div][div class="panel-title"]节点运行状态[/div][div class="panel-sub"]最后心跳、延迟、磁盘和上传队列均来自服务端[/div][/div][button class="btn" id="diagnoseNodes"][i data-lucide="stethoscope"][/i]运行诊断[/button][/div][div class="node-grid"]${nodes.length?nodes.map(nodeCard).join(''):m('[div class="empty-inline" style="grid-column:1/-1;padding:48px"]尚未登记采集节点[/div]')}[/div][div class="ops-note" id="nodeDiagnosis"]等待运行诊断[/div][/section]`)}
  function nodeCard(node){const heartbeat=node.lastHeartbeat?new Date(node.lastHeartbeat).toLocaleString('zh-CN',{hour12:false}):'从未上报';return m(`[article class="node-card"][div class="node-head"][div class="node-name"][i class="node-dot ${node.status==='在线'?'':'offline'}"][/i]${escapeHtml(node.id)}[/div]${typeBadge(node.type)}[/div][div class="node-meta"][span]延迟[b]${node.latency==null?'--':Number(node.latency)+' ms'}[/b][/span][span]磁盘[b]${node.disk==null?'--':Number(node.disk)+'%'}[/b][/span][span]队列[b]${Number(node.queue||0)}[/b][/span][/div][div class="node-foot"][span]${escapeHtml(node.site)} · Agent ${escapeHtml(node.agentVersion||'未上报')}[/span][span style="color:${node.status==='在线'?'var(--green)':'var(--red)'}"]${node.status} · ${heartbeat}[/span][/div][div class="node-actions"][button class="btn" data-node-token="${escapeHtml(node.id)}" title="轮换节点接入令牌"][i data-lucide="key-round"][/i]轮换凭证[/button][/div][/article]`)}
  function showNodeCredential(nodeId,token){document.getElementById('nodeCredentialTitle').textContent=`${nodeId} 接入凭证`;document.getElementById('nodeCredentialValue').textContent=token;document.getElementById('nodeCredentialDialog').classList.add('show');lucide.createIcons()}
  function bindNodes(){const register=document.getElementById('nodeRegister');register.onclick=async()=>{const id=document.getElementById('nodeId').value.trim(),type=document.getElementById('nodeType').value,site=document.getElementById('nodeSite').value.trim(),agentVersion=document.getElementById('nodeVersion').value.trim(),capacityGb=Number(document.getElementById('nodeCapacity').value);if(!id||!site){showToast('请填写节点编号和部署位置');return}register.disabled=true;try{const response=await fetch('/api/nodes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,type,site,agentVersion,capacityGb,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'节点登记失败');extWrite('embodiedNodes',data.nodes||[]);moduleTemplates.nodes=nodesTemplate();showPage('nodes');refreshNotifications();if(data.agentToken)showNodeCredential(data.node.id,data.agentToken);else showToast(`节点 ${data.node.id} 已更新`)}catch(error){showToast(error.message)}finally{register.disabled=false}};document.getElementById('diagnoseNodes').onclick=async()=>{const button=document.getElementById('diagnoseNodes');button.disabled=true;try{const response=await fetch('/api/nodes/diagnose',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'节点诊断失败');extWrite('embodiedNodes',data.nodes||[]);document.getElementById('nodeDiagnosis').textContent=data.warnings.length?data.warnings.join('；'):`${data.nodes.length} 个节点未发现预警`;showToast(data.warnings.length?`发现 ${data.warnings.length} 条节点预警`:'节点诊断完成')}catch(error){showToast(error.message)}finally{button.disabled=false}};document.querySelectorAll('[data-node-token]').forEach(button=>button.onclick=async()=>{if(!confirm(`轮换 ${button.dataset.nodeToken} 的接入凭证？旧凭证会立即失效。`))return;button.disabled=true;try{const response=await fetch('/api/nodes/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:button.dataset.nodeToken})}),data=await response.json();if(!response.ok)throw new Error(data.error||'凭证轮换失败');showNodeCredential(data.node.id,data.agentToken)}catch(error){showToast(error.message)}finally{button.disabled=false}})}
  function usersTemplate(){const members=extRead('embodiedMembers',[]),policies=extRead('embodiedRolePolicies',{}),active=members.filter(item=>item.status==='正常').length,pending=members.filter(item=>item.status==='待激活').length,disabled=members.filter(item=>item.status==='已停用').length,authMode=extRead('embodiedAuthMode','disabled');return m(`
    [div class="ext-kpis"][div class="ext-kpi"][span]成员账号[/span][b]${members.length}[/b][small]服务端持久化记录[/small][/div][div class="ext-kpi"][span]正常账号[/span][b]${active}[/b][small]可通过登录验证[/small][/div][div class="ext-kpi"][span]待激活[/span][b]${pending}[/b][small]暂不可登录[/small][/div][div class="ext-kpi"][span]身份认证[/span][b]${authMode==='local'?'已启用':'未启用'}[/b][small]本地账号与签名会话[/small][/div][/div]
    [div class="ext-grid"][section class="panel"][div class="panel-head"][div][div class="panel-title"]创建成员账号[/div][div class="panel-sub"]由管理员设置初始密码，建议通过安全渠道单独告知成员[/div][/div][/div][div class="ext-form"][div class="form-row"][div][label]姓名[/label][input class="input" id="memberName" style="width:100%" placeholder="成员姓名" /][/div][div][label]工作邮箱[/label][input class="input" id="memberEmail" type="email" style="width:100%" placeholder="name@company.com" /][/div][/div][div class="form-row"][div][label]平台角色[/label][select class="select" id="memberRole" style="width:100%"]${ROLE_NAMES.map(role=>`[option]${role}[/option]`).join('')}[/select][/div][div][label]数据域[/label][select class="select" id="memberDomain" style="width:100%"]${['全部数据域',...DATA_TYPES].map(domain=>`[option]${domain}[/option]`).join('')}[/select][/div][/div][label]初始密码[/label][input class="input" id="memberPassword" type="password" autocomplete="new-password" style="width:100%" placeholder="至少 10 位，包含字母和数字" /][div class="modal-foot" style="padding:14px 0 0"][button class="btn primary" id="memberRegister"][i data-lucide="user-plus"][/i]创建账号[/button][/div][/div][/section]
    [section class="panel"][div class="panel-head"][div][div class="panel-title"]角色权限矩阵[/div][div class="panel-sub"]所有受保护写操作均由服务端按当前登录角色强制校验[/div][/div][/div][div class="annotation-list"]${ROLE_NAMES.map(role=>m(`[div class="annotation-card"][div][b]${role}[/b][p]${escapeHtml((policies[role]||[]).join(' · ')||'策略同步中')}</p>[/div][span class="status medium"]${(policies[role]||[]).length} 项[/span][/div]`)).join('')}[/div][/section][/div]
    [section class="panel" style="margin-top:17px"][div class="panel-head"][div][div class="panel-title"]成员与数据域[/div][div class="panel-sub"]账号状态与角色变更全部写入审计日志[/div][/div][/div][div class="table-scroll"][table class="module-table"][thead][tr][th]成员[/th][th]邮箱[/th][th]角色[/th][th]数据域[/th][th]最后登录[/th][th]权限数[/th][th]状态[/th][th]操作[/th][/tr][/thead][tbody data-server-managed="true" id="serverMemberRows"]${members.length?members.map(memberRow).join(''):m('[tr][td colspan="8"][div class="empty-inline"]尚未登记平台成员[/div][/td][/tr]')}[/tbody][/table][/div][/section]`)}
  function memberRow(member){const next=member.status==='正常'?'已停用':'正常',label=member.status==='正常'?'停用账号':'启用账号',lastLogin=member.lastLoginAt?new Date(member.lastLoginAt).toLocaleString('zh-CN',{hour12:false}):'从未登录';return m(`[tr][td][b]${escapeHtml(member.name)}[/b][br][small]${escapeHtml(member.id)}[/small][/td][td]${escapeHtml(member.email)}[/td][td]${escapeHtml(member.role)}[/td][td]${escapeHtml(member.domain)}[/td][td]${escapeHtml(lastLogin)}[/td][td]${(member.permissions||[]).length}[/td][td]${statusBadge(member.status)}[/td][td][button class="btn ${next==='正常'?'primary':''}" data-member-status="${next}" data-member-id="${escapeHtml(member.id)}"]${label}[/button][/td][/tr]`)}
  function bindUsers(){const register=document.getElementById('memberRegister');register.onclick=async()=>{const name=document.getElementById('memberName').value.trim(),email=document.getElementById('memberEmail').value.trim(),password=document.getElementById('memberPassword').value,role=document.getElementById('memberRole').value,domain=document.getElementById('memberDomain').value;if(!name||!email||!password){showToast('请填写姓名、有效邮箱和初始密码');return}register.disabled=true;try{const response=await fetch('/api/members',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email,password,role,domain})}),data=await response.json();if(!response.ok)throw new Error(data.error||'成员账号创建失败');extWrite('embodiedMembers',data.members||[]);extWrite('embodiedRolePolicies',data.rolePolicies||{});extWrite('embodiedAuthMode',data.authMode||'local');moduleTemplates.users=usersTemplate();showPage('users');showToast(`成员账号 ${data.member.name} 已创建`)}catch(error){showToast(error.message)}finally{register.disabled=false}};document.querySelectorAll('[data-member-status]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{const response=await fetch('/api/members/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:button.dataset.memberId,status:button.dataset.memberStatus})}),data=await response.json();if(!response.ok)throw new Error(data.error||'成员状态更新失败');extWrite('embodiedMembers',data.members||[]);moduleTemplates.users=usersTemplate();showPage('users');showToast(`成员账号状态已更新为：${button.dataset.memberStatus}`)}catch(error){button.disabled=false;showToast(error.message)}})}
  function auditTemplate(){const logs=extRead('embodiedAudit'),today=new Date().toLocaleDateString('zh-CN'),todayLogs=logs.filter(log=>String(log.time||'').startsWith(today)),automatic=todayLogs.filter(log=>['系统','系统质检引擎','节点代理'].includes(log.user)).length,changes=logs.filter(log=>/创建|更新|登记|上传|接收|冻结|发布|审核/.test(log.action)).length,governance=logs.filter(log=>/成员|权限|节点/.test(log.action)).length;return m(`
    [div class="ext-kpis"][div class="ext-kpi"][span]今日操作[/span][b]${todayLogs.length}[/b][small]自动事件 ${automatic} 条[/small][/div][div class="ext-kpi"][span]数据变更[/span][b]${changes}[/b][small]当前日志窗口统计[/small][/div][div class="ext-kpi"][span]治理事件[/span][b]${governance}[/b][small]成员、权限与节点[/small][/div][div class="ext-kpi"][span]日志保留[/span][b]${logs.length} / 1000[/b][small]服务端滚动窗口[/small][/div][/div]
    [section class="panel"][div class="panel-head"][div][div class="panel-title"]操作审计日志[/div][div class="panel-sub"]记录数据全生命周期关键动作[/div][/div][button class="btn" id="auditExport"][i data-lucide="download"][/i]导出日志[/button][/div][div class="ext-toolbar"][div class="search"][i data-lucide="search"][/i][input id="auditSearch" placeholder="搜索操作者、动作或对象" /][/div][select class="filter-select" id="auditAction"][option value="all"]全部动作[/option][option]审核[/option][option]质检[/option][option]导出[/option][option]节点[/option][/select][/div][div class="table-scroll"][table class="module-table"][thead][tr][th]时间[/th][th]操作者[/th][th]动作[/th][th]对象[/th][th]详情[/th][/tr][/thead][tbody id="auditRows"]${logs.map(auditRow).join('')}[/tbody][/table][/div][/section]`)}
  function auditRow(log){return `[tr][td]${log.time}[/td][td]${log.user}[/td][td class="audit-action"]${escapeHtml(log.action)}[/td][td]${escapeHtml(log.target)}[/td][td class="audit-detail"]${escapeHtml(log.detail)}[/td][/tr]`}
  function bindAudit(){const filter=()=>{const query=document.getElementById('auditSearch').value.toLowerCase(),action=document.getElementById('auditAction').value;document.querySelectorAll('#auditRows tr').forEach(row=>row.style.display=row.textContent.toLowerCase().includes(query)&&(action==='all'||row.textContent.includes(action))?'':'none')};document.getElementById('auditSearch').oninput=filter;document.getElementById('auditAction').onchange=filter;document.getElementById('auditExport').onclick=()=>downloadCsv('audit-log.csv',extRead('embodiedAudit'))}
  function runsTemplate(){const runs=extRead('embodiedRuns',[]),completed=runs.filter(run=>run.status==='已完成').length,failed=runs.filter(run=>run.status==='失败'||run.status==='部分完成').length,last=runs[0];return m(`
    [div class="ext-kpis"][div class="ext-kpi"][span]运行总数[/span][b]${runs.length}[/b][small]保留最近 100 次[/small][/div][div class="ext-kpi"][span]已完成[/span][b]${completed}[/b][small]具备可复核快照[/small][/div][div class="ext-kpi"][span]异常运行[/span][b class="${failed?'danger':''}">${failed}[/b][small]需要查看节点证据[/small][/div][div class="ext-kpi"][span]最近耗时[/span][b]${last?`${last.duration} 秒`:'--'}[/b][small]${last?escapeHtml(last.kind||'质检'):'尚未执行'}[/small][/div][/div]
    [section class="panel"][div class="panel-head"][div][div class="panel-title"]运行记录</div][div class="panel-sub"]每次显式执行独立留痕，记录节点状态、耗时、批次范围和证据摘要，不覆盖历史结果。</div>[/div]
      [div class="table-scroll"][table class="module-table ext-table"][thead][tr][th]运行编号[/th][th]类型 / 范围[/th][th]状态[/th][th]节点进度[/th][th]对象数[/th][th]耗时[/th][th]开始时间[/th][th]操作[/th][/tr][/thead][tbody]${runs.length?runs.map(run=>`[tr][td][b]${escapeHtml(run.id)}[/b][br][small]${escapeHtml(run.batchId||'未关联批次')}[/small][/td][td]${escapeHtml(run.kind||'质检')}[br][small]${escapeHtml(run.scope||'')}[/small][/td][td]${statusBadge(run.status||'已完成')}[/td][td]${(run.nodes||[]).filter(node=>node.status==='已完成').length} / ${(run.nodes||[]).length}[/td][td]${run.summary?.total??run.targetIds?.length??0}[/td][td]${run.duration??'--'} 秒[/td][td]${escapeHtml(run.startedAt?new Date(run.startedAt).toLocaleString('zh-CN',{hour12:false}):'--')}[/td][td][button class="btn" data-run-detail="${escapeHtml(run.id)}"]查看详情[/button][/td][/tr]`).join(''):m('[tr][td colspan="8"][div class="empty-inline"]尚无运行记录。执行一次质量检测后，这里会显示完整的节点快照。[/div][/td][/tr]')}[/tbody][/table][/div]
    [/section]`) }
  function bindRuns(){document.querySelectorAll('[data-run-detail]').forEach(button=>button.onclick=()=>openRunDetail(button.dataset.runDetail))}
  function openRunDetail(id){const run=extRead('embodiedRuns',[]).find(item=>item.id===id);if(!run)return;const box=document.getElementById('runDetail');box.innerHTML=m(`[div class="search-box" style="width:min(760px,calc(100vw - 30px))"][div class="popover-head"][span]运行详情 · ${escapeHtml(run.id)}[/span][button class="close" id="runDetailClose"][i data-lucide="x"][/i][/button][/div][div style="padding:17px;max-height:74vh;overflow:auto"][div class="detail-grid"][div class="detail-card"][span]类型[/span][b]${escapeHtml(run.kind||'质检')}[/b][/div][div class="detail-card"][span]批次 / 范围[/span][b]${escapeHtml(run.batchId||'--')} · ${escapeHtml(run.scope||'--')}[/b][/div][div class="detail-card"][span]耗时[/span][b]${run.duration??'--'} 秒[/b][/div][div class="detail-card"][span]对象 / 问题[/span][b]${run.summary?.total??0} / ${run.summary?.issueCount??0}[/b][/div][/div][h3 class="section-title"]节点执行轨迹[/h3][div class="run-node-list"]${(run.nodes||[]).map(node=>`[div class="run-node"][span class="run-node-dot ${node.status==='已完成'?'ok':'bad'}"][/span][div][b]${escapeHtml(node.label||node.id)}[/b][small]${escapeHtml(node.status||'未知')} · ${escapeHtml(node.detail||'')}[/small][/div][/div]`).join('')||m('[div class="empty-inline"]没有节点明细[/div]')}[/div][h3 class="section-title"]证据摘要[/h3][div class="run-evidence-list"]${(run.evidence||[]).slice(0,30).map(item=>`[div][b]${escapeHtml(item.name||item.assetId)}[/b][small]质量分 ${item.score??'--'} · ${escapeHtml((item.issues||[]).join('、')||'未发现问题')}[/small][/div]`).join('')||m('[div class="empty-inline"]没有证据摘要[/div]')}[/div][/div][/div]`);box.classList.add('show');document.getElementById('runDetailClose').onclick=()=>box.classList.remove('show');lucide.createIcons()}
  function assetsTemplate(){return m(`
    [div class="ext-kpis"]
      [div class="ext-kpi"][span]UMI 数据资产[/span][b id="assetKpiUmi"]0[/b][small]按资产条数统计[/small][/div]
      [div class="ext-kpi"][span]EGO 数据资产[/span][b id="assetKpiEgo"]0[/b][small]按资产条数统计[/small][/div]
      [div class="ext-kpi"][span]遥操数据资产[/span][b id="assetKpiTele"]0[/b][small]按资产条数统计[/small][/div]
      [div class="ext-kpi"][span]待质检资产[/span][b id="assetKpiPending"]0[/b][small]尚未执行质量检测[/small][/div]
    [/div]
    [section class="panel"]
      [div class="panel-head"][div][div class="panel-title"]数据资产目录[/div][div class="panel-sub"]导入时选择数据类型、采集场景与关联模型，导入后可直接质检[/div][/div]
        [button class="btn" id="assetQcPending"][i data-lucide="play-circle"][/i]质检待检数据[/button]
        [button class="btn primary" id="assetImportBtn"][i data-lucide="folder-up"][/i]导入总文件夹[/button]
      [/div]
      [div class="ext-toolbar"]
        [div class="search"][i data-lucide="search"][/i][input id="assetSearch" placeholder="搜索资产名称、场景或关联模型" /][/div]
        [select class="filter-select" id="assetTypeFilter"][option value="all"]全部类型[/option][option]UMI[/option][option]EGO[/option][option]遥操[/option][/select]
        [select class="filter-select" id="assetStatusFilter"][option value="all"]全部质量状态[/option][option]已通过[/option][option]待深检[/option][option]待补传[/option][option]问题[/option][option]待质检[/option][/select]
        [select class="filter-select" id="assetModelFilter"][option value="all"]全部模型[/option][/select]
        [span class="spacer"][/span][button class="btn" id="assetExportBtn"][i data-lucide="download"][/i]导出资产清单[/button]
      [/div]
      [div class="table-scroll"][table class="module-table ext-table"][thead][tr][th]资产名称[/th][th]类型[/th][th]场景 / 生产任务[/th][th]规模[/th][th]质量评分[/th][th]关联模型[/th][th]质检状态[/th][th]操作[/th][/tr][/thead][tbody id="assetRows"][/tbody][/table][/div]
    [/section]`)}
  function assetRow(asset){
    const score=asset.score?`[span class="quality-score ${scoreClass(asset.score)}"]${asset.score.toFixed(1)}[/span]`:'[span class="quality-score" style="color:#96a2b6"]--[/span]';
    const model=asset.model&&asset.model!=='未关联'?`[span class="model-chip"]${escapeHtml(asset.model)}[/span]`:'[span class="model-chip empty"]未关联[/span]';
    const bundle=asset.bundleId?`${asset.bundleName||asset.bundleId} · ${asset.bundleRoleLabel||asset.bundleRole||'数据包文件'}`:'';
    return m(`[tr class="module-row ext-asset-row" data-name="${escapeHtml(asset.name)}" data-type="${escapeHtml(asset.type)}" data-id="${escapeHtml(asset.id)}"][td][b]${escapeHtml(asset.name)}[/b][br][small style="color:#96a2b6"]${escapeHtml(asset.format)} · ${escapeHtml(asset.createdAt)}[/small][/td][td]${typeBadge(asset.type)}[/td][td]${escapeHtml(asset.scene)}[br][small]${escapeHtml(asset.taskName||asset.taskId||'未关联生产任务')}[/small]${bundle?`[br][small style="color:#78b9df"]数据包：${escapeHtml(bundle)}[/small]`:''}[/td][td]${scaleText(asset.records)}[/td][td]${score}[/td][td]${model}[/td][td]${statusBadge(asset.status)}[/td][td][div class="row-actions"][button class="btn" data-asset-qc="${escapeHtml(asset.id)}"]质检[/button][button class="btn" data-asset-model="${escapeHtml(asset.id)}"]模型[/button][button class="btn" data-asset-detail="${escapeHtml(asset.id)}"]详情[/button][/div][/td][/tr]`);
  }
  function scaleText(records){const text=String(records??'已接入');if(text==='已接入'||text==='待解析')return text;if(/条|Episode|小时|帧|GB|MB/.test(text))return escapeHtml(text);return escapeHtml(text)+' 条记录'}
  function renderAssetRows(){
    const body=document.getElementById('assetRows');if(!body)return;
    const query=(document.getElementById('assetSearch')?.value||'').toLowerCase(),type=document.getElementById('assetTypeFilter')?.value||'all',status=document.getElementById('assetStatusFilter')?.value||'all',model=document.getElementById('assetModelFilter')?.value||'all';
    const assets=getAssets();
    const rows=assets.filter(asset=>(type==='all'||asset.type===type)&&(status==='all'||asset.status===status)&&(model==='all'||asset.model===model)&&(`${asset.name} ${asset.scene} ${asset.model} ${asset.node} ${asset.taskId} ${asset.taskName}`.toLowerCase().includes(query)));
    body.innerHTML=rows.length?rows.map(assetRow).join(''):m('[tr][td colspan="8"][div class="empty-inline"]没有符合条件的资产，点击右上角「导入数据」开始[/div][/td][/tr]');
    const modelSelect=document.getElementById('assetModelFilter');
    if(modelSelect)modelSelect.innerHTML=m(`[option value="all"]全部模型[/option]`)+getModels().map(item=>m(`[option value="${escapeHtml(item.id)}"]${escapeHtml(item.id)}[/option]`)).join('')+m(`[option value="未关联"]未关联[/option]`);
    if(modelSelect)modelSelect.value=model;
    const count=value=>assets.filter(asset=>asset.type===value).length;
    const setText=(id,value)=>{const node=document.getElementById(id);if(node)node.textContent=value};
    setText('assetKpiUmi',count('UMI'));setText('assetKpiEgo',count('EGO'));setText('assetKpiTele',count('遥操'));
    setText('assetKpiPending',assets.filter(asset=>['待质检','待深检','待补传'].includes(asset.status)||!asset.lastQcAt).length);
    body.querySelectorAll('.ext-asset-row').forEach(row=>{const cell=document.createElement('td'),input=document.createElement('input');input.type='checkbox';input.className='asset-select';input.value=row.dataset.id;input.checked=selectedAssetIds.has(row.dataset.id);input.title='选择资产';input.onclick=event=>event.stopPropagation();input.onchange=()=>{if(input.checked)selectedAssetIds.add(input.value);else selectedAssetIds.delete(input.value);updateAssetBulkControls()};cell.appendChild(input);row.prepend(cell)});
    body.querySelectorAll('.ext-asset-row').forEach(row=>{
      row.onclick=()=>openAssetDrawer(row.dataset.name);
      row.querySelector('[data-asset-detail]').onclick=event=>{event.stopPropagation();openAssetDrawer(row.dataset.name)};
      row.querySelector('[data-asset-qc]').onclick=event=>{event.stopPropagation();runSingleAssetQc(row.dataset.id)};
      row.querySelector('[data-asset-model]').onclick=event=>{event.stopPropagation();openModelPicker(row.dataset.id)};
      if(authUser?.canDeleteData===true){const actions=row.querySelector('.row-actions'),button=document.createElement('button');button.className='btn danger';button.title='删除资产';button.innerHTML='<i data-lucide="trash-2"></i>删除';button.onclick=event=>{event.stopPropagation();deleteAsset(row.dataset.id)};actions?.appendChild(button)}
    });
    ensureAssetBulkControls();updateAssetBulkControls();
    lucide.createIcons();
  }
  function bindAssetsPage(){
    const importButton=document.getElementById('assetImportBtn');
    if(importButton)importButton.onclick=startImportWizard;
    const pending=document.getElementById('assetQcPending');
    if(pending)pending.onclick=async()=>{pending.disabled=true;try{const batch=await createQcBatch('待质检数据','标准质检','全部模型');if(!batch){showToast('当前没有待质检数据');return}renderAssetRows();showToast(`证据型质检完成：通过率 ${batch.passRate}%，发现 ${batch.issueCount} 个问题`)}catch(error){showToast(error.message)}finally{pending.disabled=false}};
    const exportButton=document.getElementById('assetExportBtn');
    if(exportButton)exportButton.onclick=()=>downloadCsv('data-assets.csv',getAssets().map(asset=>({资产名称:asset.name,类型:asset.type,采集场景:asset.scene,生产任务编号:asset.taskId||'',生产任务名称:asset.taskName||'',规模:asset.records,采集节点:asset.node,关联模型:asset.model,质量评分:asset.score||'',质检状态:asset.status,质检模板:asset.qcTemplate,标注状态:asset.annotationStatus,导入时间:asset.createdAt})));
    ['assetSearch','assetTypeFilter','assetStatusFilter','assetModelFilter'].forEach(id=>{const node=document.getElementById(id);if(node)node.addEventListener(id==='assetSearch'?'input':'change',renderAssetRows)});
    renderAssetRows();
  }
  function openAssetDrawer(name){
    const asset=findAsset(name);if(!asset){setDrawerData(name,'UMI');openDrawer('数据资产详情');return}
    setDrawerData(asset.name,asset.type,asset.records);openDrawer('数据资产详情');
  }
  async function runSingleAssetQc(assetId){
    const asset=getAssets().find(item=>item.id===assetId);if(!asset)return;
    try{const batch=await createQcBatch('指定资产',asset.qcTemplate||'标准质检','全部模型',[assetId]);if(!batch){showToast('资产不存在或不在检测范围');return}renderAssetRows();const result=batch.results[0];showToast(`${asset.name}：${result.status}${result.score==null?'':` · ${result.score} 分`} · ${result.issues.length} 个问题`)}catch(error){showToast(error.message)}
  }
  async function deleteAsset(assetId){
    const asset=getAssets().find(item=>item.id===assetId);if(!asset)return;
    if(!window.confirm(`确定删除资产“${asset.name}”吗？这会同时删除服务端原始文件、问题单、标注任务和质检结果，且不可恢复。`))return;
    try{const response=await fetch(`/api/assets/${encodeURIComponent(assetId)}`,{method:'DELETE'}),data=await response.json();if(!response.ok)throw new Error(data.error||'资产删除失败');saveAssets(getAssets().filter(item=>item.id!==assetId));await syncServerState();moduleTemplates.assets=assetsTemplate();showPage('assets');showToast(`资产 ${asset.name} 已删除`)}catch(error){showToast(error.message||'资产删除失败')}
  }
  function updateAssetBulkControls(){const count=selectedAssetIds.size,badge=document.getElementById('assetBulkCount'),button=document.getElementById('assetBulkDelete');if(badge)badge.textContent=`已选择 ${count} 个`;if(button)button.disabled=!count;document.querySelectorAll('.asset-select').forEach(input=>{input.checked=selectedAssetIds.has(input.value)})}
  function ensureAssetBulkControls(){if(authUser?.canDeleteData!==true)return;const toolbar=document.querySelector('#moduleContent .ext-toolbar');if(!toolbar||document.getElementById('assetBulkActions'))return;const box=document.createElement('div');box.id='assetBulkActions';box.style.cssText='display:flex;align-items:center;gap:6px;margin-left:auto';box.innerHTML='<span id="assetBulkCount" style="color:#7e8da3;font-size:12px">已选择 0 个</span><button class="btn" id="assetSelectAll" type="button">全选当前</button><button class="btn" id="assetClearAll" type="button">清除选择</button><button class="btn danger" id="assetBulkDelete" type="button" disabled><i data-lucide="trash-2"></i>批量删除</button>';toolbar.appendChild(box);document.getElementById('assetSelectAll').onclick=()=>{document.querySelectorAll('#assetRows .ext-asset-row').forEach(row=>selectedAssetIds.add(row.dataset.id));updateAssetBulkControls()};document.getElementById('assetClearAll').onclick=()=>{selectedAssetIds.clear();updateAssetBulkControls()};document.getElementById('assetBulkDelete').onclick=batchDeleteAssets;lucide.createIcons()}
  async function batchDeleteAssets(){const ids=[...selectedAssetIds];if(!ids.length)return;if(!window.confirm(`确定批量删除 ${ids.length} 个资产吗？将同时删除服务端原始文件及关联质检记录，且不可恢复。`))return;const button=document.getElementById('assetBulkDelete');if(button)button.disabled=true;try{const response=await fetch('/api/assets/bulk-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})}),data=await response.json();if(!response.ok)throw new Error(data.error||'批量删除失败');selectedAssetIds.clear();saveAssets(getAssets().filter(item=>!ids.includes(item.id)));await syncServerState();moduleTemplates.assets=assetsTemplate();showPage('assets');showToast(`已批量删除 ${data.removedCount||ids.length} 个资产`)}catch(error){if(button)button.disabled=false;showToast(error.message||'批量删除失败')}}
  function detectType(name){
    const text=String(name).toLowerCase();
    if(/umi/.test(text))return {type:'UMI',reason:'文件名包含 UMI',confident:true};
    if(/ego|first[-_]?person|egocentric/.test(text))return {type:'EGO',reason:'文件名包含 EGO',confident:true};
    if(/teleop|tele|遥操|lerobot(?:[._-]?v?2)?|joint(?:[_-]?state)?|master|slave|op-|op_/.test(text))return {type:'遥操',reason:'目录或文件名包含遥操、LeRobot、joint 或控制流关键字',confident:true};
    return {type:'',reason:'未识别到类型关键字',confident:false};
  }
  function importPathParts(file){return String(file.webkitRelativePath||file.name||'').split(/[/\\]+/).filter(Boolean)}
  function detectImportGroup(file){
    const parts=importPathParts(file),folders=parts.slice(0,-1).map(part=>part.toLowerCase()),name=String(file.name||parts.at(-1)||'').toLowerCase();
    if(folders.some(part=>/^(meta|mata|metadata|config|configs|calib|calibration)$/.test(part)))return 'meta';
    if(folders.some(part=>/^(video|videos|image|images|camera|cameras|media|rgb|depth)$/.test(part)))return 'media';
    if(folders.some(part=>/^(data|trajectory|trajectories|record|records|state|states|action|actions)$/.test(part)))return 'trajectory';
    if(/\.(mp4|mov|webm|avi|mkv|jpg|jpeg|png)$/.test(name))return 'media';
    if(/(^|[_-])(info|stats|schema|modality|manifest|task|episodes?)([_\-.]|$)/.test(name))return 'meta';
    return 'trajectory';
  }
  function isImportNoise(file){const name=String(file.name||'').toLowerCase();return !name||name==='thumbs.db'||name==='desktop.ini'||name==='.ds_store'||name.startsWith('._')}
  function analyzeImportFolder(files,roles=[]){
    const paths=files.map(importPathParts),roots=[...new Set(paths.filter(parts=>parts.length>1).map(parts=>parts[0]))],rootName=roots.length===1?roots[0]:'',topFolders=[...new Set(paths.flatMap(parts=>parts.length>2?[parts[1]]:[]))],counts=Object.fromEntries(IMPORT_GROUPS.map(group=>[group.id,0]));
    files.forEach((file,index)=>{const role=roles[index]||detectImportGroup(file);if(counts[role]!=null)counts[role]+=1});
    return {rootName,roots,topFolders,counts,complete:IMPORT_GROUPS.every(group=>counts[group.id]>0),structured:rootName&&topFolders.length>0};
  }
  function importRoleOptions(selected){return IMPORT_GROUPS.map(group=>`[option value="${group.id}"${group.id===selected?' selected':''}]${group.label}[/option]`).join('')}
  function importFileRow(file,index,role){
    const path=file.webkitRelativePath&&file.webkitRelativePath!==file.name?` · ${escapeHtml(file.webkitRelativePath)}`:'';
    const group=IMPORT_GROUPS.find(item=>item.id===role)||IMPORT_GROUPS[1];
    return `[div class="import-file"][div class="import-file-main"][b]${escapeHtml(file.name)}[/b][small class="ok"]${(file.size/1048576).toFixed(2)} MB${path} · 当前归入${group.label}[/small][/div][select class="filter-select import-role" data-index="${index}">${importRoleOptions(role)}</select][button class="btn" type="button" data-remove-file="${index}" style="padding:5px 8px"]移除[/button][/div]`;
  }
  function importPresetSpec(type,preset){return (IMPORT_PRESETS[type]||[]).find(item=>item.id===preset)||{id:'single',label:'单文件 / 多文件兼容导入',required:false}}
  function importBundleSummary(state){
    const counts=Object.fromEntries(IMPORT_GROUPS.map(group=>[group.id,0]));state.roles.forEach(role=>{if(counts[role]!=null)counts[role]+=1});
    return IMPORT_GROUPS.map(group=>`[div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border:1px solid rgba(120,150,190,.18);border-radius:7px;background:rgba(15,30,52,.36)"][div style="min-width:0"][b]${group.label}[/b][small style="display:block;color:#8f9db1;margin-top:2px"]${group.hint} · ${counts[group.id]} 个文件[/small][/div][div style="display:flex;gap:6px;flex-shrink:0"][button class="btn" type="button" data-add-group="${group.id}" style="padding:5px 8px"]添加文件[/button][button class="btn" type="button" data-add-folder="${group.id}" style="padding:5px 8px"]选择文件夹[/button][/div][/div]`).join('');
  }
  function addImportFiles(role,files){
    const state=globalThis.importWizardState;if(!state)return;
    captureImportDraft();
    const existing=new Set(state.files.map(file=>`${file.webkitRelativePath||file.name}|${file.size}|${file.lastModified||0}`));
    [...files].forEach(file=>{const key=`${file.webkitRelativePath||file.name}|${file.size}|${file.lastModified||0}`;if(existing.has(key))return;existing.add(key);state.files.push(file);state.roles.push(role)});
    renderImportWizard();showToast(`已加入 ${role==='meta'?'meta':role==='trajectory'?'data':'video'} 文件组`);
  }
  function openImportGroupPicker(role,folder=false){
    const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='.json,.jsonl,.csv,.parquet,.mcap,.bag,.h5,.hdf5,.npz,.yaml,.yml,.toml,.mp4,.mov,.webm,.avi,.jpg,.jpeg,.png,.zip';
    if(folder){input.setAttribute('webkitdirectory','');input.setAttribute('directory','');}
    input.style.display='none';document.body.appendChild(input);input.onchange=()=>{if(input.files?.length)addImportFiles(role,input.files);input.remove()};input.click();
  }
  function captureImportDraft(){
    const state=globalThis.importWizardState;if(!state)return;
    ['importScene','importNode','importTask','importModel','importTemplate','importAnnotation','importRunQc','importBundleName'].forEach(id=>{const node=document.getElementById(id);if(node)state.draft[id]=node.value});
  }
  function renderImportWizard(){
    const state=globalThis.importWizardState;if(!state)return;
    const type=state.type,presetSpec=importPresetSpec(type,state.preset),draft=state.draft||{},box=document.getElementById('importWizard'),folder=analyzeImportFolder(state.files,state.roles);
    const rows=state.files.map((file,index)=>importFileRow(file,index,state.roles[index])).join('');
    const typeOptions=`[option value=""${type?'':' selected'}]请选择数据类型[/option]`+DATA_TYPES.map(item=>`[option value="${item}"${item===type?' selected':''}]${item}[/option]`).join('');
    const presetOptions=(IMPORT_PRESETS[type]||[]).map(item=>`[option value="${item.id}"${item.id===state.preset?' selected':''}]${item.label}[/option]`).join('');
    const modelOptions=getModels().map(item=>`[option value="${escapeHtml(item.id)}"]`).join('');
    const registeredNodes=extRead('embodiedNodes',[]),nodeOptions=['[option value="未绑定"]未绑定采集节点[/option]',...registeredNodes.map(node=>`[option value="${escapeHtml(node.id)}"${node.id===draft.importNode?' selected':''}]${escapeHtml(node.id)} · ${escapeHtml(node.type)} · ${escapeHtml(node.site)} · ${escapeHtml(node.status)}[/option]`)].join('');
    const activeTasks=readStore(storageKey.tasks).filter(task=>!['待验收','已完成'].includes(task.status)),taskOptions=['[option value=""]不归属采集任务[/option]',...activeTasks.map(task=>`[option value="${escapeHtml(task.id)}"${task.id===draft.importTask?' selected':''}]${escapeHtml(task.id)} · ${escapeHtml(task.type)} · ${escapeHtml(task.name)}[/option]`)].join('');
    box.innerHTML=m(`
      [div class="search-box" style="width:min(820px,calc(100vw - 30px))"]
        [div class="popover-head"][span]总文件夹导入 · 共 ${state.files.length} 个文件[/span][button class="close" id="importWizardClose"][i data-lucide="x"][/i][/button][/div]
        [div style="padding:17px;max-height:70vh;overflow:auto"]
          [div class="issue-evidence" style="margin-bottom:16px"][b]${folder.rootName?`已识别根目录：${escapeHtml(folder.rootName)}`:'请添加数据集文件' }[/b][span]${folder.structured?`子目录：${escapeHtml(folder.topFolders.join('、'))}`:'系统将依据目录名和文件格式识别分组'}[/span][p]识别结果：meta ${folder.counts.meta} 个 · data ${folder.counts.trajectory} 个 · video ${folder.counts.media} 个${folder.complete?' · 三组完整':' · 仍有分组缺失'}</p][/div]
          [div class="panel-title" style="font-size:12px"]1. 数据类型与格式预设[/div]
          [div class="panel-sub" style="margin-bottom:11px"]系统会根据总目录名自动判断 UMI、EGO 或遥操；无法可靠判断时才需要手工选择。[/div]
          [div class="form-row"][div][label]数据类型 <span style="color:#eea76a">*</span>[/label][select class="select" style="width:100%" id="importDataType"]${typeOptions}[/select][/div][div][label]数据包预设 <span style="color:#eea76a">*</span>[/label][select class="select" style="width:100%" id="importPreset"]${presetOptions||'[option]请选择数据类型[/option]'}[/select][/div][/div]
          [div class="panel-sub" style="margin:8px 0 14px"]${escapeHtml(presetSpec.label)}：${presetSpec.required?'必须包含三组文件后才能提交。':'允许单组或多组文件，系统仍会记录文件组关系。'}[/div]
          [div class="panel-title" style="font-size:12px"]2. 文件分组 <button class="btn" style="float:right;padding:4px 9px;font-size:11px" id="importAutoGroup" type="button">按路径自动分组</button>[/div]
          [div class="panel-sub" style="margin-bottom:11px"]已按相对路径自动识别 meta、data、video/videos 子目录。只有目录命名不规范时才需要在下方手工调整或补充文件。[/div]
          [div class="check-list" style="padding:0"]${rows}[/div]
          [div style="display:grid;gap:7px;margin-top:10px"]${importBundleSummary(state)}[/div]
          [details class="import-advanced"][summary]高级设置（可选） · 批次信息、节点、模型和质检策略[/summary]
          [div class="panel-title" style="font-size:12px;margin-top:15px"]3. 批次信息（应用到本次全部文件）[/div]
          [div class="ext-form" style="padding:0"]
            [div class="form-row"][div][label]数据包名称[/label][input class="input" style="width:100%" id="importBundleName" value="${escapeHtml(draft.importBundleName||'')}" placeholder="例如：teleop_assembly_2026-09-23" /][/div][div][label]采集场景[/label][input class="input" style="width:100%" id="importScene" value="${escapeHtml(draft.importScene||'')}" placeholder="例如：双臂装配" /][/div][/div]
            [div class="form-row"][div][label]采集节点[/label][select class="select" style="width:100%" id="importNode"]${nodeOptions}[/select][/div][div][label]归属采集任务[/label][select class="select" style="width:100%" id="importTask"]${taskOptions}[/select][/div][/div]
            [div class="form-row"][div][label]模型编号（可选）[/label][input class="input" style="width:100%" id="importModel" list="importModelSuggestions" value="${escapeHtml(draft.importModel==='未关联'?'':draft.importModel||'')}" placeholder="输入实际模型编号" /][datalist id="importModelSuggestions"]${modelOptions}[/datalist][/div][div][label]质检模板[/label][select class="select" style="width:100%" id="importTemplate">${QC_TEMPLATES.map(name=>`[option${name===(draft.importTemplate||'标准质检')?' selected':''}]${name}[/option]`).join('')}[/select][/div][/div]
            [div class="form-row"][div][label]标注状态[/label][select class="select" style="width:100%" id="importAnnotation">${['未标注','标注中','已标注'].map(name=>`[option${name===(draft.importAnnotation||'未标注')?' selected':''}]${name}[/option]`).join('')}</select>[/div][div][label]导入后立即质检[/label][select class="select" style="width:100%" id="importRunQc"><option value="yes"${(draft.importRunQc||'yes')==='yes'?' selected':''}>是，导入后自动质检</option><option value="no"${draft.importRunQc==='no'?' selected':''}>否，稍后手动质检</option></select>[/div][/div]
          [/div][/details]
        [/div]
        [div class="modal-foot"][button class="btn" id="importWizardCancel" type="button"]取消[/button][button class="btn primary" id="importWizardSubmit" type="button"][i data-lucide="package-plus"][/i]确认导入数据包[/button][/div]
      [/div]`);
    box.classList.add('show');lucide.createIcons();
    document.getElementById('importWizardClose').onclick=()=>box.classList.remove('show');
    document.getElementById('importWizardCancel').onclick=()=>box.classList.remove('show');
    document.getElementById('importDataType').onchange=event=>{captureImportDraft();state.type=event.target.value;state.preset=(IMPORT_PRESETS[state.type]||[])[0]?.id||'single';renderImportWizard()};
    document.getElementById('importPreset').onchange=event=>{captureImportDraft();state.preset=event.target.value;renderImportWizard()};
    document.querySelectorAll('.import-role').forEach(select=>select.onchange=event=>{state.roles[Number(event.target.dataset.index)]=event.target.value;renderImportWizard()});
    document.querySelectorAll('[data-remove-file]').forEach(button=>button.onclick=()=>{captureImportDraft();const index=Number(button.dataset.removeFile);state.files.splice(index,1);state.roles.splice(index,1);renderImportWizard()});
    document.querySelectorAll('[data-add-group]').forEach(button=>button.onclick=()=>openImportGroupPicker(button.dataset.addGroup,false));
    document.querySelectorAll('[data-add-folder]').forEach(button=>button.onclick=()=>openImportGroupPicker(button.dataset.addFolder,true));
    document.getElementById('importAutoGroup').onclick=()=>{state.roles=state.files.map(file=>detectImportGroup(file));renderImportWizard();showToast('已按文件路径和扩展名自动完成分组')};
    document.getElementById('importWizardSubmit').onclick=confirmImport;
  }
  function openImportWizard(files){
    const list=[...files].filter(file=>!isImportNoise(file));if(!list.length){showToast('所选文件夹没有可导入的数据文件');return}
    const roles=list.map(file=>detectImportGroup(file)),folder=analyzeImportFolder(list,roles),detectSource=[folder.rootName,...folder.topFolders,...list.slice(0,20).map(file=>file.name)].join(' '),detected=detectType(detectSource),type=detected.confident?detected.type:'',preset=folder.complete?(type==='遥操'?'lerobot-v21':'standard-3'):((IMPORT_PRESETS[type]||[])[0]?.id||'single');
    globalThis.importWizardState={files:list,roles,type,preset,draft:{importBundleName:folder.rootName||'',importScene:folder.rootName||'',importTemplate:'标准质检',importAnnotation:'未标注',importRunQc:'yes'},folder};
    renderImportWizard();
  }
  function startImportWizard(){
    const input=document.createElement('input');input.type='file';input.multiple=true;input.setAttribute('webkitdirectory','');input.setAttribute('directory','');input.style.display='none';document.body.appendChild(input);
    input.onchange=()=>{const files=input.files?[...input.files]:[];input.remove();if(files.length)openImportWizard(files)};
    input.oncancel=()=>input.remove();input.click();
  }
  async function confirmImport(){
    const state=globalThis.importWizardState||{files:[],roles:[],type:'',preset:'single',draft:{}};
    captureImportDraft();
    const files=state.files,type=state.type,preset=state.preset,presetSpec=importPresetSpec(type,preset),roleCounts=Object.fromEntries(IMPORT_GROUPS.map(group=>[group.id,0]));state.roles.forEach(role=>{if(roleCounts[role]!=null)roleCounts[role]+=1});
    if(!files.length){showToast('请至少添加一个数据文件或文件夹');return}
    if(!type){showToast('请选择本批数据的真实类型（UMI、EGO 或遥操）');document.getElementById('importDataType')?.focus();return}
    const missingRoles=presetSpec.required?IMPORT_GROUPS.filter(group=>!roleCounts[group.id]):[];
    if(missingRoles.length){showToast(`${presetSpec.label}缺少：${missingRoles.map(group=>group.label).join('、')}，请为每组至少选择一个文件`);return}
    const folder=analyzeImportFolder(files,state.roles),scene=document.getElementById('importScene').value.trim()||'本地导入',node=document.getElementById('importNode').value,taskId=document.getElementById('importTask').value,task=readStore(storageKey.tasks).find(item=>item.id===taskId),registeredNode=extRead('embodiedNodes',[]).find(item=>item.id===node),model=document.getElementById('importModel').value.trim()||'未关联',template=document.getElementById('importTemplate').value,annotationStatus=document.getElementById('importAnnotation').value,autoQc=document.getElementById('importRunQc').value==='yes',bundleId='BND-'+Date.now().toString(36).toUpperCase(),bundleName=document.getElementById('importBundleName').value.trim()||folder.rootName||`${type}-${preset}-${new Date().toISOString().slice(0,10)}`;
    if(task&&task.type!==type){showToast(`采集任务 ${task.id} 仅接收 ${task.type} 数据`);return}
    if(registeredNode&&registeredNode.type!==type){showToast(`采集节点 ${node} 仅接收 ${registeredNode.type} 数据`);return}
    const linkedModel=modelOf(model);if(linkedModel&&linkedModel.type!==type){showToast(`模型 ${model} 仅支持 ${linkedModel.type} 数据，请调整数据类型或模型`);return}
    const button=document.getElementById('importWizardSubmit');button.disabled=true;button.textContent='正在解析并上传数据包…';
    const created=[];
    try{for(let index=0;index<files.length;index+=1){
      const file=files[index],role=state.roles[index],roleInfo=IMPORT_GROUPS.find(group=>group.id===role)||IMPORT_GROUPS[1];
      button.textContent=`正在上传 ${index+1}/${files.length} · ${roleInfo.label}`;
      let records='已接入',inspection=null;try{const summary=await summarizeImport(file);records=summary.records;inspection=summary.inspection||null}catch{records='已接入'}
      const relativePath=file.webkitRelativePath||file.name,pathParts=importPathParts(file),mediaMetadata=await inspectMediaFile(file),localRecord={id:'AST-'+Date.now().toString(36).toUpperCase()+'-'+index,name:file.name,type,size:file.size,format:(file.name.split('.').pop()||'file').toUpperCase(),records,inspection,mediaMetadata,scene,node,taskId,taskName:task?.name||'',model,qcTemplate:template,annotationStatus,createdAt:nowLabel(),score:0,status:'待质检',lastQcAt:'',bundleId,bundleName,bundlePreset:preset,bundleRole:role,bundleRoleLabel:roleInfo.label,bundleFileIndex:index+1,bundleFileCount:files.length,relativePath,sourceRoot:folder.rootName||'',sourceFolder:pathParts.length>2?pathParts[1]:role};
      const serverRecord=globalThis.platformUploadAsset?await globalThis.platformUploadAsset(file,localRecord):null;created.push(serverRecord?{...localRecord,...serverRecord}:localRecord);
    }}catch(error){button.textContent='上传失败，正在回滚本批数据…';let rollbackNote='';try{const response=await fetch('/api/imports/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bundleId})}),data=await response.json();if(!response.ok)throw new Error(data.error||'自动回滚失败');rollbackNote=`，已回滚 ${data.removedCount||0} 个已创建资产`}catch(rollbackError){rollbackNote=`；自动回滚失败：${rollbackError.message}`}button.disabled=false;button.innerHTML=m('[i data-lucide="package-plus"][/i]重新尝试导入');lucide.createIcons();await syncServerState();showToast(`${error.message||'文件上传失败'}${rollbackNote}`);return}
    saveAssets([...getAssets(),...created]);addAudit('导入数据包',bundleName,`${created.length} 个文件 · ${type} · ${presetSpec.label} · ${bundleId} · 任务 ${taskId||'未关联'} · 模型 ${model}`);document.getElementById('importWizard').classList.remove('show');if(currentPage==='assets')showPage('assets');
    let message=`已导入数据包「${bundleName}」：${created.length} 个文件，${type}`;
    if(autoQc){const batch=await createQcBatch('本次导入数据包',template,model||'全部模型',created.map(item=>item.id));if(currentPage==='assets')renderAssetRows();if(batch)message+=` · 证据型质检通过率 ${batch.passRate}%，${batch.issueCount} 个问题`}
    await syncServerState();showToast(message);
  }
  function assetModelOptions(selected,assetType){const compatible=getModels().filter(item=>!assetType||item.type===assetType);return ['[option value="未关联"]未关联[/option]',...compatible.map(item=>`[option value="${escapeHtml(item.id)}"${item.id===selected?' selected':''}]${escapeHtml(item.id)} · ${escapeHtml(item.type)}[/option]`)].join('')}
  function openModelPicker(assetId){
    const asset=getAssets().find(item=>item.id===assetId);if(!asset)return;
    const box=document.getElementById('modelPicker');
    box.innerHTML=m(`[div class="search-box" style="width:min(520px,calc(100vw - 30px))"]
      [div class="popover-head"][span]关联模型 · ${escapeHtml(asset.name)}[/span][button class="close" id="modelPickerClose"][i data-lucide="x"][/i][/button][/div]
      [div style="padding:17px"][div class="field"][label]模型编号[/label][input class="input" style="width:100%" id="modelPickerSelect" list="modelPickerSuggestions" value="${escapeHtml(asset.model==='未关联'?'':asset.model||'')}" placeholder="输入实际模型编号" /][datalist id="modelPickerSuggestions"]${getModels().map(item=>`[option value="${escapeHtml(item.id)}"]`).join('')}[/datalist][/div]
      [div class="panel-sub"]只记录资产与模型编号的关联，不表示模型已经接入训练系统。[/div][/div]
      [div class="modal-foot"][button class="btn" id="modelPickerCancel"]取消[/button][button class="btn primary" id="modelPickerSave"]保存关联[/button][/div][/div]`);
    box.classList.add('show');lucide.createIcons();
    document.getElementById('modelPickerClose').onclick=()=>box.classList.remove('show');
    document.getElementById('modelPickerCancel').onclick=()=>box.classList.remove('show');
    document.getElementById('modelPickerSave').onclick=async()=>{
      const value=document.getElementById('modelPickerSelect').value.trim()||'未关联';
      const save=document.getElementById('modelPickerSave');save.disabled=true;
      const updated={...asset,model:value},saved=await apiPost('/api/assets',updated);if(!saved){save.disabled=false;showToast('模型关联写入服务端失败');return}
      saveAssets(getAssets().map(item=>item.id===assetId?{...item,...saved.asset}:item));
      addAudit('调整模型关联',asset.name,`关联模型：${value}`);box.classList.remove('show');
      if(currentPage==='assets')renderAssetRows();if(currentPage==='models')showPage('models');
      showToast(`${asset.name} 已关联 ${value}`);
    };
  }
  function qcPageTemplate(){
    const batches=extRead('embodiedQcBatches'),assets=getAssets(),settings=getQualitySettings(),openIssues=extRead('embodiedIssues',[]).filter(item=>item.status!=='已关闭').length;
    const pending=assets.filter(asset=>['待质检','待深检','待补传'].includes(asset.status)||!asset.lastQcAt).length;
    const lastBatch=batches[0];
    return m(`
      [div class="ext-kpis"]
        [div class="ext-kpi"][span]待质检资产[/span][b]${pending}[/b][small]共 ${assets.length} 个资产[/small][/div]
        [div class="ext-kpi"][span]质检批次[/span][b]${batches.length}[/b][small]保留最近 50 次记录[/small][/div]
        [div class="ext-kpi"][span]最近通过率[/span][b]${lastBatch?lastBatch.passRate+'%':'--'}[/b][small]${lastBatch?escapeHtml(lastBatch.template):'尚未执行质检'}[/small][/div]
        [div class="ext-kpi"][span]未关闭问题[/span][b]${openIssues}[/b][small]当前问题中心实时数量[/small][/div]
      [/div]
      [section class="panel"]
        [div class="panel-head"][div][div class="panel-title"]发起质量检测[/div][div class="panel-sub"]选择检测范围、规则模板与模型范围后执行，支持 UMI、EGO、遥操三类数据[/div][/div][/div]
        [div class="ext-toolbar"]
          [select class="filter-select" id="qcScope"][option]待质检数据[/option][option]全部数据[/option][option]UMI 数据[/option][option]EGO 数据[/option][option]遥操 数据[/option][option]未关联模型的数据[/option][/select]
          [select class="filter-select" id="qcTemplate"]${QC_TEMPLATES.map(name=>`[option${name==='标准质检'?' selected':''}]${name}[/option]`).join('')}[/select]
          [select class="filter-select" id="qcModel"][option value="全部模型"]全部模型[/option]${getModels().map(item=>`[option value="${escapeHtml(item.id)}"]${escapeHtml(item.id)}[/option]`).join('')}[/select]
          [span class="spacer"][/span]
          [button class="btn" id="qcExportIssues"][i data-lucide="file-warning"][/i]导出问题明细[/button]
          [button class="btn primary" id="qcRunBtn"][i data-lucide="play-circle"][/i]开始质检[/button]
        [/div]
        [div class="panel-sub" style="padding:0 18px 14px"]快速质检阈值 ${settings.thresholds?.['快速质检']??85} 分 · 标准质检阈值 ${settings.thresholds?.['标准质检']??90} 分 · 全量质检阈值 ${settings.thresholds?.['全量质检']??93} 分 · 当前规则由服务端执行并留存快照[/div]
      [/section]
      [section class="panel" style="margin-top:17px"]
        [div class="panel-head"][div][div class="panel-title"]质检批次记录[/div][div class="panel-sub"]每次检测生成一条批次，可查看报告、重跑或导出[/div][/div][/div]
        [div class="table-scroll"][table class="module-table"][thead][tr][th]批次号[/th][th]检测范围[/th][th]规则模板[/th][th]模型范围[/th][th]对象数[/th][th]通过率[/th][th]问题数[/th][th]耗时[/th][th]状态[/th][th]操作[/th][/tr][/thead]
        [tbody]${batches.length?batches.map(qcBatchRow).join(''):m('[tr][td colspan="10"][div class="empty-inline"]尚未执行质检，选择一个范围后点击「开始质检」[/div][/td][/tr]')}[/tbody][/table][/div]
      [/section]`);
  }
  function qcBatchRow(batch){
    return `[tr][td][b]${escapeHtml(batch.id)}[/b][br][small style="color:#96a2b6"]${escapeHtml(batch.createdAt)}[/small][/td][td]${escapeHtml(batch.scope)}[/td][td]${escapeHtml(batch.template)}[/td][td]${escapeHtml(batch.model)}[/td][td]${batch.total}[/td][td][span class="quality-score ${scoreClass(batch.passRate)}"]${batch.passRate}%[/span][/td][td]${batch.issueCount}[/td][td]${batch.duration} 秒[/td][td]${statusBadge(batch.status)}[/td][td][div class="row-actions"][button class="btn" data-qc-report="${batch.id}"]报告[/button][button class="btn" data-qc-rerun="${batch.id}"]重跑[/button][/div][/td][/tr]`;
  }
  function bindQcPage(){
    const runButton=document.getElementById('qcRunBtn');
    if(runButton)runButton.onclick=async()=>{
      runButton.disabled=true;runButton.textContent='正在质检…';
      try{const batch=await createQcBatch(document.getElementById('qcScope').value,document.getElementById('qcTemplate').value,document.getElementById('qcModel').value);if(!batch){showToast('所选范围没有可检测的数据');return}moduleTemplates.qc=qcPageTemplate();showPage('qc');showToast(`证据型质检完成：${batch.total} 个对象，通过率 ${batch.passRate}%，发现 ${batch.issueCount} 个问题`)}catch(error){showToast(error.message)}finally{runButton.disabled=false}
    };
    const exportButton=document.getElementById('qcExportIssues');
    if(exportButton)exportButton.onclick=()=>{
      const rows=extRead('embodiedQcBatches').flatMap(batch=>batch.results.flatMap(item=>item.issues.map(issue=>({批次:batch.id,数据资产:item.name,数据类型:item.type,关联模型:item.model,检测项:issue.metric,等级:issue.level,问题描述:issue.detail,质量分:item.score,状态:item.status}))));
      if(!rows.length){showToast('当前没有质检问题记录');return}downloadCsv('qc-issues.csv',rows);
    };
    document.querySelectorAll('[data-qc-report]').forEach(button=>button.onclick=()=>openQcReport(button.dataset.qcReport));
    document.querySelectorAll('[data-qc-rerun]').forEach(button=>button.onclick=async()=>{
      const batch=extRead('embodiedQcBatches').find(item=>item.id===button.dataset.qcRerun);if(!batch)return;
      const next=await createQcBatch(batch.scope,batch.template,batch.model,batch.targetIds);
      if(!next){showToast('该范围当前没有可检测的数据');return}
      moduleTemplates.qc=qcPageTemplate();showPage('qc');showToast(`批次 ${next.id} 重跑完成，通过率 ${next.passRate}%`);
    });
  }
  function openQcReport(batchId){
    const batch=extRead('embodiedQcBatches').find(item=>item.id===batchId);if(!batch)return;
    const box=document.getElementById('qcReport');
    box.innerHTML=m(`[div class="search-box" style="width:min(900px,calc(100vw - 30px))"]
      [div class="popover-head"][span]质检报告 · ${escapeHtml(batch.id)}[/span][button class="close" id="qcReportClose"][i data-lucide="x"][/i][/button][/div]
      [div style="padding:17px;max-height:74vh;overflow:auto"]
        [div class="detail-grid"]
          [div class="detail-card"][span]检测范围[/span][b]${escapeHtml(batch.scope)}[/b][/div]
          [div class="detail-card"][span]规则模板[/span][b]${escapeHtml(batch.template)}[/b][/div]
          [div class="detail-card"][span]通过率[/span][b]${batch.passRate}%[/b][/div]
          [div class="detail-card"][span]问题总数[/span][b]${batch.issueCount}[/b][/div]
          [div class="detail-card"][span]模型范围[/span][b]${escapeHtml(batch.model)}[/b][/div]
          [div class="detail-card"][span]执行人 / 时间[/span][b]${escapeHtml(batch.operator)} · ${escapeHtml(batch.createdAt)}[/b][/div]
        [/div]
        [div class="table-scroll"][table class="module-table"][thead][tr][th]数据资产[/th][th]类型[/th][th]关联模型[/th][th]质量分[/th][th]同步[/th][th]完整[/th][th]动作[/th][th]传感器[/th][th]问题[/th][th]结论[/th][/tr][/thead][tbody]
        ${batch.results.map(item=>`[tr][td][b]${escapeHtml(item.name)}[/b][br][small]${escapeHtml((item.evidence||[]).join(' · '))}[/small][/td][td]${typeBadge(item.type)}[/td][td]${escapeHtml(item.model)}[/td][td][span class="quality-score ${scoreClass(item.score||0)}"]${item.score??'--'}[/span][/td][td]${item.detail.sync==null?'--':item.detail.sync+'%'}[/td][td]${item.detail.complete==null?'--':item.detail.complete+'%'}[/td][td]${item.detail.action==null?'--':item.detail.action+'%'}[/td][td]${item.detail.sensor==null?'--':item.detail.sensor+'%'}[/td][td]${item.issues.length?escapeHtml(item.issues.map(issue=>issue.metric).join('、')):'—'}[/td][td]${statusBadge(item.status)}[/td][/tr]`).join('')}
        [/tbody][/table][/div]
      [/div]
      [div class="modal-foot"][button class="btn" id="qcReportExport"][i data-lucide="download"][/i]导出报告[/button][button class="btn primary" id="qcReportOk"]关闭[/button][/div][/div]`);
    box.classList.add('show');lucide.createIcons();
    document.getElementById('qcReportClose').onclick=()=>box.classList.remove('show');
    document.getElementById('qcReportOk').onclick=()=>box.classList.remove('show');
    document.getElementById('qcReportExport').onclick=()=>downloadJson(`${batch.id}-report.json`,batch);
  }
  function modelsTemplate(){
    const models=getModels(),assets=getAssets();
    return m(`
      [div class="ext-kpis"]
        [div class="ext-kpi"][span]已登记模型[/span][b]${models.length}[/b][small]策略模型清单[/small][/div]
        [div class="ext-kpi"][span]已关联资产[/span][b]${assets.filter(asset=>asset.model&&asset.model!=='未关联').length}[/b][small]共 ${assets.length} 个资产[/small][/div]
        [div class="ext-kpi"][span]未关联资产[/span][b]${assets.filter(asset=>!asset.model||asset.model==='未关联').length}[/b][small]需要在导入或此处补充关联[/small][/div]
        [div class="ext-kpi"][span]线上模型[/span][b]${models.filter(model=>model.status==='已上线').length}[/b][small]可用于训练与回流[/small][/div]
      [/div]
      [section class="panel"]
        [div class="panel-head"][div][div class="panel-title"]策略模型清单[/div][div class="panel-sub"]登记模型并维护其关联的数据集与数据资产[/div][/div][button class="btn primary" id="modelAddBtn"][i data-lucide="plus"][/i]登记模型[/button][/div]
        [div class="table-scroll"][table class="module-table"][thead][tr][th]模型编号[/th][th]策略类型[/th][th]数据类型[/th][th]关联数据集[/th][th]关联数据资产[/th][th]评测指标[/th][th]状态[/th][th]操作[/th][/tr][/thead]
        [tbody]${models.map(model=>modelRow(model,assets)).join('')}[/tbody][/table][/div]
      [/section]
      [section class="panel" style="margin-top:17px"]
        [div class="panel-head"][div][div class="panel-title"]数据与模型关联明细[/div][div class="panel-sub"]修改后立即生效，并写入审计日志[/div][/div][/div]
        [div class="table-scroll"][table class="module-table"][thead][tr][th]数据资产[/th][th]类型[/th][th]采集场景[/th][th]质量评分[/th][th]关联模型[/th][/tr][/thead]
        [tbody]${assets.length?assets.map(asset=>associationRow(asset)).join(''):m('[tr][td colspan="5"][div class="empty-inline"]暂无数据资产[/div][/td][/tr]')}[/tbody][/table][/div]
      [/section]`);
  }
  function modelRow(model,assets){
    const linked=assets.filter(asset=>asset.model===model.id);
    const ratio=assets.length?Math.round(linked.length/Math.max(1,assets.length)*100):0;
    return `[tr][td][b]${escapeHtml(model.id)}[/b][/td][td]${escapeHtml(model.policy)}[/td][td]${typeBadge(model.type)}[/td][td]${escapeHtml(model.dataset)}[/td][td]${linked.length} 个资产[div class="mini-progress" style="margin-top:6px"][i style="width:${ratio}%"] [/i][/div][/td][td]${escapeHtml(model.metric)}[/td][td]${statusBadge(model.status)}[/td][td][button class="btn" data-model-focus="${escapeHtml(model.id)}"]查看数据[/button][/td][/tr]`;
  }
  function associationRow(asset){
    return `[tr][td][b]${escapeHtml(asset.name)}[/b][/td][td]${typeBadge(asset.type)}[/td][td]${escapeHtml(asset.scene)}[/td][td]${asset.score?`[span class="quality-score ${scoreClass(asset.score)}"]${asset.score.toFixed(1)}[/span]`:'--'}[/td][td][select class="filter-select asset-model-select" data-asset-id="${escapeHtml(asset.id)}"]${assetModelOptions(asset.model,asset.type)}[/select][/td][/tr]`;
  }
  function bindModelsPage(){
    document.querySelectorAll('.asset-model-select').forEach(select=>select.onchange=async()=>{
      const asset=getAssets().find(item=>item.id===select.dataset.assetId);if(!asset)return;
      const updated={...asset,model:select.value};select.disabled=true;
      const saved=await apiPost('/api/assets',updated);if(!saved){select.disabled=false;showToast('模型关联写入服务端失败');return}
      saveAssets(getAssets().map(item=>item.id===asset.id?{...item,...saved.asset}:item));
      addAudit('调整模型关联',asset.name,`关联模型：${select.value}`);showPage('models');showToast(`${asset.name} 已关联 ${select.value}`);
    });
    document.querySelectorAll('[data-model-focus]').forEach(button=>button.onclick=()=>{
      const model=button.dataset.modelFocus;
      const assets=getAssets().filter(asset=>asset.model===model);
      if(!assets.length){showToast(`${model} 暂未关联数据资产`);return}
      downloadCsv(`${model}-assets.csv`,assets.map(asset=>({数据资产:asset.name,类型:asset.type,场景:asset.scene,规模:asset.records,质量评分:asset.score||''})));
    });
    const addButton=document.getElementById('modelAddBtn');
    if(addButton)addButton.onclick=()=>{
      const box=document.getElementById('modelPicker');
      box.innerHTML=m(`[div class="search-box" style="width:min(520px,calc(100vw - 30px))"]
        [div class="popover-head"][span]登记策略模型[/span][button class="close" id="modelPickerClose"][i data-lucide="x"][/i][/button][/div]
        [div style="padding:17px"]
          [div class="field"][label]模型编号[/label][input id="newModelId" placeholder="例如：ACT-HM-040" /][/div]
          [div class="field"][label]策略类型[/label][select id="newModelPolicy"][option]ACT[/option][option]Diffusion Policy[/option][option]SmolVLA[/option][option]GR00T N1[/option][/select][/div]
          [div class="field"][label]数据类型[/label][select id="newModelType"][option]UMI[/option][option]EGO[/option][option]遥操[/option][/select][/div]
          [div class="field"][label]关联数据集[/label][input id="newModelDataset" placeholder="例如：Household-Manipulation v3.2.1" /][/div]
        [/div]
        [div class="modal-foot"][button class="btn" id="modelPickerCancel"]取消[/button][button class="btn primary" id="newModelSave"]保存[/button][/div][/div]`);
      box.classList.add('show');lucide.createIcons();
      document.getElementById('modelPickerClose').onclick=()=>box.classList.remove('show');
      document.getElementById('modelPickerCancel').onclick=()=>box.classList.remove('show');
      document.getElementById('newModelSave').onclick=()=>{
        const id=document.getElementById('newModelId').value.trim();
        if(!id){showToast('请填写模型编号');return}
        if(getModels().some(model=>model.id===id)){showToast('该模型编号已存在');return}
        const models=[...getModels(),{id,policy:document.getElementById('newModelPolicy').value,type:document.getElementById('newModelType').value,dataset:document.getElementById('newModelDataset').value.trim()||'未关联数据集',datasetCount:0,status:'评测中',metric:'待评测',updated:nowLabel()}];
        extWrite('embodiedModels',models);addAudit('登记策略模型',id,'已加入模型清单');box.classList.remove('show');showPage('models');showToast(`模型 ${id} 已登记`);
      };
    };
  }
  function getQualityRules(){return extRead('embodiedQualityRules',[])}
  function getQualitySettings(){return extRead('embodiedQualitySettings',{thresholds:{'快速质检':85,'标准质检':90,'全量质检':93,'仅同步检测':90},video:{minWidth:640,minHeight:480},issueWeights:{high:35,medium:8}})}
  function updateRulesOverview(){
    const rules=getQualityRules(),enabled=rules.filter(rule=>rule.enabled!==false),last=extRead('embodiedQcBatches',[])[0],box=document.getElementById('overviewRuleList');
    const count=document.getElementById('ruleNavCount');if(count)count.textContent=enabled.length;if(!box)return;
    box.innerHTML=enabled.length?enabled.slice(0,4).map(rule=>m(`[div class="rule"][div class="rule-icon ${last?.ruleSnapshot?.includes(rule.id)?'ok':'running'}"][i data-lucide="${last?.ruleSnapshot?.includes(rule.id)?'check':'clock-3'}"][/i][/div][div class="rule-main"][b]${escapeHtml(rule.name)}[/b][span]${last?.ruleSnapshot?.includes(rule.id)?`已参与批次 ${escapeHtml(last.id)}`:'等待下次质检执行'}[/span][/div][span class="rule-time"]${escapeHtml(rule.scope)}[/span][/div]`)).join(''):m('[div class="empty-inline"]当前没有启用的质量规则[/div]');lucide.createIcons();
  }
  function qualityRulesTemplate(){
    const rules=getQualityRules(),settings=getQualitySettings(),batches=extRead('embodiedQcBatches',[]),last=batches[0],openIssues=extRead('embodiedIssues',[]).filter(item=>item.status!=='已关闭').length,enabled=rules.filter(rule=>rule.enabled!==false).length,engine=extRead('embodiedEngineCapabilities',{}),operators=engine.operators||[],stages=engine.workflowStages||[];
    return m(`
      [div class="ext-kpis"]
        [div class="ext-kpi"][span]启用规则[/span][b]${enabled}[/b][small]共 ${rules.length} 条服务端规则[/small][/div]
        [div class="ext-kpi"][span]质检批次[/span][b]${batches.length}[/b][small]最近 100 次留痕[/small][/div]
        [div class="ext-kpi"][span]最近通过率[/span][b]${last?last.passRate+'%':'--'}[/b][small]${last?escapeHtml(last.id):'尚未执行'}[/small][/div]
        [div class="ext-kpi"][span]未关闭问题[/span][b]${openIssues}[/b][small]由启用规则生成[/small][/div]
      [/div]
      [section class="panel"]
        [div class="panel-head"][div][div class="panel-title"]质量门禁参数[/div][div class="panel-sub"]修改后写入服务端，从下一次质检开始生效[/div][/div][button class="btn" id="qualitySettingsSave"][i data-lucide="save"][/i]保存门禁[/button][/div]
        [div class="quality-settings"]
          [div class="field"][label]快速质检最低分[/label][input id="thresholdFast" type="number" min="0" max="100" value="${settings.thresholds?.['快速质检']??85}" /][/div]
          [div class="field"][label]标准质检最低分[/label][input id="thresholdStandard" type="number" min="0" max="100" value="${settings.thresholds?.['标准质检']??90}" /][/div]
          [div class="field"][label]全量质检最低分[/label][input id="thresholdFull" type="number" min="0" max="100" value="${settings.thresholds?.['全量质检']??93}" /][/div]
          [div class="field"][label]视频最低宽度[/label][input id="videoMinWidth" type="number" min="1" value="${settings.video?.minWidth??640}" /][/div]
          [div class="field"][label]视频最低高度[/label][input id="videoMinHeight" type="number" min="1" value="${settings.video?.minHeight??480}" /][/div]
        [/div]
      [/section]
      [section class="panel engine-panel" style="margin-top:17px"]
        [div class="panel-head"][div][div class="panel-title"]处理算子与八阶段流程[/div][div class="panel-sub"]参考 Embodied Data 的算子化设计；状态来自当前服务端，不展示未接入的能力</div][/div][span class="engine-version"]${engine.engine?escapeHtml(engine.engine)+' · v'+escapeHtml(engine.version||'1.0'):'等待服务端能力清单'}[/span][/div]
        [div class="engine-grid"]${operators.length?operators.map(operator=>{const available=operator.status==='available',optional=operator.status==='optional';return `[div class="engine-card"][div class="engine-card-head"][b]${escapeHtml(operator.name)}[/b][span class="engine-status ${available?'available':optional?'optional':'unavailable'}"]${available?'可用':optional?'可选插件':'不可用'}[/span][/div][small]${escapeHtml(operator.stage||'')} · ${escapeHtml(operator.mode==='server'?'服务端':'外部插件')}[/small][p]${escapeHtml(operator.description||'')}[/p][div class="engine-availability"]${escapeHtml(operator.availability||'')}[/div][/div]`}).join(''):m('[div class="empty-inline"]尚未读取服务端能力清单，请刷新页面[/div]')}</div>
        [div class="engine-stage-list"]${stages.length?stages.map((stage,index)=>`[div class="engine-stage"][span]${index+1}[/span][div][b]${escapeHtml(stage.name||stage.id)}[/b][small]${escapeHtml(stage.description||'')}[/small][/div][/div>`).join(''):m('[div class="empty-inline"]尚未读取流程阶段[/div]')}</div>
        [div class="engine-evidence-note"][i data-lucide="shield-check"][/i]${escapeHtml(engine.evidencePolicy||'所有质检和交付结果必须有服务端证据，未满足门禁时不生成可交付结果。')}[/div]
      [/section]
      [section class="panel" style="margin-top:17px"]
        [div class="panel-head"][div][div class="panel-title"]服务端质量规则库[/div][div class="panel-sub"]系统必需规则不可停用；其他规则可配置并在质检批次中留存快照[/div][/div][div class="row-actions"][button class="btn" id="qualityRuleAdd"][i data-lucide="plus"][/i]新建规则[/button][button class="btn primary" id="qualityRunNow"][i data-lucide="play-circle"][/i]立即运行[/button][/div][/div]
        [div class="table-scroll"][table class="module-table"][thead][tr][th]规则名称[/th][th]适用类型[/th][th]类别[/th][th]阈值 / 条件[/th][th]等级[/th][th]最近执行[/th][th]状态[/th][/tr][/thead][tbody]
          ${rules.length?rules.map(rule=>`[tr][td][b]${escapeHtml(rule.name)}[/b][br][small]${escapeHtml(rule.id)}${rule.system?' · 系统规则':' · 自定义规则'}[/small][/td][td]${rule.scope==='全部'?m('[span class="tag"]全部[/span]'):typeBadge(rule.scope)}[/td][td]${escapeHtml(rule.category)}[/td][td]${escapeHtml(rule.threshold)}[/td][td][span class="status ${rule.severity==='高'?'high':'medium'}"]${escapeHtml(rule.severity)}[/span][/td][td]${last?.ruleSnapshot?.includes(rule.id)?escapeHtml(last.createdAt):'未执行'}[/td][td][button class="switch ${rule.enabled!==false?'on':''}" data-rule-toggle="${escapeHtml(rule.id)}" title="${rule.locked?'系统必需规则不可停用':'启用或停用规则'}" ${rule.locked?'disabled':''}][/button][/td][/tr]`).join(''):m('[tr][td colspan="7"][div class="empty-inline"]服务端尚未配置质量规则[/div][/td][/tr]')}
        [/tbody][/table][/div]
      [/section]`);
  }
  function openQualityRuleEditor(){
    const box=document.getElementById('modelPicker');
    box.innerHTML=m(`[div class="search-box" style="width:min(580px,calc(100vw - 30px))"]
      [div class="popover-head"][span]新建可执行质量规则[/span][button class="close" id="qualityRuleClose"][i data-lucide="x"][/i][/button][/div]
      [div style="padding:17px"]
        [div class="field"][label]规则名称[/label][input id="qualityRuleName" placeholder="例如：遥操文件名包含工位编号" /][/div]
        [div class="form-row"][div class="field"][label]适用数据类型[/label][select id="qualityRuleScope"][option]全部[/option][option]UMI[/option][option]EGO[/option][option]遥操[/option][/select][/div][div class="field"][label]问题等级[/label][select id="qualityRuleSeverity"][option]中[/option][option]高[/option][/select][/div][/div]
        [div class="field"][label]检测方式[/label][select id="qualityRuleCode"][option value="filename_contains"]文件名必须包含[/option][option value="metadata_required"]必填元数据字段[/option][option value="max_file_size_mb"]文件大小上限（MB）[/option][option value="min_file_size_kb"]文件大小下限（KB）[/option][/select][/div]
        [div class="field"][label]条件值[/label][input id="qualityRuleValue" placeholder="关键字、字段名或数值" /][/div]
      [/div]
      [div class="modal-foot"][button class="btn" id="qualityRuleCancel"]取消[/button][button class="btn primary" id="qualityRuleSave"][i data-lucide="save"][/i]保存规则[/button][/div]
    [/div]`);box.classList.add('show');lucide.createIcons();
    const close=()=>box.classList.remove('show');document.getElementById('qualityRuleClose').onclick=close;document.getElementById('qualityRuleCancel').onclick=close;
    document.getElementById('qualityRuleSave').onclick=async()=>{const name=document.getElementById('qualityRuleName').value.trim(),code=document.getElementById('qualityRuleCode').value,value=document.getElementById('qualityRuleValue').value.trim();if(!name||!value){showToast('请填写规则名称和条件值');return}const labels={filename_contains:`文件名包含 ${value}`,metadata_required:`必填字段 ${value}`,max_file_size_mb:`≤ ${value} MB`,min_file_size_kb:`≥ ${value} KB`},button=document.getElementById('qualityRuleSave');button.disabled=true;try{const response=await fetch('/api/rules/upsert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,code,value,threshold:labels[code],scope:document.getElementById('qualityRuleScope').value,severity:document.getElementById('qualityRuleSeverity').value,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'规则保存失败');extWrite('embodiedQualityRules',data.rules);close();moduleTemplates.quality=qualityRulesTemplate();showPage('quality');updateRulesOverview();showToast('质量规则已保存，请运行质检验证')}catch(error){showToast(error.message)}finally{button.disabled=false}};
  }
  function bindQualityPage(){
    document.querySelectorAll('[data-rule-toggle]').forEach(button=>button.onclick=async()=>{button.disabled=true;const enabled=!button.classList.contains('on');try{const response=await fetch('/api/rules/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:button.dataset.ruleToggle,enabled,user:'林晓雯'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'规则状态更新失败');extWrite('embodiedQualityRules',data.rules);moduleTemplates.quality=qualityRulesTemplate();showPage('quality');updateRulesOverview();showToast(`规则已${enabled?'启用':'停用'}，请重新运行质检`)}catch(error){button.disabled=false;showToast(error.message)}});
    document.getElementById('qualityRuleAdd').onclick=openQualityRuleEditor;
    document.getElementById('qualitySettingsSave').onclick=async()=>{const button=document.getElementById('qualitySettingsSave'),settings=getQualitySettings();button.disabled=true;const payload={settings:{thresholds:{...settings.thresholds,'快速质检':Number(document.getElementById('thresholdFast').value),'标准质检':Number(document.getElementById('thresholdStandard').value),'全量质检':Number(document.getElementById('thresholdFull').value)},video:{minWidth:Number(document.getElementById('videoMinWidth').value),minHeight:Number(document.getElementById('videoMinHeight').value)},issueWeights:settings.issueWeights},user:'林晓雯'};try{const response=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),data=await response.json();if(!response.ok)throw new Error(data.error||'门禁保存失败');extWrite('embodiedQualitySettings',data.settings);moduleTemplates.quality=qualityRulesTemplate();showPage('quality');showToast('质量门禁已保存，从下一批质检生效')}catch(error){showToast(error.message)}finally{button.disabled=false}};
    document.getElementById('qualityRunNow').onclick=async()=>{const button=document.getElementById('qualityRunNow');button.disabled=true;button.textContent='正在执行…';try{const batch=await createQcBatch('全部数据','标准质检','全部模型');if(!batch){showToast('当前没有可检测的数据');return}moduleTemplates.quality=qualityRulesTemplate();showPage('quality');updateRulesOverview();showToast(`规则执行完成：${batch.total} 个资产，${batch.issueCount} 个问题`)}catch(error){showToast(error.message)}finally{button.disabled=false}};
  }
  function issuesTemplate(){
    const issues=extRead('embodiedIssues',[]),open=issues.filter(item=>item.status!=='已关闭'),high=open.filter(item=>item.level==='高'),review=open.filter(item=>item.status==='待复核'),deep=open.filter(item=>item.metric==='语义深度解析'),closed=issues.filter(item=>item.status==='已关闭');
    return m(`
      [div class="ext-kpis"]
        [div class="ext-kpi"][span]未关闭问题[/span][b]${open.length}[/b][small]来自证据型质检结果[/small][/div]
        [div class="ext-kpi"][span]高优先级[/span][b]${high.length}[/b][small]阻断数据验收[/small][/div]
        [div class="ext-kpi"][span]待复核[/span][b]${review.length}[/b][small]等待质量负责人确认[/small][/div]
        [div class="ext-kpi"][span]累计关闭[/span][b]${closed.length}[/b][small]保留完整处置记录[/small][/div]
      [/div]
      [section class="panel"]
        [div class="panel-head"][div][div class="panel-title"]质量问题工单[/div][div class="panel-sub"]问题来自可追溯质检证据；关闭必须由服务端复检确认[/div][/div][div class="row-actions"][button class="btn" id="issuesLerobotCheck"${deep.length?'':' disabled'}][i data-lucide="file-check-2"][/i]LeRobot 深度校验${deep.length?`（${deep.length}）`:''}[/button][button class="btn primary" id="issuesAutoCheck"][i data-lucide="scan-search"][/i]执行证据复检[/button][button class="btn" id="issuesRefresh"][i data-lucide="refresh-cw"][/i]刷新[/button][/div][/div]
        [div class="ext-toolbar"]
          [div class="search"][i data-lucide="search"][/i][input id="issueSearch" placeholder="搜索工单、资产或检测项" /][/div]
          [select class="filter-select" id="issueStatus"][option value="open"]未关闭[/option][option value="all"]全部状态[/option][option]待处理[/option][option]处理中[/option][option]待复核[/option][option]已关闭[/option][/select]
          [select class="filter-select" id="issueLevel"][option value="all"]全部等级[/option][option]高[/option][option]中[/option][/select]
        [/div]
        [div class="table-scroll"][table class="module-table ext-table"][thead][tr][th]工单 / 资产[/th][th]问题证据[/th][th]复核结论[/th][th]类型[/th][th]等级[/th][th]负责人[/th][th]状态[/th][th]操作[/th][/tr][/thead][tbody id="issueRows"][/tbody][/table][/div]
      [/section]`);
  }
  function renderIssueRows(){
    const body=document.getElementById('issueRows');if(!body)return;
    const query=(document.getElementById('issueSearch')?.value||'').trim().toLowerCase(),status=document.getElementById('issueStatus')?.value||'open',level=document.getElementById('issueLevel')?.value||'all';
    const rows=extRead('embodiedIssues',[]).filter(issue=>(status==='all'||(status==='open'?issue.status!=='已关闭':issue.status===status))&&(level==='all'||issue.level===level)&&(`${issue.id} ${issue.assetId} ${issue.assetName} ${issue.metric} ${issue.detail}`.toLowerCase().includes(query)));
    body.innerHTML=rows.length?rows.map(issue=>m(`[tr][td][b]${escapeHtml(issue.id)}[/b][br][small]${escapeHtml(issue.assetName||issue.assetId)}[/small][/td][td][b]${escapeHtml(issue.metric)}[/b][br][small]${escapeHtml(issue.detail)}[/small][/td][td]${issue.verification?`[span class="status ${issue.verification.verified?'low':'medium'}"]${issue.verification.verified?'证据通过':'仍需处理'}[/span][br][small]${escapeHtml(issue.verification.reason||'')}[/small]`:'[span class="status medium"]未复检[/span]'}[/td][td]${typeBadge(issue.type)}[/td][td][span class="status ${issue.level==='高'?'high':'medium'}"]${escapeHtml(issue.level)}[/span][/td][td]${escapeHtml(issue.assignee||'未分配')}[/td][td]${statusBadge(issue.status)}[/td][td][button class="btn" data-issue-review="${escapeHtml(issue.id)}"${issue.status==='已关闭'?' disabled':''}]复检[/button][button class="btn primary" data-issue-edit="${escapeHtml(issue.id)}"]处理[/button][/td][/tr]`)).join(''):m('[tr][td colspan="8"][div class="empty-inline"]当前筛选范围内没有质量问题[/div][/td][/tr]');
    body.querySelectorAll('[data-issue-edit]').forEach(button=>button.onclick=()=>openIssueEditor(button.dataset.issueEdit));
    body.querySelectorAll('[data-issue-review]').forEach(button=>button.onclick=()=>recheckIssues([button.dataset.issueReview],button));
  }
  function openIssueEditor(issueId){
    const issue=extRead('embodiedIssues',[]).find(item=>item.id===issueId);if(!issue)return;
    const asset=getAllAssets().find(item=>item.id===issue.assetId),role=asset?.bundleRole||'';
    const guidance=issue.metric==='语义深度解析'?'运行“LeRobot 深度校验”，平台将读取 Parquet 内部列、行数、动作/观测向量和索引顺序。通过后对应问题由证据复检自动关闭；失败时按缺失列或逆序证据修复原始数据。':role==='meta'&&/字段|结构/.test(issue.metric+issue.detail)?'该文件属于 meta 元数据分组。执行证据复检会检查元数据记录和字段结构；仍保留时，检查 JSON/JSONL 是否为空或内容损坏。':/视频|分辨率|时长/.test(issue.metric+issue.detail)?'重新导出或补传可播放的原始视频，确认时长大于 0 且分辨率达到门禁；然后执行证据复检。':'按问题证据修复原始数据或补齐关联文件，然后执行证据复检。问题不会因只填写说明而关闭。';
    const box=document.getElementById('modelPicker');
    box.innerHTML=m(`[div class="search-box" style="width:min(580px,calc(100vw - 30px))"]
      [div class="popover-head"][span]处理质量问题 · ${escapeHtml(issue.id)}[/span][button class="close" id="issueEditorClose"][i data-lucide="x"][/i][/button][/div]
      [div style="padding:17px"]
        [div class="issue-evidence"][b]${escapeHtml(issue.metric)}[/b][span]${escapeHtml(issue.assetName||issue.assetId)} · ${escapeHtml(issue.type)}${role?` · ${escapeHtml(asset.bundleRoleLabel||role)}`:''} · ${escapeHtml(issue.level)}优先级[/span][p]${escapeHtml(issue.detail)}[/p][/div]
        [div class="issue-evidence" style="border-left-color:${issue.verification?.verified?'var(--green)':'var(--amber)'};background:${issue.verification?.verified?'#f4fbf7':'#fffaf0'}"][b]服务端复核证据</b][span]${issue.verification?`${issue.verification.verified?'证据已验证':'仍需处理'} · ${escapeHtml(issue.verification.checkedAt||'')}`:'尚未执行复检'}[/span][p]${escapeHtml(issue.verification?.reason||'保存处理状态前，请先执行一次证据复检。')}[/p][/div]
        [div class="issue-evidence" style="border-left-color:var(--amber);background:#fffaf0"][b]处理建议[/b][p]${escapeHtml(guidance)}</p][/div]
        [div class="form-row"][div class="field"][label]负责人[/label][input class="input" id="issueAssignee" value="${escapeHtml(issue.assignee||'未分配')}" /][/div][div class="field"][label]处理状态[/label][select id="issueEditStatus"]${['待处理','处理中','待复核',...(issue.status==='已关闭'?['已关闭']:[])].map(name=>`[option${issue.status===name?' selected':''}]${name}[/option]`).join('')}[/select][/div][/div]
        [div class="field"][label]处置说明[/label][textarea id="issueResolution" placeholder="填写复现、修复或复核依据"]${escapeHtml(issue.resolution||'')}[/textarea][/div]
      [/div]
      [div class="modal-foot"][button class="btn" id="issueEditorCancel"]取消[/button][button class="btn" id="issueEditorReview"][i data-lucide="scan-search"][/i]重新复核</button][button class="btn primary" id="issueEditorSave"][i data-lucide="save"][/i]保存处理结果[/button][/div]
    [/div]`);
    box.classList.add('show');lucide.createIcons();
    const close=()=>box.classList.remove('show');document.getElementById('issueEditorClose').onclick=close;document.getElementById('issueEditorCancel').onclick=close;
    document.getElementById('issueEditorReview').onclick=async()=>{const button=document.getElementById('issueEditorReview');button.disabled=true;try{await recheckIssues([issue.id],button,true);const updated=extRead('embodiedIssues',[]).find(item=>item.id===issue.id);if(updated){issue.verification=updated.verification;issue.status=updated.status;issue.resolution=updated.resolution;openIssueEditor(issue.id)}}catch(error){showToast(error.message)}finally{button.disabled=false}};
    document.getElementById('issueEditorSave').onclick=async()=>{
      const save=document.getElementById('issueEditorSave'),payload={id:issue.id,assignee:document.getElementById('issueAssignee').value,status:document.getElementById('issueEditStatus').value,resolution:document.getElementById('issueResolution').value.trim(),user:'林晓雯'};
      if(payload.status==='已关闭'&&issue.verification?.verified!==true){showToast('关闭问题前请先执行服务端证据复检');return}
      if(payload.status==='已关闭'&&!payload.resolution){showToast('关闭问题前必须填写处置说明');return}
      save.disabled=true;
      try{const response=await fetch('/api/issues/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),data=await response.json();if(!response.ok)throw new Error(data.error||'问题单保存失败');const list=extRead('embodiedIssues',[]).map(item=>item.id===issue.id?data.issue:item);extWrite('embodiedIssues',list);updateProductionIndicators();close();moduleTemplates.issues=issuesTemplate();showPage('issues');showToast(`问题 ${issue.id} 已更新`)}catch(error){showToast(error.message)}finally{save.disabled=false}
    };
  }
  async function recheckIssues(issueIds,button=null,silent=false){
    const originalText=button?.innerHTML;
    if(button){button.disabled=true;button.textContent='正在读取证据…'}
    try{
      const response=await fetch('/api/issues/recheck',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({template:'标准质检',issueIds})}),data=await response.json();
      if(!response.ok)throw new Error(data.error||'自动复核失败');
      extWrite('embodiedIssues',data.issues||[]);
      if(data.batch)extWrite('embodiedQcBatches',[data.batch,...extRead('embodiedQcBatches',[]).filter(item=>item.id!==data.batch.id)].slice(0,100));
      if(data.runs)extWrite('embodiedRuns',data.runs);
      updateProductionIndicators();moduleTemplates.issues=issuesTemplate();
      if(!silent){showPage('issues');showToast(`证据复检完成：检查 ${data.checked||0} 条，自动关闭 ${data.closed||0} 条，保留 ${data.remaining||0} 条${data.manual?`，另有 ${data.manual} 条需人工复核`:''}`)}
      return data;
    }catch(error){showToast(error.message);throw error}
    finally{if(button){button.disabled=false;if(originalText)button.innerHTML=originalText;lucide.createIcons()}}
  }
  function bindIssues(){
    renderIssueRows();
    ['issueSearch','issueStatus','issueLevel'].forEach(id=>document.getElementById(id)?.addEventListener(id==='issueSearch'?'input':'change',renderIssueRows));
    document.getElementById('issuesLerobotCheck').onclick=async()=>{const button=document.getElementById('issuesLerobotCheck'),deep=extRead('embodiedIssues',[]).filter(item=>item.status!=='已关闭'&&item.metric==='语义深度解析'&&item.assetId),assetIds=[...new Set(deep.map(item=>item.assetId))];if(!assetIds.length){showToast('当前没有待执行的 LeRobot 深度校验');return}button.disabled=true;button.textContent='正在解析 LeRobot…';try{const response=await fetch('/api/assets/lerobot-deep-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assetIds,template:'标准质检'})}),data=await response.json();if(!response.ok)throw new Error(data.error||'LeRobot 深度校验失败');if(data.assets)saveAssets(data.assets);extWrite('embodiedIssues',data.issues||[]);extWrite('embodiedQcBatches',[data.batch,...extRead('embodiedQcBatches',[]).filter(item=>item.id!==data.batch?.id)].slice(0,100));extWrite('embodiedRuns',data.runs||extRead('embodiedRuns',[]));updateProductionIndicators();moduleTemplates.issues=issuesTemplate();showPage('issues');const passed=(data.report?.files||[]).filter(item=>item.status==='verified').length,failed=(data.report?.files||[]).length-passed,pluginSummary=(data.embodied||[]).map(report=>`${report.detection?.format||'dataset'} ${report.info?.episodes??'?'} Episode · ${report.validation?.score??'?'} 分`).join('；');showToast(`LeRobot 深度校验完成：字段通过 ${passed} 个${failed?`，结构异常 ${failed} 个`:''}${pluginSummary?`；Embodied Data：${pluginSummary}`:''}`)}catch(error){showToast(error.message)}finally{button.disabled=false;button.innerHTML=m(`[i data-lucide="file-check-2"][/i]LeRobot 深度校验`);lucide.createIcons()}};
    document.getElementById('issuesAutoCheck').onclick=async()=>{const button=document.getElementById('issuesAutoCheck'),open=extRead('embodiedIssues',[]).filter(item=>item.status!=='已关闭'&&item.assetId);if(!open.length){showToast('当前没有需要复检的未关闭问题');return}await recheckIssues(open.map(item=>item.id),button)};
    document.getElementById('issuesRefresh').onclick=async()=>{const button=document.getElementById('issuesRefresh');button.disabled=true;try{const response=await fetch('/api/issues',{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'刷新失败');extWrite('embodiedIssues',data.issues||[]);moduleTemplates.issues=issuesTemplate();showPage('issues');showToast('问题清单已刷新')}catch(error){showToast(error.message)}finally{button.disabled=false}};
  }
  function formatBytes(value){const bytes=Number(value||0);if(bytes<1024)return `${bytes} B`;const units=['KB','MB','GB','TB'];let size=bytes,index=-1;do{size/=1024;index++}while(size>=1024&&index<units.length-1);return `${size.toFixed(size>=10?1:2)} ${units[index]}`}
  function bindOpsPanel(){
    const content=document.getElementById('moduleContent');if(!content||document.getElementById('productionOps'))return;
    content.insertAdjacentHTML('afterbegin',m(`[section class="panel ops-panel" id="productionOps"][div class="panel-head"][div][div class="panel-title"]生产运行状态[/div][div class="panel-sub"]服务端持久化、流式上传、证据型质检与状态快照[/div][/div][div style="display:flex;gap:8px"][button class="btn" id="reconcileStorage"][i data-lucide="hard-drive-check"][/i]校验存储[/button][button class="btn" id="createBackup"][i data-lucide="database-backup"][/i]创建状态快照[/button][/div][/div][div class="ops-grid"][div][span]服务状态[/span][b id="opsService"]检查中…[/b][/div][div][span]原始文件[/span][b id="opsFiles"]--[/b][/div][div][span]存储占用[/span][b id="opsStorage"]--[/b][/div][div][span]未关闭问题[/span][b id="opsIssues"]--[/b][/div][/div][div class="ops-note" id="opsNote"]正在读取服务端运行状态[/div][/section]`));
    const refresh=async()=>{try{const response=await fetch('/api/ops',{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'服务状态不可用');document.getElementById('opsService').textContent='运行中';document.getElementById('opsFiles').textContent=`${data.storage.files} 个`;document.getElementById('opsStorage').textContent=formatBytes(data.storage.bytes);document.getElementById('opsIssues').textContent=data.issuesOpen;document.getElementById('opsNote').textContent=`已运行 ${Math.floor(data.uptimeSeconds/60)} 分钟 · 可用空间 ${formatBytes(data.storage.freeBytes)} · 流式上传已启用`}catch(error){document.getElementById('opsService').textContent='不可用';document.getElementById('opsNote').textContent=error.message}};
    document.getElementById('createBackup').onclick=async()=>{const button=document.getElementById('createBackup');button.disabled=true;try{const response=await fetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),data=await response.json();if(!response.ok)throw new Error(data.error||'快照创建失败');showToast(`状态快照已创建：${data.backup}`);refresh()}catch(error){showToast(error.message)}finally{button.disabled=false}};
    document.getElementById('reconcileStorage').onclick=async()=>{const button=document.getElementById('reconcileStorage');button.disabled=true;try{const response=await fetch('/api/storage/reconcile',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),data=await response.json();if(!response.ok)throw new Error(data.error||'存储校验失败');const report=data.report;showToast(report.healthy?'存储一致性校验通过':`发现 ${report.missing.length+report.sizeMismatch.length+report.orphan.length} 项存储异常`);document.getElementById('opsNote').textContent=report.healthy?`存储校验通过 · ${report.referencedFiles} 个文件 · ${new Date(report.checkedAt).toLocaleString('zh-CN',{hour12:false})}`:`存储异常：缺失 ${report.missing.length} · 大小不一致 ${report.sizeMismatch.length} · 孤儿 ${report.orphan.length}`}catch(error){showToast(error.message)}finally{button.disabled=false}};
    refresh();lucide.createIcons();
  }
  function bindDeletePermissionButtons(){
    if(authUser?.isPlatformOwner!==true)return;
    document.querySelectorAll('#serverMemberRows tr').forEach(row=>{const statusButton=row.querySelector('[data-member-status]'),cell=row.lastElementChild;if(!statusButton||!cell)return;const member=extRead('embodiedMembers',[]).find(item=>item.id===statusButton.dataset.memberId);if(!member||member.id===authUser.id||cell.querySelector('[data-delete-permission]'))return;const button=document.createElement('button');button.className='btn';button.textContent=member.canDeleteData?'收回删除权限':'开通删除权限';button.title='仅平台所有者可管理';button.dataset.deletePermission=member.id;button.onclick=async()=>{button.disabled=true;try{const response=await fetch('/api/members/delete-permission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:member.id,canDeleteData:!member.canDeleteData})}),data=await response.json();if(!response.ok)throw new Error(data.error||'删除数据权限更新失败');extWrite('embodiedMembers',data.members||[]);moduleTemplates.users=usersTemplate();showPage('users');showToast(data.member.canDeleteData?'已开通删除数据权限':'已收回删除数据权限')}catch(error){button.disabled=false;showToast(error.message)}};cell.appendChild(button)})
  }
  function enforcePageActions(){
    const rules=[
      [['assetImportBtn','episodeAttachVideo'],['资产上传','资产管理']],
      [['assetQcPending','runQcBtn','qcRunBtn','qualityRunNow'],['运行质检','资产管理']],
      [['qualitySettingsSave','qualityRuleAdd'],['规则管理']],
      [['generateAnnotations'],['标注查看','标注审核']],
      [['approveAnnotation','rejectAnnotation'],['标注审核','资产管理']],
      [['createExport','datasetBuild'],['数据集发布']],
      [['trainingCreate'],['训练调度']],
      [['feedbackSave'],['失败样本回流','训练调度']],
      [['taskCreateInline'],['采集任务']],
      [['nodeRegister','diagnoseNodes'],['节点管理']],
      [['memberRegister'],['成员管理']],
      [['issueEditorSave'],['问题处置']],
      [['createBackup','reconcileStorage'],['平台设置']],
      [['modelAdd','modelSave'],['模型关联','训练调度']]
    ];
    rules.forEach(([ids,permissions])=>ids.forEach(id=>{const element=document.getElementById(id);if(element)element.hidden=!can(...permissions)}));
    document.querySelectorAll('[data-task-status]').forEach(element=>element.hidden=!can('采集任务'));
    document.querySelectorAll('[data-training-status]').forEach(element=>element.hidden=!can('训练调度'));
    document.querySelectorAll('[data-dataset-status]').forEach(element=>element.hidden=!can('数据集发布'));
    document.querySelectorAll('[data-member-status]').forEach(element=>element.hidden=!can('成员管理'));
  }
  function bindExtensionPage(key){
    if(key==='workflow')bindWorkflow();
    if(key==='episodes')bindEpisodes();
    if(key==='annotation')bindAnnotation();
    if(key==='exports')bindExports();
    if(key==='nodes')bindNodes();
    if(key==='audit')bindAudit();
    if(key==='runs')bindRuns();
    if(key==='assets')bindAssetsPage();
    if(key==='tasks')bindTasksPage();
    if(key==='qc')bindQcPage();
    if(key==='models')bindModelsPage();
    if(key==='issues')bindIssues();
    if(key==='users')bindDeletePermissionButtons();
    if(key==='quality')bindQualityPage();
    if(key==='datasets')bindDatasets();
    if(key==='training')bindTraining();
    if(key==='users')bindUsers();
    if(key==='settings')bindOpsPanel();
    enforcePageActions();
    lucide.createIcons();
  }
  function downloadJson(filename,data){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});downloadBlob(filename,blob);addAudit('下载数据文件',filename,'本地生成并下载')}
  function downloadCsv(filename,rows){if(!rows.length){showToast('当前没有可导出的数据');return}const keys=Object.keys(rows[0]),quote=value=>`"${String(value??'').replaceAll('"','""')}"`;const csv='\ufeff'+[keys.map(quote).join(','),...rows.map(row=>keys.map(key=>quote(row[key])).join(','))].join('\r\n');downloadBlob(filename,new Blob([csv],{type:'text/csv;charset=utf-8'}));showToast('文件已生成：'+filename)}
  function downloadBlob(filename,blob){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  async function refreshNotifications(){const box=document.getElementById('noticeList');if(!box)return;try{const response=await fetch('/api/notifications',{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'通知读取失败');box.innerHTML=data.items.length?data.items.map(item=>m(`[button class="notice-item" data-notice-page="${escapeHtml(item.page)}"][i style="background:${item.severity==='high'?'var(--red)':item.severity==='medium'?'var(--amber)':'var(--blue)'}"][/i][div][b]${escapeHtml(item.title)}[/b][small]${escapeHtml(item.detail)}[/small][/div][/button]`)).join(''):m('[div class="empty-inline" style="padding:30px"]当前没有待处理通知[/div]');box.querySelectorAll('[data-notice-page]').forEach(item=>item.onclick=()=>{document.getElementById('noticePopover').classList.remove('show');navigate(item.dataset.noticePage,document.querySelector(`.nav button[data-page="${item.dataset.noticePage}"]`))});const dot=document.querySelector('.notif-dot');if(dot)dot.style.display=data.unread?'':'none';document.getElementById('markNotices').disabled=!data.items.length}catch(error){box.innerHTML=m(`[div class="empty-inline" style="padding:30px"]${escapeHtml(error.message)}[/div]`)}}
  function installOverlays(){document.body.insertAdjacentHTML('beforeend',m(`
    [div class="popover" id="noticePopover"][div class="popover-head"][span]通知中心[/span][button class="link" id="markNotices"]全部已读[/button][/div][div class="popover-body" id="noticeList"][div class="empty-inline" style="padding:30px"]正在读取真实事件[/div][/div][/div]
    [div class="search-dialog" id="globalSearchDialog"][div class="search-box"][div class="search-input-wrap"][i data-lucide="search"][/i][input id="globalSearchInput" placeholder="搜索数据资产、Episode、任务、规则…" /][button class="close" data-close-search][i data-lucide="x"][/i][/button][/div][div class="search-results" id="globalSearchResults"][/div][/div][/div]
    [div class="search-dialog" id="episodeDialog"][/div]
    [div class="search-dialog" id="importWizard"][/div]
    [div class="search-dialog" id="modelPicker"][/div]
    [div class="search-dialog" id="qcReport"][/div]
    [div class="search-dialog" id="runDetail"][/div]
    [div class="search-dialog" id="healthDetailDialog"][/div]
    [div class="search-dialog" id="securityDialog"]
      [form class="search-box security-box" id="securityForm"]
        [div class="security-head"][div][b]账号安全[/b][small id="securityIdentity"][/small][/div][button class="close" type="button" id="securityClose" title="关闭"][i data-lucide="x"][/i][/button][/div]
        [div class="security-content"]
          [p]修改登录密码后，其他设备上的登录会话会立即失效。[/p]
          [div class="auth-error" id="securityError" hidden][/div]
          [div class="field"][label]当前密码[/label][input class="input" id="currentPassword" type="password" autocomplete="current-password" required /][/div]
          [div class="field"][label]新密码[/label][input class="input" id="newPassword" type="password" autocomplete="new-password" minlength="10" required placeholder="至少 10 位，包含字母和数字" /][/div]
          [div class="field"][label]确认新密码[/label][input class="input" id="confirmPassword" type="password" autocomplete="new-password" minlength="10" required /][/div]
        [/div]
        [div class="modal-foot"][button class="btn" type="button" id="securityCancel"]取消[/button][button class="btn primary" type="submit"][i data-lucide="key-round"][/i]更新密码[/button][/div]
      [/form]
    [/div]
    [div class="search-dialog" id="nodeCredentialDialog"]
      [div class="search-box security-box"]
        [div class="security-head"][div][b id="nodeCredentialTitle"]节点接入凭证[/b][small]令牌只显示这一次，请交给对应采集 Agent 安全保存。[/small][/div][button class="close" type="button" id="nodeCredentialClose" title="关闭"][i data-lucide="x"][/i][/button][/div]
        [div class="security-content"][p]Agent 上报时在请求头中携带 Authorization: Bearer &lt;令牌&gt;。平台只保存令牌摘要。</p>[code class="credential-value" id="nodeCredentialValue"][/code][/div]
        [div class="modal-foot"][button class="btn primary" type="button" id="nodeCredentialCopy"][i data-lucide="copy"][/i]复制凭证[/button][/div]
      [/div]
    [/div]`));
    ['importWizard','modelPicker','qcReport','runDetail','healthDetailDialog','securityDialog','nodeCredentialDialog'].forEach(id=>{const node=document.getElementById(id);node.onclick=event=>{if(event.target===node)node.classList.remove('show')}});
    const detailGrid=document.querySelector('#drawer .detail-grid');
    if(detailGrid&&!document.getElementById('detailModel'))detailGrid.insertAdjacentHTML('beforeend',m('[div class="detail-card"][span]关联模型[/span][b id="detailModel"]未关联[/b][/div][div class="detail-card"][span]采集场景 / 节点[/span][b id="detailSceneNode"]—[/b][/div]'));
    const notice=document.getElementById('noticePopover');document.getElementById('noticeBtn').onclick=event=>{event.stopPropagation();notice.classList.toggle('show');if(notice.classList.contains('show'))refreshNotifications()};document.addEventListener('click',event=>{if(!notice.contains(event.target)&&event.target.closest('#noticeBtn')===null)notice.classList.remove('show')});document.getElementById('markNotices').onclick=async()=>{const response=await fetch('/api/notifications/read',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),data=await response.json();if(!response.ok){showToast(data.error||'通知状态保存失败');return}await refreshNotifications();showToast('真实通知已全部标记为已读')};
    const searchDialog=document.getElementById('globalSearchDialog');document.getElementById('globalSearch').onclick=()=>{searchDialog.classList.add('show');document.getElementById('globalSearchInput').focus();renderGlobalSearch('')};searchDialog.querySelector('[data-close-search]').onclick=()=>searchDialog.classList.remove('show');searchDialog.onclick=event=>{if(event.target===searchDialog)searchDialog.classList.remove('show')};document.getElementById('episodeDialog').onclick=event=>{if(event.target.id==='episodeDialog')event.currentTarget.classList.remove('show')};document.getElementById('globalSearchInput').oninput=event=>renderGlobalSearch(event.target.value);
    const securityDialog=document.getElementById('securityDialog'),closeSecurity=()=>securityDialog.classList.remove('show');document.getElementById('securityForm').onsubmit=changePassword;document.getElementById('securityClose').onclick=closeSecurity;document.getElementById('securityCancel').onclick=closeSecurity;
    const nodeCredentialDialog=document.getElementById('nodeCredentialDialog');document.getElementById('nodeCredentialClose').onclick=()=>nodeCredentialDialog.classList.remove('show');document.getElementById('nodeCredentialCopy').onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById('nodeCredentialValue').textContent);showToast('节点凭证已复制')}catch{showToast('复制失败，请手动选择凭证')}};
  }
  function renderGlobalSearch(query){const tasks=readStore(storageKey.tasks).map(task=>({title:task.name,sub:`采集任务 · ${task.type}`,page:'tasks',kind:'任务'})),assets=readStore(storageKey.assets).map(asset=>({title:asset.name,sub:`数据资产 · ${asset.type}`,page:'assets',kind:'资产'})),episodes=getEpisodes().map(ep=>({title:ep.id,sub:`${ep.scene} · ${ep.task}`,page:'episodes',kind:'Episode'})),nodes=extRead('embodiedNodes',[]).map(node=>({title:node.id,sub:`${node.site} · ${node.status} · ${node.type}`,page:'nodes',kind:'节点'})),datasets=extRead('embodiedDatasets',[]).map(item=>({title:`${item.name} ${item.version}`,sub:`数据集 · ${item.status}`,page:'datasets',kind:'数据集'})),members=extRead('embodiedMembers',[]).map(item=>({title:item.name,sub:`${item.role} · ${item.domain}`,page:'users',kind:'成员'})),logs=extRead('embodiedAudit').map(log=>({title:log.target,sub:`${log.action} · ${log.user}`,page:'audit',kind:'审计'}));const value=query.trim().toLowerCase(),items=[...assets,...episodes,...tasks,...nodes,...datasets,...members,...logs].filter(item=>!value||`${item.title} ${item.sub}`.toLowerCase().includes(value)).slice(0,12),box=document.getElementById('globalSearchResults');box.innerHTML=items.length?items.map(item=>m(`[button class="search-result" data-search-page="${item.page}"][span][b]${escapeHtml(item.title)}[/b][small]${escapeHtml(item.sub)}[/small][/span][span class="search-kind"]${item.kind}[/span][/button]`)).join(''):m('[div class="empty-inline"]没有匹配结果[/div]');box.querySelectorAll('[data-search-page]').forEach(button=>button.onclick=()=>{const nav=document.querySelector(`.nav button[data-page="${button.dataset.searchPage}"]`);document.getElementById('globalSearchDialog').classList.remove('show');navigate(button.dataset.searchPage,nav)})}
  ensureData();ensureAssets();installNavigation();installOverlays();
  document.getElementById('allIssues').onclick=()=>navigate('issues',document.querySelector('.nav button[data-page="issues"]'));
  document.getElementById('ruleCenter').onclick=()=>navigate('quality',document.querySelector('.nav button[data-page="quality"]'));
  document.getElementById('healthDetail').onclick=openHealthDetail;
  document.getElementById('rangeSelect')?.remove();
  document.getElementById('trendDetail').onclick=()=>navigate('runs',document.querySelector('.nav button[data-page="runs"]'));
  document.getElementById('refreshBtn').onclick=async()=>{const button=document.getElementById('refreshBtn');button.disabled=true;try{const response=await fetch('/api/state',{cache:'no-store'});if(!response.ok)throw new Error('服务端数据读取失败');await syncServerState();showToast('已从服务端刷新数据')}catch(error){showToast(error.message)}finally{button.disabled=false}};
  initAuth().then(authenticated=>{if(authenticated){syncServerState();fetch('/api/state',{cache:'no-store'}).then(response=>response.ok?response.json():null).then(remote=>{if(remote)extWrite('embodiedRuns',remote.runs||[])})}});
  moduleTemplates.workflow=workflowTemplate();moduleTemplates.assets=assetsTemplate();moduleTemplates.tasks=tasksTemplate();moduleTemplates.qc=qcPageTemplate();moduleTemplates.runs=runsTemplate();moduleTemplates.models=modelsTemplate();moduleTemplates.episodes=episodeTemplate();moduleTemplates.annotation=annotationTemplate();moduleTemplates.exports=exportsTemplate();moduleTemplates.datasets=datasetsTemplate();moduleTemplates.training=trainingTemplate();moduleTemplates.nodes=nodesTemplate();moduleTemplates.users=usersTemplate();moduleTemplates.audit=auditTemplate();moduleTemplates.issues=issuesTemplate();moduleTemplates.quality=qualityRulesTemplate();
  const priorShowPage=showPage;
  showPage=function(key){
    if(key==='workflow')moduleTemplates.workflow=workflowTemplate();
    if(key==='assets')moduleTemplates.assets=assetsTemplate();
    if(key==='tasks')moduleTemplates.tasks=tasksTemplate();
    if(key==='qc')moduleTemplates.qc=qcPageTemplate();
    if(key==='runs')moduleTemplates.runs=runsTemplate();
    if(key==='models')moduleTemplates.models=modelsTemplate();
    if(key==='annotation')moduleTemplates.annotation=annotationTemplate();
    if(key==='exports')moduleTemplates.exports=exportsTemplate();
    if(key==='datasets')moduleTemplates.datasets=datasetsTemplate();
    if(key==='training')moduleTemplates.training=trainingTemplate();
    if(key==='nodes')moduleTemplates.nodes=nodesTemplate();
    if(key==='users')moduleTemplates.users=usersTemplate();
    if(key==='audit')moduleTemplates.audit=auditTemplate();
    if(key==='issues')moduleTemplates.issues=issuesTemplate();
    if(key==='quality')moduleTemplates.quality=qualityRulesTemplate();
    priorShowPage(key);
    bindExtensionPage(key);
  };
  handleImport=function(files){openImportWizard(files)};
  renderImportedAssets=function(){if(document.getElementById('assetRows'))renderAssetRows()};
  const oldSetDrawerData=setDrawerData;
  setDrawerData=function(name,type,scale){
    oldSetDrawerData(name,type,scale);
    const asset=findAsset(name),modelNode=document.getElementById('detailModel'),sceneNode=document.getElementById('detailSceneNode');
    if(modelNode)modelNode.textContent=asset?asset.model:'未关联';
    if(sceneNode)sceneNode.textContent=asset?`${asset.scene} · ${asset.node}`:'—';
    ['detailSync','detailCompleteness','detailSyncMetric'].forEach(id=>document.getElementById(id).textContent='未测量');
    ['detailCompletenessBar','detailSyncBar'].forEach(id=>document.getElementById(id).style.width='0%');
    document.getElementById('drawerExport').onclick=()=>{if(asset)downloadJson(`${asset.id}-detail.json`,asset)};
    const open=document.getElementById('drawerOpen');open.textContent=asset?.serverFile?'下载原始文件':'原始文件未上传';open.disabled=!asset?.serverFile;open.onclick=()=>{if(asset?.serverFile)location.href=`/api/assets/${encodeURIComponent(asset.id)}/file`};
  };
  document.getElementById('modalSubmit').onclick=async()=>{
    const button=document.getElementById('modalSubmit'),name=document.getElementById('taskName').value.trim(),type=document.getElementById('taskType').value,scene=document.getElementById('taskScene').value.trim(),nodeId=document.getElementById('taskNode').value,targetCount=Number(document.getElementById('taskTargetCount').value),acceptanceScore=Number(document.getElementById('taskAcceptanceScore').value),owner=document.getElementById('taskOwner').value.trim()||authUser?.name||'',deadline=document.getElementById('taskDeadline').value,description=document.getElementById('taskDescription').value.trim();
    if(!name){showToast('请填写任务名称');document.getElementById('taskName').focus();return}
    if(!scene){showToast('请填写采集场景');document.getElementById('taskScene').focus();return}
    if(!Number.isInteger(targetCount)||targetCount<=0){showToast('目标验收资产数必须为正整数');document.getElementById('taskTargetCount').focus();return}
    if(!Number.isFinite(acceptanceScore)||acceptanceScore<0||acceptanceScore>100){showToast('最低质量分必须在 0 到 100 之间');document.getElementById('taskAcceptanceScore').focus();return}
    button.disabled=true;button.textContent='正在创建…';
    try{const task={id:'TASK-'+Date.now(),name,type,scene,nodeIds:nodeId?[nodeId]:[],targetCount,acceptanceScore,owner,deadline,description,status:'待启动',createdAt:new Date().toISOString()},response=await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(task)}),data=await response.json();if(!response.ok)throw new Error(data.error||'任务写入服务端失败');const tasks=readStore(storageKey.tasks).filter(item=>item.id!==data.task.id);tasks.unshift(data.task);writeStore(storageKey.tasks,tasks);document.getElementById('modal').classList.remove('show');['taskName','taskScene','taskOwner','taskDeadline','taskDescription'].forEach(id=>document.getElementById(id).value='');document.getElementById('taskTargetCount').value='100';document.getElementById('taskAcceptanceScore').value='90';if(currentPage==='tasks')showPage('tasks');showToast(`采集生产工单已创建：${name}`)}catch(error){showToast(error.message)}finally{button.disabled=false;button.textContent='创建任务'}
  };
  document.getElementById('taskType').addEventListener('change',populateTaskForm);document.getElementById('createBtn').addEventListener('click',populateTaskForm);
  lucide.createIcons();
})();

