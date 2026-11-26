<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mockApi } from '../api';

const users = ref<any[]>([]);
const loading=ref(true),error=ref('');
const NODE_ORDER = ['教学事务委员会', '科技部', '研发部', '产品部', '生态部', '网监部', '指导老师组'];
const departments = computed(() => {
  const map = new Map<string, { id: string; name: string; users: any[] }>();
  for (const user of users.value) {
    // 真实后端模式可能只返回 deptName（无 deptId），用名称兜底做分组键
    const key = user.deptId || user.deptName || '(未分配)';
    if (!map.has(key)) map.set(key, { id: key, name: user.deptName || '(未分配)', users: [] });
    map.get(key)!.users.push(user);
  }
  for(const dept of map.values()) dept.users.sort((a,b)=>Number(b.roles?.includes('HEAD'))-Number(a.roles?.includes('HEAD')) || a.displayName.localeCompare(b.displayName,'zh-Hans-CN'));
  return [...map.values()].sort((a, b) => {
    const aIndex = NODE_ORDER.indexOf(a.name), bIndex = NODE_ORDER.indexOf(b.name);
    return (aIndex < 0 ? NODE_ORDER.length : aIndex) - (bIndex < 0 ? NODE_ORDER.length : bIndex)
      || a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
});
// 真实后端 /organization 不返回用户角色职责，此时角色标签与统计仅供参考
const rolesAvailable = computed(() => users.value.some((user) => user.roles?.length));
const heads = computed(() => users.value.filter((user) => user.roles?.includes('HEAD')).length);

async function load(){loading.value=true;error.value='';try{users.value=await mockApi.listUsers();}catch(e:any){error.value=e.message||'组织信息加载失败';}finally{loading.value=false;}}
onMounted(load);
function roleLabel(user: any) {
  if (user.deptName === '指导老师组') return '指导老师';
  if (user.deptName === '教学事务委员会') return '直属成员';
  if (user.roles?.includes('HEAD')) return '部长';
  if (user.roles?.includes('SUPERVISOR')) return '监管';
  return '成员';
}
function roleClass(user: any) {
  if (user.deptName === '指导老师组' || user.roles?.includes('HEAD')) return 'chip-blue';
  if (user.deptName === '教学事务委员会') return 'chip-gray';
  if (user.roles?.includes('SUPERVISOR')) return 'chip-gray';
  return 'chip-green';
}
function memberSubtitle(dept: { name: string }, user: any) {
  if (dept.name === '指导老师组') return '指导老师组成员';
  if (dept.name === '教学事务委员会') return '委员会直属人员';
  return user.roles?.includes('HEAD') ? '部门负责人' : '组织成员';
}
</script>

<template>
  <div class="personal-standard organization-workspace">
    <div class="page-head">
      <div>
        <h1 class="page-title">组织架构</h1>
        <p class="page-sub">三个工作区共用同一组织数据源；人员改名、部门变更不应在多个页面分别维护。</p>
      </div>
    </div>

    <div class="grid grid-3">
      <div class="card"><div class="tag">组织人数</div><div class="kpi">{{ loading||error?'—':users.length }}</div><div class="tag">委员会、五个业务部门及指导老师组</div></div>
      <div class="card"><div class="tag">组织节点</div><div class="kpi">{{ loading||error?'—':departments.length }}</div><div class="tag">按当前组织归属展示</div></div>
      <div class="card"><div class="tag">业务部门负责人</div><div class="kpi">{{ loading||error?'—':heads }}</div><div class="tag">仅标注为负责人的成员显示为部长</div></div>
    </div>
    <p v-if="loading" class="notice">正在读取真实组织信息…</p>
    <p v-else-if="error" class="notice" role="alert">组织信息加载失败：{{ error }} <button class="btn btn-sm" @click="load">重试</button></p>
    <div v-else-if="!rolesAvailable" class="notice" style="margin-bottom:16px">组织接口未返回职责信息时，下方角色标签统一显示为「成员」。</div>

    <div class="org-grid">
      <section v-for="dept in departments" :key="dept.id" class="card dept-card">
        <div class="row" style="justify-content:space-between">
          <h3>{{ dept.name }}</h3>
          <span class="chip chip-gray">{{ dept.users.length }} 人</span>
        </div>
        <div class="member-list">
          <div v-for="user in dept.users" :key="user.id" class="member-row">
            <div>
              <b>{{ user.displayName }}</b>
              <div class="tag">{{ memberSubtitle(dept, user) }}</div>
            </div>
            <span class="chip" :class="roleClass(user)">{{ roleLabel(user) }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.org-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.dept-card { margin-bottom: 0; }
.dept-card h3 { margin: 0; }
.member-list { display: grid; gap: 8px; }
.member-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--lark-border-light); }
.member-row:last-child { border-bottom: 0; }
</style>
