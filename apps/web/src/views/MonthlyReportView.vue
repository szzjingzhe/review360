<script setup lang="ts">
import { requestId } from '../lib/requestId';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { mockApi } from '../api';
interface MaterialVersion { id:string; fileName:string; format:string; sizeText:string; uploadedBy:string; submittedAt:string; version:number; note:string; isCurrent:boolean; status:'PROCESSING'|'READY'|'FAILED'|'LOCKED'; externalUrl?:string|null; }
interface Material { id:string; name:string; type:string; isPrimary:boolean; versions:MaterialVersion[]; }
interface PendingFile { key:number; file:File; name:string; type:string; note:string; }
const types=[{value:'MONTHLY_REPORT',label:'月度工作报告'},{value:'PROJECT',label:'项目成果'},{value:'COMPETITION',label:'竞赛成果'},{value:'WORK_PROOF',label:'工作证明'},{value:'PRESENTATION',label:'汇报展示'},{value:'OTHER',label:'其他材料'}];
const cycles=ref<any[]>([]), cycleId=ref(''), materials=ref<Material[]>([]), selectedMaterialId=ref('');
const loading=ref(true),loadError=ref(''),busy=ref(false),message=ref(''),messageKind=ref<'success'|'error'>('success');
const serverLocked=ref(false),lockReason=ref<string|null>(null),pending=ref<PendingFile[]>([]),updateTarget=ref<Material|null>(null);
const lockCount=ref(0),maxLockCount=ref(2),canUnlock=ref(false),manualLocked=ref(false);
const linkUrl=ref(''),linkName=ref(''),linkType=ref('PRESENTATION'),linkNote=ref('');
const linkBusy=ref(false),linkError=ref(''),linkMessage=ref('');
const linkTypes=[{value:'PRESENTATION',label:'汇报展示'},{value:'PROJECT',label:'项目成果'},{value:'COMPETITION',label:'竞赛成果'},{value:'WORK_PROOF',label:'工作证明'},{value:'OTHER',label:'其他材料'}];
const uploadInput=ref<HTMLInputElement|null>(null),uploadSection=ref<HTMLElement|null>(null),previewDialog=ref<HTMLDialogElement|null>(null),lockDialog=ref<HTMLDialogElement|null>(null),previewReport=ref<MaterialVersion|null>(null);
let loadSequence=0,pendingKey=0;
let submissionId='',submissionFingerprint='';
const icons={calendar:'M8 3v4m8-4v4M4 10h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1ZM8 14h2m4 0h2m-8 3h2',file:'M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8m-8 4h6',lock:'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5V11Zm7 4v2',upload:'M12 16V4m-4 4 4-4 4 4M5 15v5h14v-5'};
const currentCycle=computed(()=>cycles.value.find(c=>c.id===cycleId.value));
const primary=computed(()=>materials.value.find(m=>m.isPrimary));
const locked=computed(()=>serverLocked.value||currentCycle.value?.status!=='REVIEWING');
const uploadDisabled=computed(()=>busy.value||loading.value||!!loadError.value||locked.value);
const historyMaterial=computed(()=>materials.value.find(m=>m.id===selectedMaterialId.value)??materials.value[0]);
const canLock=computed(()=>!uploadDisabled.value&&!pending.value.length&&effectiveMaterials.value.length>0);
const cycleStatus=computed(()=>({DRAFT:'草拟中',REVIEWING:'评价中',PAUSED:'已暂停',CALIBRATING:'校准中',PUBLISHED:'已发布',CANCELLED:'已取消'}[currentCycle.value?.status as string]??currentCycle.value?.status??'暂无周期'));
const dragging=ref(false), renderedUrl=ref(''), previewLoading=ref(false), previewError=ref('');
let previewController:AbortController|null=null;
const officeFormats=['DOC','DOCX','PPT','PPTX','XLS','XLSX'];
const allowedFormats=['PDF',...officeFormats,'TXT','JPG','JPEG','PNG'];
const previewUrl=computed(()=>previewReport.value?mockApi.materialFile(cycleId.value,previewReport.value.id):'');
const cycleRange=computed(()=>{const a=dateText(currentCycle.value?.openAt,true),b=dateText(currentCycle.value?.closeAt,true);return a||b?(a||'开始时间未配置')+' — '+(b||'结束时间未配置'):'';});
// Count one current usable version per material; historical versions are excluded.
const effectiveMaterials=computed(()=>materials.value.filter(m=>m.versions.some(v=>v.isCurrent&&(v.status==='READY'||v.status==='LOCKED'))));
const summaryCards=computed(()=>[
 {title:'当前周期',skin:'cycle',icon:icons.calendar,value:currentCycle.value?.month??'—',note:cycleRange.value||currentCycle.value?.title||'暂无环评周期'},
 {title:'材料提交情况',skin:'submission',icon:icons.file,value:loading.value||loadError.value?'—':!currentCycle.value?'暂无周期':effectiveMaterials.value.length+' 份',note:loading.value?'正在读取材料':loadError.value?'材料信息暂不可用':!currentCycle.value?'暂无环评周期':'主月报 '+effectiveMaterials.value.filter(m=>m.isPrimary).length+' 份'},
 {title:'成果包状态',skin:'package',icon:icons.lock,value:loading.value||loadError.value?'—':!currentCycle.value?'暂无周期':serverLocked.value&&lockReason.value!=='CYCLE_CLOSED'?'已锁定':locked.value?'不可修改':'可更新',note:loading.value?'正在读取材料':loadError.value?'材料信息暂不可用':!currentCycle.value?'暂无环评周期':serverLocked.value&&lockReason.value!=='CYCLE_CLOSED'?'本期材料已锁定，当前不可修改':locked.value?'当前周期不开放材料上传':'本期材料可新增或更新版本'},
]);
function current(m:Material){return m.versions.find(v=>v.isCurrent)??m.versions[0];}
function typeName(type:string){return types.find(t=>t.value===type)?.label??type;}
function dateText(value?:string,dateOnly=false){if(!value)return '';const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleString('zh-CN',dateOnly?{year:'numeric',month:'2-digit',day:'2-digit'}:{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
function fileSize(size:number){return size>=1024*1024?(size/1024/1024).toFixed(1)+' MiB':Math.max(1,Math.round(size/1024))+' KiB';}
function formatOf(name:string){return name.split('.').pop()?.toUpperCase()??'UNKNOWN';}
function statusText(status:MaterialVersion['status']){return {PROCESSING:'处理中',READY:'可评审',FAILED:'处理失败',LOCKED:'已锁定'}[status];}
function statusClass(status:MaterialVersion['status']){return status==='READY'?'success':status==='FAILED'?'error':status==='LOCKED'?'neutral':'pending';}
function errorText(error:any){const map:Record<string,string>={PRIMARY_REPORT_EXISTS:'本周期已有主月报，请通过“更新版本”维护。',REPORT_LOCKED:'材料已锁定，无法更改。',REPORT_UPLOAD_CLOSED:'当前周期不开放材料上传。',LOCK_LIMIT_REACHED:'已达 2 次锁定上限，无法再次锁定。',UNLOCK_LIMIT_REACHED:'已锁定 2 次，无法再解锁。',MATERIAL_NOT_LOCKED:'当前未处于锁定状态。',INVALID_LINK_URL:'链接格式不正确，请粘贴完整地址（https:// 开头）。',LINK_DOMAIN_NOT_SUPPORTED:'目前只支持飞书云文档链接（feishu.cn / larksuite.com）。',FILE_CONTENT_MISMATCH:'文件内容与扩展名不符，请选择有效文件。',FILE_TYPE_NOT_ALLOWED:'不支持该文件格式。',FILE_SIZE_INVALID:'文件不能为空；PPT/PPTX 必须小于 50 MiB，其他文件不超过 20 MiB。',MATERIAL_NOT_FOUND:'材料不存在或无权修改，请重新加载。',INVALID_MATERIAL_METADATA:'请检查材料名称、类型和版本说明。',MATERIAL_TYPE_IMMUTABLE:'更新版本不能改变原材料类型。',PRIMARY_REPORT_NOT_READY:'主月报尚未处理完成，请稍后再锁定。',HTTP_413:'本次上传内容过大，请减少文件后重试。'};return map[error?.code??error?.message]??error?.message??'请求失败，请稍后重试。';}
async function loadReport(){const seq=++loadSequence,id=cycleId.value;loading.value=true;loadError.value='';materials.value=[];serverLocked.value=false;lockReason.value=null;
 try{if(!id)return;const data=await mockApi.listMaterials(id);if(seq!==loadSequence)return;materials.value=data.materials.map((m:any)=>({...m,versions:m.versions.map((v:any)=>({...v,format:v.externalUrl?'LINK':formatOf(v.fileName),sizeText:v.externalUrl?'云文档':fileSize(v.sizeBytes),submittedAt:dateText(v.createdAt)}))}));serverLocked.value=data.locked;lockReason.value=data.lockReason;lockCount.value=data.lockCount??0;maxLockCount.value=data.maxLockCount??2;canUnlock.value=!!data.canUnlock;manualLocked.value=!!data.manualLocked;if(!materials.value.some(m=>m.id===selectedMaterialId.value))selectedMaterialId.value=materials.value[0]?.id??'';}
 catch{if(seq===loadSequence)loadError.value='材料信息加载失败，请重试。';}finally{if(seq===loadSequence)loading.value=false;}}
async function initialize(){loading.value=true;loadError.value='';try{cycles.value=await mockApi.listCycles();cycleId.value=cycles.value.find(c=>c.status==='REVIEWING')?.id??cycles.value[0]?.id??'';await loadReport();}catch{loadError.value='环评周期加载失败，请重试。';loading.value=false;}}
function clearPending(){pending.value=[];if(uploadInput.value)uploadInput.value.value='';}
function changeCycle(event:Event){const select=event.target as HTMLSelectElement;if(pending.value.length&&!window.confirm('还有未提交的文件，切换周期会清空待提交内容。是否继续？')){select.value=cycleId.value;return;}clearPending();updateTarget.value=null;cycleId.value=select.value;message.value='';void loadReport();}
function focusUpload(){uploadSection.value?.scrollIntoView({behavior:'instant',block:'nearest'});uploadInput.value?.focus();}
function prepareUpload(target:Material|null=null){if(pending.value.length&&!window.confirm('切换上传任务会清空待提交内容。是否继续？'))return;clearPending();updateTarget.value=target;message.value='';focusUpload();}
function onFileChange(event:Event){const input=event.target as HTMLInputElement;addFiles(Array.from(input.files??[]));input.value='';}
function onDrop(event:DragEvent){dragging.value=false;if(!uploadDisabled.value)addFiles(Array.from(event.dataTransfer?.files??[]));}
function addFiles(files:File[]){message.value='';if(!files.length||uploadDisabled.value)return;messageKind.value='error';
 if(updateTarget.value&&files.length!==1){message.value='更新某份材料时，请选择一个新文件。';return;}
 if(!updateTarget.value&&files.length+pending.value.length>10){message.value='每次最多提交 10 个文件，请分批提交。';return;}
 for(const file of files){if(!allowedFormats.includes(formatOf(file.name))){message.value=file.name+'：不支持该格式，请选择文档、演示文稿、表格、TXT 或 JPG/PNG。';return;}const ppt=['PPT','PPTX'].includes(formatOf(file.name));if(!file.size||(ppt?file.size>=50*1024*1024:file.size>20*1024*1024)){message.value=file.name+(ppt?'：PPT 必须小于 50 MiB，过大时请改用下方「飞书云文档链接」提交。':'：文件不能为空，且不得超过 20 MiB。');return;}}
 if(updateTarget.value)pending.value=[];
 for(const file of files){const hasMain=!!primary.value||pending.value.some(p=>p.type==='MONTHLY_REPORT');pending.value.push({key:++pendingKey,file,name:updateTarget.value?.name??file.name.slice(0,200),type:updateTarget.value?.type??(hasMain?'OTHER':'MONTHLY_REPORT'),note:''});}}
async function submitPending(){if(uploadDisabled.value||!pending.value.length)return;message.value='';messageKind.value='error';
 if(pending.value.some(p=>!p.name.trim())){message.value='请填写每份材料的名称。';return;}if(!updateTarget.value&&pending.value.filter(p=>p.type==='MONTHLY_REPORT').length>(primary.value?0:1)){message.value='每周期只能有一份主月报，其余文件请选择补充材料类型。';return;}
 busy.value=true;try{const target=updateTarget.value;const metadata=pending.value.map(p=>({name:p.name.trim(),type:p.type,note:p.note,...(target?{materialId:target.id}:{})}));const fingerprint=JSON.stringify({cycle:cycleId.value,keys:pending.value.map(p=>p.key),metadata});if(fingerprint!==submissionFingerprint){submissionFingerprint=fingerprint;submissionId=requestId();}await mockApi.submitMaterials(cycleId.value,pending.value.map(p=>p.file),metadata,submissionId);clearPending();updateTarget.value=null;await loadReport();messageKind.value='success';message.value=loadError.value?'材料提交成功，列表刷新失败，请重新加载。':'材料提交成功，历史版本已保留。';}catch(e){message.value='提交失败：'+errorText(e)+' 待提交内容已保留，可重试。';}finally{busy.value=false;}}
function requestLock(){if(canLock.value)lockDialog.value?.showModal();}
async function lockReport(){if(!canLock.value)return;lockDialog.value?.close();busy.value=true;message.value='';try{await mockApi.lockReportFile(cycleId.value);await loadReport();messageKind.value='success';message.value='材料已锁定（第 '+lockCount.value+'/'+maxLockCount.value+' 次）。可点「解锁修改」继续改，锁定次数上限 2 次。';}catch(e){messageKind.value='error';message.value='锁定失败：'+errorText(e);}finally{busy.value=false;}}
function openLink(url?:string|null){if(url)window.open(url,'_blank','noopener,noreferrer');}
async function submitMaterialLink(){linkError.value='';linkMessage.value='';message.value='';
 if(linkBusy.value)return;
 if(!linkUrl.value.trim()){linkError.value='请填写飞书云文档链接。';return;}
 if(!linkName.value.trim()){linkError.value='请填写材料名称。';return;}
 linkBusy.value=true;
 try{await mockApi.submitMaterialLink(cycleId.value,{url:linkUrl.value.trim(),name:linkName.value.trim(),type:linkType.value,note:linkNote.value.trim()});linkUrl.value='';linkName.value='';linkNote.value='';linkMessage.value='云文档链接已提交，他评与部长工作台可直接打开。';await loadReport();}
 catch(e:any){const code=String(e?.code??e?.message??'');const map:Record<string,string>={INVALID_LINK_URL:'链接格式不正确，请粘贴完整地址（https:// 开头）。',LINK_DOMAIN_NOT_SUPPORTED:'目前只支持飞书云文档链接（feishu.cn / larksuite.com / feishu.net）。',INVALID_LINK_TYPE:'云文档不能作为主月报，请选择其他材料类型。',REPORT_LOCKED:'材料已锁定，无法新增。',REPORT_UPLOAD_CLOSED:'当前不在材料提交时间内。',INVALID_MATERIAL_METADATA:'请检查材料名称与说明。'};linkError.value=map[code]??errorText(e);}
 finally{linkBusy.value=false;}}
async function unlockPackage(){if(!canUnlock.value||busy.value)return;busy.value=true;message.value='';
 try{await mockApi.unlockReport(cycleId.value);await loadReport();messageKind.value='success';message.value='已解锁，可继续修改材料或新增云文档链接。';}
 catch(e:any){messageKind.value='error';const code=String(e?.code??e?.message??'');message.value=code==='MATERIAL_NOT_LOCKED'?'当前未处于锁定状态。':'解锁失败：'+errorText(e);}
 finally{busy.value=false;}}
function releasePreview(){previewController?.abort();previewController=null;if(renderedUrl.value)URL.revokeObjectURL(renderedUrl.value);renderedUrl.value='';previewLoading.value=false;previewError.value='';}
async function openPreview(report:MaterialVersion){releasePreview();previewReport.value=report;previewDialog.value?.showModal();if(!officeFormats.includes(report.format))return;
 const controller=new AbortController();previewController=controller;previewLoading.value=true;
 try{const response=await fetch(previewUrl.value+'?preview=1',{credentials:'include',signal:controller.signal});if(!response.ok)throw new Error('预览转换暂不可用，可下载原文件查看。');const blob=await response.blob();if(!controller.signal.aborted)renderedUrl.value=URL.createObjectURL(blob);}
 catch(error){if(!controller.signal.aborted)previewError.value=error instanceof Error?error.message:'预览加载失败';}finally{if(previewController===controller)previewLoading.value=false;}}
function closePreview(){previewDialog.value?.close();previewReport.value=null;releasePreview();}
onBeforeUnmount(releasePreview);
onMounted(initialize);
</script>

<template>
 <div class="monthly-workspace personal-standard" :aria-busy="loading||busy">
  <header class="monthly-heading"><div><h1>月度成果</h1><p>每人每周期提交工作成果材料，用于自评与他评参考。</p></div><div class="cycle-control"><label class="sr-only" for="material-cycle">环评周期</label><select id="material-cycle" :value="cycleId" :disabled="busy||loading||!cycles.length" @change="changeCycle"><option v-if="!cycles.length" value="">暂无环评周期</option><option v-for="cycle in cycles" :key="cycle.id" :value="cycle.id">{{cycle.month}} 环评</option></select><span class="cycle-state"><i aria-hidden="true"></i>{{cycleStatus}}</span></div></header>
  <div v-if="loadError" class="feedback error" role="alert"><span>{{loadError}}</span><button type="button" @click="cycles.length?loadReport():initialize()">重新加载</button></div>
  <div v-if="message" class="feedback" :class="messageKind" :role="messageKind==='error'?'alert':'status'">{{message}}</div>
  <section class="summary-grid" aria-label="月度成果概览"><article v-for="card in summaryCards" :key="card.title" class="summary-card" :class="'summary-'+card.skin"><span class="material-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="card.icon"/></svg></span><div><h2>{{card.title}}</h2><strong>{{card.value}}</strong><p>{{card.note}}</p></div></article></section>
  <section class="material-panel" aria-labelledby="materials-title">
   <div class="panel-heading"><div class="panel-title"><h2 id="materials-title">本月成果材料<span v-if="!loading&&!loadError">（{{materials.length}}）</span></h2><p>主月报 1 份，补充材料可多份，各自保留版本。</p></div></div>
   <div v-if="loading" class="material-empty" role="status">正在加载本周期材料…</div><div v-else-if="loadError" class="material-empty">材料暂不可用，请重新加载。</div>
   <div v-else-if="!materials.length" class="material-empty"><span class="material-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="icons.file"/></svg></span><strong>{{currentCycle?'本周期尚未提交材料':'暂无环评周期'}}</strong><p>选择文件，核对材料信息后再确认提交。</p></div>
   <div v-else class="material-table" role="table" aria-label="本月成果材料">
    <div class="table-head" role="row"><span role="columnheader">材料名称</span><span role="columnheader">材料类型</span><span role="columnheader">当前版本</span><span role="columnheader">文件大小</span><span role="columnheader">更新时间</span><span role="columnheader">状态</span><span role="columnheader">操作</span></div>
    <div v-for="material in materials" :key="material.id" class="table-row" role="row">
     <div class="file-cell" role="cell"><span class="file-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="icons.file"/></svg></span><div><strong>{{material.name}}</strong><div class="file-meta"><span class="report-role">{{material.isPrimary?'主月报':'补充材料'}}</span><span>{{current(material)?.format}}</span></div><p v-if="current(material)?.note" class="row-note">{{current(material)?.note}}</p></div></div>
     <div role="cell" data-label="材料类型">{{typeName(material.type)}}</div><div role="cell" data-label="当前版本">V{{current(material)?.version}}</div><div role="cell" data-label="文件大小">{{current(material)?.sizeText}}</div><div role="cell" data-label="更新时间">{{current(material)?.submittedAt||'—'}}</div>
     <div role="cell" data-label="状态"><span class="material-status" :class="statusClass(current(material)?.status??'PROCESSING')">{{statusText(current(material)?.status??'PROCESSING')}}</span></div>
     <div class="row-actions" role="cell"><button type="button" class="material-button" :disabled="!current(material)" @click="current(material)!.externalUrl?openLink(current(material)!.externalUrl):openPreview(current(material)!)">{{current(material)?.externalUrl?'打开':'查看'}}</button><button type="button" class="text-button" :disabled="uploadDisabled" @click="prepareUpload(material)">更新版本</button><button type="button" class="text-button" @click="selectedMaterialId=material.id">历史</button></div>
    </div>
   </div><div class="material-note"><span aria-hidden="true">i</span><p>每份材料独立管理版本。已有主月报请使用“更新版本”，新增补充材料不会替换主月报。</p></div>
  </section>
  <div class="workspace-bottom">
   <section ref="uploadSection" class="material-panel upload-panel" aria-labelledby="upload-title">
    <div class="panel-heading"><div class="panel-title"><h2 id="upload-title">{{updateTarget?'更新材料版本':'上传新材料'}}</h2><p>{{updateTarget?'正在更新：'+updateTarget.name+'。新文件不会影响其他材料。':'先选择文件并核对右侧预填信息，确认后再提交。'}}</p></div><button v-if="updateTarget" type="button" class="text-button" :disabled="busy" @click="prepareUpload()">返回新增材料</button></div>
    <div class="upload-layout" :class="{'has-pending':pending.length>0}">
     <div class="upload-zone" :class="{disabled:uploadDisabled,dragging}" @dragover.prevent="dragging=!uploadDisabled" @dragleave.prevent="dragging=false" @drop.prevent="onDrop"><svg class="upload-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path :d="icons.upload"/></svg><strong>{{busy?'正在提交，请稍候…':locked?'当前材料不可更改':updateTarget?'选择一个新版本文件':'支持一次选择多个文件'}}</strong><p id="upload-help">支持 PDF、Word、PPT、Excel、TXT、JPG/PNG。<br/>PPT/PPTX 小于 50 MiB，其他文件最大 20 MiB。</p><div class="file-picker"><span aria-hidden="true">{{busy?'提交中…':pending.length?'继续选择文件':'选择文件'}}</span><input ref="uploadInput" type="file" :multiple="!updateTarget" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.jpg,.jpeg,.png" aria-label="选择材料文件" aria-describedby="upload-help upload-auto-note" :disabled="uploadDisabled" @change="onFileChange"/></div><small id="upload-auto-note">可拖拽文件到此处；每批最多 10 个文件，确认后才上传。</small></div>
     <div class="upload-context pending-context"><div v-if="!pending.length" class="pending-placeholder"><h3>待提交信息</h3><p>选择文件后，会自动填入材料名称。你可以核对材料类型，并填写版本说明。</p><p class="cloud-link-hint">PPT 太大传不上去时，也可以在下方「飞书云文档链接」里只填一条链接，同样算一份材料。</p><p v-if="updateTarget">当前版本：V{{current(updateTarget)?.version}} · {{typeName(updateTarget.type)}}</p></div>
      <article v-for="(item,index) in pending" :key="item.key" class="pending-card">
       <div class="pending-heading"><strong>文件 {{index+1}}<span>未提交</span></strong><button type="button" class="text-button" :disabled="busy" :aria-label="'移除文件 '+(index+1)" @click="pending.splice(index,1)">移除</button></div><p class="pending-file">{{item.file.name}} · {{fileSize(item.file.size)}}</p>
       <label :for="'material-name-'+item.key">材料名称</label><input :id="'material-name-'+item.key" v-model="item.name" maxlength="200" :disabled="busy" required/>
       <label :for="'material-type-'+item.key">材料类型</label><select :id="'material-type-'+item.key" v-model="item.type" :disabled="busy||!!updateTarget"><option v-for="type in types" :key="type.value" :value="type.value" :disabled="type.value==='MONTHLY_REPORT'&&!updateTarget&&(!!primary||pending.some(p=>p.key!==item.key&&p.type==='MONTHLY_REPORT'))">{{type.label}}</option></select>
       <label :for="'material-note-'+item.key">版本说明（选填）</label><textarea :id="'material-note-'+item.key" v-model="item.note" rows="2" maxlength="300" :disabled="busy" placeholder="简要说明本次提交内容，例如版本变化、包含哪些成果"></textarea><small>版本号由系统生成，无需填写。</small>
      </article>
     </div>
    </div>
    <div class="submit-footer"><span>{{pending.length?'已选择 '+pending.length+' 个文件，尚未提交':'请选择文件后核对信息'}}</span><div><button type="button" class="material-button" :disabled="busy||!pending.length" @click="clearPending">清空</button><button type="button" class="material-button primary" :disabled="uploadDisabled||!pending.length" @click="submitPending">{{busy?'正在提交…':updateTarget?'确认更新版本':'确认提交'+(pending.length?'（'+pending.length+'份）':'')}}</button></div></div>
    <div class="link-submit">
     <div class="link-head"><h3>飞书云文档链接</h3><p>PPT 过大、或成果本身在飞书文档里时，填一条链接即可作为一份材料；他评与部长工作台可直接打开。</p></div>
     <div class="link-grid">
      <label>文档链接<input v-model="linkUrl" type="url" placeholder="https://xxx.feishu.cn/docx/xxxxxx" maxlength="1000" :disabled="uploadDisabled||linkBusy"/></label>
      <label>材料名称<input v-model="linkName" type="text" placeholder="例如：11 月工作汇报（飞书文档）" maxlength="200" :disabled="uploadDisabled||linkBusy"/></label>
      <label>材料类型<select v-model="linkType" :disabled="uploadDisabled||linkBusy"><option v-for="t in linkTypes" :key="t.value" :value="t.value">{{t.label}}</option></select></label>
     </div>
     <label class="link-note">说明（选填）<input v-model="linkNote" type="text" placeholder="例如：内含演示视频与数据附件" maxlength="300" :disabled="uploadDisabled||linkBusy"/></label>
     <div class="link-actions"><span v-if="linkError" class="link-error" role="alert">{{linkError}}</span><span v-else-if="linkMessage" class="link-ok" role="status">{{linkMessage}}</span><span v-else class="link-tip">仅支持飞书云文档域名，文件本体不会上传到本系统。</span><button type="button" class="material-button primary" :disabled="uploadDisabled||linkBusy" @click="submitMaterialLink">{{linkBusy?'提交中…':'提交云文档'}}</button></div>
    </div>
    <div class="lock-warning"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path :d="icons.lock"/></svg><div><strong v-if="manualLocked">成果包已锁定（第 {{lockCount}}/{{maxLockCount}} 次）</strong><strong v-else>材料可锁定，锁定后仍可自行解锁修改。</strong><p v-if="manualLocked">可点「解锁修改」继续改材料或补云文档链接；锁定次数上限 {{maxLockCount}} 次。</p><p v-else>{{pending.length?'请先提交或移除待提交文件，再锁定成果包。':lockCount>0?'已解锁 '+lockCount+' 次，还可锁定 '+(maxLockCount-lockCount)+' 次。':'锁定后他评看到的材料以当前状态为准；需要修改时可自行解锁，最多锁定 2 次。'}}</p></div><button v-if="manualLocked" type="button" class="material-button" :disabled="busy" @click="unlockPackage">{{busy?'处理中…':'解锁修改'}}</button><button v-else type="button" class="material-button" :disabled="!canLock||lockCount>=maxLockCount" @click="requestLock">{{lockCount>=maxLockCount?'已达锁定上限':'锁定全部材料'}}</button></div>
   </section>
   <section class="material-panel history-panel" aria-labelledby="history-title"><div class="panel-heading"><h2 id="history-title">历史版本</h2><span v-if="historyMaterial" class="history-count">共 {{historyMaterial.versions.length}} 个版本</span></div><label v-if="materials.length" class="sr-only" for="history-material">选择历史材料</label><select v-if="materials.length" id="history-material" v-model="selectedMaterialId" class="history-select"><option v-for="m in materials" :key="m.id" :value="m.id">{{m.name}}{{m.isPrimary?'（主月报）':''}}</option></select>
    <div v-if="loading" class="history-empty" role="status">正在读取版本记录…</div><div v-else-if="loadError" class="history-empty">版本记录暂不可用</div><div v-else-if="!historyMaterial" class="history-empty">提交材料后，版本记录将在这里展示。</div><ol v-else class="version-list"><li v-for="report in historyMaterial.versions" :key="report.id" :class="{current:report.isCurrent}"><div class="version-heading"><strong>V{{report.version}}</strong><span :class="report.isCurrent?'version-current':'version-old'">{{report.isCurrent?'当前有效':'历史版本'}}</span></div><time>{{report.submittedAt||'上传时间未记录'}}</time><p>{{report.uploadedBy}} · {{report.fileName}}</p><p v-if="report.note" class="version-note">{{report.note}}</p><div class="version-actions"><span>{{report.externalUrl?'云文档':report.format+' · '+report.sizeText}}</span><button type="button" class="text-button" :aria-label="'查看 V'+report.version+' 文件'" @click="report.externalUrl?openLink(report.externalUrl):openPreview(report)">{{report.externalUrl?'打开链接 ↗':'查看文件 ↗'}}</button></div></li></ol>
   </section>
  </div>
  <dialog ref="previewDialog" class="preview-dialog" aria-labelledby="preview-title" @close="previewReport=null;releasePreview()"><template v-if="previewReport"><header><div><h2 id="preview-title">{{previewReport.fileName}}</h2><span>{{previewReport.format}} · V{{previewReport.version}}</span></div><button type="button" class="close-preview" aria-label="关闭材料预览" @click="closePreview">×</button></header><div v-if="previewReport.format==='PDF'||renderedUrl||previewReport.format==='TXT'" class="preview-body"><iframe :src="renderedUrl||previewUrl" title="材料预览"></iframe></div><div v-else-if="['JPG','JPEG','PNG'].includes(previewReport.format)" class="preview-image"><img :src="previewUrl" :alt="previewReport.fileName"/></div><div v-else class="preview-unsupported"><span class="material-icon">{{previewReport.format}}</span><h3>{{previewLoading?'正在生成在线预览…':'在线预览暂不可用'}}</h3><p>{{previewLoading?'首次转换可能需要一些时间，请稍候。':previewError||'可下载原文件查看。'}}</p><a class="material-button primary" :href="previewUrl" target="_blank" rel="noopener">打开文件</a></div></template></dialog>
  <dialog ref="lockDialog" class="lock-confirm" aria-labelledby="lock-title"><h2 id="lock-title">确认锁定全部材料？</h2><strong>材料一旦锁定将无法更改，请慎重锁定。</strong><p>主月报和所有补充材料都会锁定，他评将看到当前版本。本次为第 {{lockCount+1}} 次锁定，最多可锁定 {{maxLockCount}} 次；锁定后仍可自行解锁修改。</p><div><button type="button" class="material-button" autofocus @click="lockDialog?.close()">返回检查</button><button type="button" class="material-button primary" :disabled="!canLock" @click="lockReport">确认锁定全部材料</button></div></dialog>
 </div>
</template>

<style scoped>
.monthly-workspace { --material-blue: #246bfd; --material-border: #e5eaf2; --material-title: #172b4d; --material-muted: #667085; display: grid; gap: 20px; min-width: 0; color: var(--material-title); font-size: 14px; }
.monthly-workspace * { box-sizing: border-box; }
.monthly-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; }
.monthly-heading h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.4; font-weight: 650; letter-spacing: -.02em; }
.monthly-heading p { margin: 0; color: var(--material-muted); line-height: 24px; }
.cycle-control { display: grid; gap: 6px; flex: 0 0 210px; padding: 10px 12px; border: 1px solid #cdddfc; border-radius: 9px; background: #fff; }
.cycle-control select { width: 100%; min-width: 0; border: 0; padding: 2px 0; background: #fff; color: var(--material-blue); font: inherit; font-weight: 600; cursor: pointer; }
.cycle-state { display: flex; align-items: center; gap: 6px; color: var(--material-muted); font-size: 12px; }
.cycle-state i { width: 6px; height: 6px; border-radius: 50%; background: #7c92b3; }
.summary-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; }
.summary-card { display: flex; align-items: center; gap: 16px; min-width: 0; min-height: 142px; padding: 22px 20px; border: 1px solid #e2eaf4; border-radius: 12px; background-repeat: no-repeat; background-position: right center; background-size: auto 100%; box-shadow: 0 4px 14px #172b4d06; }
.summary-cycle, .summary-submission, .summary-package { background: #fff; }
.summary-card > div { flex: 1; min-width: 0; padding-right: 48px; }
.summary-card .material-icon { background: #ffffffb8; border: 1px solid #ffffffc9; box-shadow: 0 2px 7px #345b8e05; }
.summary-card h2 { margin: 0 0 6px; color: var(--material-muted); font-size: 13px; font-weight: 500; }
.summary-card strong { font-size: 23px; font-weight: 650; line-height: 30px; font-variant-numeric: tabular-nums; }
.summary-card p { margin: 5px 0 0; color: var(--material-muted); font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
.material-icon { display: grid; place-items: center; flex: 0 0 48px; width: 48px; height: 48px; border-radius: 14px; color: var(--material-blue); background: #eef4ff; }
.material-icon svg, .file-icon svg { width: 25px; height: 25px; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.material-panel { min-width: 0; padding: 22px; border: 1px solid var(--material-border); border-radius: 11px; background: #fff; box-shadow: 0 2px 6px #172b4d05; }
.panel-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
.panel-heading h2 { margin: 0; color: var(--material-title); font-size: 18px; line-height: 26px; font-weight: 600; }
.panel-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 16px; }
.panel-title p { margin: 0; color: var(--material-muted); font-size: 13px; line-height: 22px; }
.material-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 7px 12px; border: 1px solid #dce3ed; border-radius: 6px; background: #fff; color: #405470; text-decoration: none; font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
.material-button.primary { border-color: var(--material-blue); background: var(--material-blue); color: #fff; }
.material-button.primary > span { font-size: 18px; line-height: 18px; }
.material-button:hover:not(:disabled) { border-color: #a9c5fb; background: #f5f8ff; color: var(--material-blue); }
.material-button.primary:hover:not(:disabled) { border-color: #195cde; background: #195cde; color: #fff; }
.text-button { border: 0; padding: 4px 0; background: transparent; color: var(--material-blue); font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
.monthly-workspace button:disabled { color: #9aa5b5; border-color: #e4e9f0; background: #f5f7fa; cursor: not-allowed; }
.monthly-workspace .text-button:disabled { background: transparent; }
.monthly-workspace button:focus-visible, .monthly-workspace a:focus-visible, .monthly-workspace select:focus-visible, .file-picker:focus-within { outline: 3px solid #a7c3ff; outline-offset: 3px; }
.table-head, .table-row { display: grid; grid-template-columns: minmax(150px,2.1fr) minmax(90px,1fr) 66px 78px minmax(115px,1.1fr) 82px 155px; align-items: center; gap: 10px; }
.table-head { padding: 11px 12px; border-radius: 6px; background: #f5f7fb; color: #748198; font-size: 12px; }
.table-row { padding: 18px 12px; border-bottom: 1px solid #edf0f5; color: #53637b; font-size: 13px; }
.file-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
.file-cell > div { min-width: 0; }
.file-cell strong { display: block; color: var(--material-title); line-height: 22px; font-weight: 600; overflow-wrap: anywhere; }
.file-icon { display: grid; place-items: center; width: 36px; height: 42px; flex: 0 0 36px; border-radius: 7px; background: #f0f5ff; color: var(--material-blue); }
.file-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 4px; color: #8692a4; font-size: 11px; }
.report-role { display: inline-block; padding: 1px 6px; border-radius: 4px; background: #edf4ff; color: #3b6fc4; font-size: 11px; line-height: 18px; white-space: nowrap; }
.material-status { display: inline-flex; padding: 3px 7px; border-radius: 5px; font-size: 12px; white-space: nowrap; }
.material-status.success { color: #258363; background: #ecf8f2; }
.material-status.error { color: #b83d39; background: #fff0ef; }
.material-status.neutral { color: #667085; background: #f1f3f6; }
.material-status.pending { color: #3e6cb3; background: #edf4ff; }
.row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.material-note { display: flex; align-items: baseline; gap: 9px; margin-top: 16px; padding: 9px 12px; border: 1px solid #e1eafe; border-radius: 6px; background: #f6f9ff; color: #6a7f9f; font-size: 12px; line-height: 21px; }
.material-note > span { display: grid; place-items: center; flex: 0 0 14px; height: 14px; border: 1px solid #8ca8d4; border-radius: 50%; font-size: 10px; }
.material-note p { margin: 0; }
.material-empty { display: grid; justify-items: center; gap: 10px; padding: 30px 16px; color: var(--material-muted); text-align: center; }
.material-empty strong { color: #4f607b; font-weight: 500; }
.material-empty p { margin: 0; font-size: 13px; line-height: 22px; }
.workspace-bottom { display: grid; grid-template-columns: minmax(0,1.7fr) minmax(300px,1fr); align-items: start; gap: 18px; }
.upload-panel .panel-title { display: block; }
.upload-panel .panel-title p { margin-top: 6px; }
.upload-layout { display: grid; grid-template-columns: minmax(0,1.2fr) minmax(0,1fr); gap: 22px; }
.upload-zone { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; min-height: 205px; padding: 20px 12px; border: 1px dashed #a9c6fa; border-radius: 7px; background: #f9fbff; text-align: center; }
.upload-zone.disabled { border-color: #d9e0e9; background: #fafbfd; }
.upload-icon { width: 30px; height: 30px; margin-bottom: 12px; stroke: var(--material-blue); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.upload-zone strong { font-size: 14px; font-weight: 500; line-height: 23px; }
.upload-zone p { margin: 8px 0 12px; color: #7c8ba2; font-size: 12px; line-height: 20px; }
.upload-zone small { margin-top: 8px; color: #7c8ba2; font-size: 11px; }
.file-picker { position: relative; padding: 8px 15px; border-radius: 6px; background: var(--material-blue); color: #fff; font-size: 13px; }
.file-picker:has(input:disabled) { background: #e8edf5; color: #8e9aae; }
.file-picker input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file-picker input:disabled { cursor: not-allowed; }
.upload-context { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.upload-context h3 { margin: 0 0 8px; font-size: 13px; line-height: 20px; font-weight: 500; }
.type-value { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 10px; border: 1px solid var(--material-border); border-radius: 6px; color: #53637b; font-size: 13px; }
.current-version { margin: 0; color: #47658f; font-size: 14px; }
.current-version span { display: block; margin-top: 4px; color: var(--material-muted); font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
.upload-guidance p { margin: 0; color: var(--material-muted); font-size: 12px; line-height: 22px; }
.lock-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 18px; padding-top: 16px; border-top: 1px solid #edf0f5; }
.lock-footer p { flex: 1; min-width: 150px; margin: 0; color: #7c8ba2; font-size: 12px; line-height: 21px; }
.history-count { color: #8b96a8; font-size: 12px; }
.history-description { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: -3px 0 20px; color: var(--material-muted); font-size: 13px; }
.history-empty { padding: 50px 10px; color: #8b96a8; font-size: 13px; line-height: 23px; text-align: center; }
.version-list { margin: 0; padding: 0 0 0 14px; list-style: none; }
.version-list li { position: relative; padding: 0 0 22px 20px; border-left: 1px solid #e0e8f5; }
.version-list li:last-child { padding-bottom: 0; border-left-color: transparent; }
.version-list li::before { content: ''; position: absolute; top: 6px; left: -5px; width: 9px; height: 9px; border: 2px solid #fff; border-radius: 50%; background: #a9c6fa; box-shadow: 0 0 0 1px #e6eefd; }
.version-list li.current::before { background: var(--material-blue); }
.version-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
.version-heading strong { padding: 2px 9px; border-radius: 4px; background: #eef4ff; color: #3571d0; font-size: 13px; font-weight: 600; }
.version-current { color: #258363; font-size: 11px; }
.version-old { color: #98a2b3; font-size: 11px; }
.version-list time { display: block; margin-top: 9px; color: #748198; font-size: 12px; }
.version-list p { margin: 5px 0 8px; color: #53637b; font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
.version-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; color: #98a2b3; font-size: 11px; }
.version-actions .text-button { font-size: 12px; }
.feedback { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 12px 16px; border: 1px solid #cfe9dc; border-radius: 8px; background: #f1faf5; color: #258363; line-height: 22px; }
.feedback.error { border-color: #f2d4d0; background: #fff6f5; color: #b83d39; }
.feedback button { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
.preview-dialog { width: min(980px,92vw); max-width: 92vw; height: min(760px,88vh); max-height: 88vh; padding: 0; border: 0; border-radius: 12px; background: #fff; color: var(--material-title); box-shadow: 0 18px 60px #172b4d44; }
.preview-dialog[open] { display: flex; flex-direction: column; }
.preview-dialog::backdrop { background: #172b4d88; }
.preview-dialog header { display: flex; justify-content: space-between; align-items: center; gap: 15px; padding: 14px 18px; border-bottom: 1px solid var(--material-border); }
.preview-dialog header > div { min-width: 0; }
.preview-dialog h2 { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
.preview-dialog header span { display: block; margin-top: 4px; color: var(--material-muted); font-size: 12px; }
.close-preview { flex: 0 0 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: #f5f7fa; color: #53637b; font-size: 24px; cursor: pointer; }
.preview-body { flex: 1; min-height: 0; background: #525659; }
.preview-body iframe { width: 100%; height: 100%; border: 0; }
.preview-unsupported { display: grid; place-items: center; align-content: center; gap: 12px; flex: 1; padding: 24px; text-align: center; }
.preview-unsupported h3, .preview-unsupported p { margin: 0; line-height: 24px; }
.preview-unsupported p { color: var(--material-muted); font-size: 13px; }
@media (max-width: 1400px) { .summary-card { gap: 12px; padding: 18px 16px; } .summary-card .material-icon { flex-basis: 40px; width: 40px; height: 40px; border-radius: 10px; } .table-head, .table-row { grid-template-columns: minmax(130px,1.8fr) 94px 54px 67px 100px 70px 145px; gap: 8px; } .row-actions { gap: 8px; } .workspace-bottom { grid-template-columns: minmax(0,1.7fr) minmax(270px,1fr); } .upload-layout { gap: 16px; } }
@media (max-width: 1100px) { .summary-card { align-items: flex-start; gap: 10px; } .summary-card > div { padding-right: 24px; } .summary-card strong { font-size: 21px; } .summary-card .material-icon { flex-basis: 32px; width: 32px; height: 32px; border-radius: 8px; } .summary-card svg { width: 21px; height: 21px; } .workspace-bottom { grid-template-columns: 1fr; } .table-head { display: none; } .table-row { grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; padding: 12px 0; } .file-cell { grid-column: 1 / -1; } .table-row [data-label]::before { content: attr(data-label); display: block; margin-bottom: 6px; color: #8b96a8; font-size: 12px; } .row-actions { align-self: end; justify-content: flex-start; } }
@media (max-width: 700px) { .monthly-heading { align-items: flex-start; flex-direction: column; gap: 16px; } .cycle-control { flex-basis: auto; width: 100%; } .summary-grid { grid-template-columns: 1fr; gap: 12px; } .summary-card { align-items: center; padding: 16px; gap: 14px; } .summary-card .material-icon { flex-basis: 40px; width: 40px; height: 40px; } .material-panel { padding: 18px 16px; } .upload-layout { grid-template-columns: 1fr; } .monthly-heading h1 { font-size: 25px; } .table-row { grid-template-columns: repeat(2,minmax(0,1fr)); } .row-actions { grid-column: 1 / -1; } .panel-heading > .material-button { width: 100%; } }
.upload-layout { grid-template-columns: minmax(0,1fr) minmax(0,1.35fr); align-items: stretch; }
.upload-zone { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; min-height:260px; padding:24px 18px; }
.upload-zone > p,.upload-zone > small { margin:0; line-height:22px; }
.upload-zone.dragging { border-color:#3370ff; background:#edf4ff; }
.pending-placeholder { height:100%; min-height:260px; display:flex; flex-direction:column; justify-content:center; }
.cloud-link-hint { padding-top:12px; border-top:1px solid #e5eaf2; }
.preview-image { flex:1; min-height:0; overflow:auto; display:grid; place-items:center; background:#f5f7fa; }
.preview-image img { max-width:100%; max-height:100%; object-fit:contain; }
.has-pending .upload-zone { align-self:start; }
.pending-context { gap: 14px; }
.pending-placeholder { padding: 16px; border: 1px solid #e5eaf2; border-radius: 7px; background: #fafbfd; }
.pending-placeholder p { color: var(--material-muted); font-size: 13px; line-height: 23px; }
.pending-card { padding: 14px; border: 1px solid #dce6f7; border-radius: 8px; background: #fcfdff; }
.pending-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.pending-heading strong { font-size: 13px; font-weight: 600; }
.pending-heading strong span { margin-left: 8px; color: #8293ad; font-size: 11px; font-weight: 400; }
.pending-file { margin: 5px 0 12px; color: var(--material-muted); font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
.pending-card label { display: block; margin: 10px 0 5px; color: #53637b; font-size: 12px; }
.pending-card input,.pending-card select,.pending-card textarea,.history-select { width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid #dce3ed; border-radius: 6px; background: #fff; color: var(--material-title); font: inherit; font-size: 13px; }
.pending-card textarea { resize: vertical; }
.pending-card input:focus,.pending-card select:focus,.pending-card textarea:focus { outline: 2px solid #b3cbfc; outline-offset: 1px; border-color: #7ea8f5; }
.pending-card small { display: block; margin-top: 6px; color: #8c99ac; font-size: 11px; }
.submit-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding-top: 18px; margin-top: 18px; border-top: 1px solid #edf0f5; color: #7c8ba2; font-size: 12px; }
.submit-footer > div { display: flex; gap: 10px; }
.lock-warning { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 10px; margin-top: 20px; padding: 14px; border: 1px solid #f0dfb8; border-radius: 7px; background: #fffbf2; }
.lock-warning > svg { flex: 0 0 19px; width: 19px; height: 19px; margin-top: 2px; stroke: #b18a35; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.lock-warning > div { flex: 1; min-width: 180px; }
.lock-warning strong { color: #866328; font-size: 13px; font-weight: 600; line-height: 22px; }
.lock-warning p { margin: 4px 0 0; color: #9b8256; font-size: 12px; line-height: 21px; }
.lock-warning > button { margin-left: auto; }
.history-select { margin: 0 0 22px; }
.row-note { margin: 6px 0 0; color: #8a97aa; font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
.version-note { color: #6b7f9d !important; }
.lock-confirm { width: min(440px,92vw); padding: 26px; border: 0; border-radius: 12px; color: var(--material-title); box-shadow: 0 18px 60px #172b4d44; }
.lock-confirm::backdrop { background: #172b4d88; }
.lock-confirm h2 { margin: 0 0 18px; font-size: 19px; }
.lock-confirm > strong { display: block; color: #986c24; font-size: 14px; line-height: 24px; }
.lock-confirm p { margin: 10px 0 24px; color: var(--material-muted); font-size: 13px; line-height: 24px; }
.lock-confirm > div { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
@media (max-width: 700px) { .upload-layout { grid-template-columns: 1fr; } .lock-warning > div { min-width: 150px; } .submit-footer > div { width: 100%; justify-content: flex-end; } }
.link-submit{margin-top:18px;padding:16px;border:1px solid #dce6f7;border-radius:8px;background:#fbfcff}
.link-head h3{margin:0;font-size:13px;font-weight:600;color:var(--material-title)}
.link-head p{margin:5px 0 12px;color:var(--material-muted);font-size:12px;line-height:20px}
.link-grid{display:grid;grid-template-columns:1.5fr 1fr .8fr;gap:10px}
.link-grid label,.link-note{display:block;color:#53637b;font-size:12px}
.link-grid input,.link-grid select,.link-note input{display:block;width:100%;margin-top:5px;padding:8px 10px;border:1px solid #dce3ed;border-radius:6px;background:#fff;color:var(--material-title);font:inherit;font-size:13px;box-sizing:border-box}
.link-grid input:focus,.link-grid select:focus,.link-note input:focus{outline:2px solid #b3cbfc;outline-offset:1px;border-color:#7ea8f5}
.link-note{margin-top:10px}
.link-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:12px}
.link-tip,.link-error,.link-ok{flex:1;min-width:160px;font-size:12px;line-height:20px}
.link-tip{color:#8a97aa}
.link-error{color:#c2413b}
.link-ok{color:#258363}
@media (max-width:900px){.link-grid{grid-template-columns:1fr}}
</style>
