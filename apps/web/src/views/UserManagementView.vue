<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mockApi } from '../api';
import {capabilityLabels} from '../lib/management-labels';
import {useAuth} from '../stores/auth';
import FeishuDirectoryPanel from '../components/FeishuDirectoryPanel.vue';
import FeishuPrebindingPanel from '../components/FeishuPrebindingPanel.vue';
import FeishuAdmissionPanel from '../components/FeishuAdmissionPanel.vue';
const auth=useAuth();
const bindingRevision = ref(0);
function refreshBindings(){ bindingRevision.value++; void load(); }
const users = ref<any[]>([]),error=ref(''),loading=ref(false),keyword=ref('');
const filtered=computed(()=>users.value.filter(u=>!keyword.value.trim()||[u.display_name,u.departments].some(v=>String(v??'').includes(keyword.value.trim()))));
async function load(){loading.value=true;error.value='';try{users.value=await mockApi.listManagedUsers();}catch{error.value='用户账号加载失败，请稍后重试。';}finally{loading.value=false;}}
onMounted(load);
</script>
<template>
 <div class="users-settings">
  <div class="module-intro"><h2>用户管理</h2><p>管理系统账号状态、组织归属与专项授权。</p></div>
  <FeishuDirectoryPanel v-if="auth.user?.capabilities.includes('org.manage')" @imported="refreshBindings" />
  <FeishuPrebindingPanel :key="'preview'+bindingRevision" v-if="auth.user?.capabilities.includes('org.manage')" />
  <FeishuAdmissionPanel :key="'binding'+bindingRevision" v-if="auth.user?.capabilities.includes('org.manage')" />
  <section class="card user-directory" aria-labelledby="user-directory-title" :aria-busy="loading">
   <header class="directory-heading"><div><h2 id="user-directory-title">用户账号</h2><p>查看成员账号状态、部门及已获授权。</p></div><span>{{users.length}} 名成员</span></header>
   <div class="directory-toolbar"><label><span class="sr-only">搜索成员或部门</span><input v-model="keyword" type="search" placeholder="搜索成员或部门"></label><button class="btn" :disabled="loading" @click="load">{{loading?'正在刷新…':'刷新用户'}}</button></div>
   <p v-if="error" class="notice notice-error" role="alert">{{error}} <button class="btn" :disabled="loading" @click="load">重试</button></p>
   <p v-if="loading" class="panel-state" role="status">正在读取用户账号…</p>
   <div v-else-if="!error||users.length" class="table-wrap"><table class="table user-management-table"><colgroup><col style="width:15%"><col style="width:13%"><col style="width:17%"><col style="width:35%"><col style="width:20%"></colgroup><thead><tr><th scope="col">姓名</th><th scope="col">账号状态</th><th scope="col">部门</th><th scope="col">专项权限</th><th scope="col">创建时间</th></tr></thead><tbody><tr v-for="u in filtered" :key="u.id"><td><strong>{{u.display_name}}</strong></td><td><span class="chip" :class="u.status==='ACTIVE'?'chip-green':'chip-gray'">{{u.status==='ACTIVE'?'正常':u.status==='SUSPENDED'?'已暂停':'已停用'}}</span></td><td>{{u.departments||'未分配'}}</td><td><span v-for="c in (u.capabilities||[]).slice(0,3)" :key="c" class="permission-label">{{capabilityLabels[c]??'其他授权'}}</span><span v-if="!u.capabilities?.length" class="muted">普通成员</span><details v-if="u.capabilities?.length>3"><summary>查看全部 {{u.capabilities.length}} 项权限</summary><p>{{u.capabilities.map((c:string)=>capabilityLabels[c]??'其他授权').join('、')}}</p></details></td><td>{{u.created_at?new Date(u.created_at).toLocaleDateString('zh-CN'):'—'}}</td></tr><tr v-if="!filtered.length"><td colspan="5" class="panel-state">{{users.length?'未找到匹配的成员，请调整搜索条件。':'暂无用户账号。'}}</td></tr></tbody></table></div>
  </section>
 </div>
</template>
<style scoped>
.users-settings{min-width:0}.module-intro{margin-bottom:18px}.module-intro h2{font-size:18px}.module-intro p,.directory-heading p{font-size:13px;line-height:21px;color:var(--lark-text-2);margin:6px 0 0}.directory-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.directory-heading>span{font-size:12px;color:var(--lark-text-3);flex:none;padding-top:4px}.directory-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:18px 0 16px}.directory-toolbar input{width:240px;max-width:100%}.user-management-table{min-width:700px;table-layout:fixed}.user-management-table td{white-space:normal;overflow-wrap:anywhere;vertical-align:middle}.permission-label{display:inline-flex;background:#f4f7fc;border-radius:4px;padding:2px 6px;font-size:12px;color:#687890;margin:2px 5px 2px 0}.user-management-table details{font-size:12px;color:var(--lark-text-2);margin-top:5px}.user-management-table details p{margin:7px 0;line-height:22px}.panel-state{text-align:center;color:var(--lark-text-3);font-size:13px;padding:25px 14px!important}.muted{color:var(--lark-text-3)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@media(max-width:760px){.directory-toolbar label{flex:1;min-width:150px}.directory-toolbar input{width:100%}}
</style>
