<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { managementRequest } from '../api/management';
import { useAuth } from '../stores/auth';

type DirectoryMember = { openId: string; name: string; departmentNames: string[]; status: 'new' | 'existing' | 'conflict' };
const emit = defineEmits<{ imported: [] }>();
const auth = useAuth();
const appId = ref(''), secret = ref(''), tenantKey = ref(''), redirectUri = ref('');
const configured = ref(false), busy = ref(false), error = ref(''), notice = ref('');
const directory = ref<DirectoryMember[]>([]), previewed = ref(false), selected = ref<string[]>([]);
const department = ref(''), ownId = ref('');
const departments = computed(() => [...new Set(directory.value.flatMap(member => member.departmentNames))].sort());
const visible = computed(() => directory.value.filter(member => !department.value || member.departmentNames.includes(department.value)));
const statusLabel = { new: '新增', existing: '已绑定，可更新姓名', conflict: '冲突，请核对后绑定' };

async function run(task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try { await task(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败'; }
  finally { busy.value = false; }
}
async function load() {
  const settings = await managementRequest<{appId?: string; tenantKey?: string; redirectUri: string}>('integrations/feishu/settings');
  appId.value = settings.appId || '';
  tenantKey.value = settings.tenantKey || '';
  redirectUri.value = settings.redirectUri;
  configured.value = !!settings.appId;
}
async function save() {
  await run(async () => {
    const result = await managementRequest<{visibleMembers: number}>('integrations/feishu/settings', {appId: appId.value.trim(), secret: secret.value.trim(), tenantKey: tenantKey.value.trim()});
    secret.value = '';
    await load();
    notice.value = `连接已保存，通讯录可见 ${result.visibleMembers} 人。`;
    emit('imported');
  });
}
async function readPreview() {
  directory.value = await managementRequest<DirectoryMember[]>('integrations/feishu/import');
  selected.value = [];
  previewed.value = true;
}
async function apply() {
  await run(async () => {
    const result = await managementRequest<{created: number; updated: number; skipped: number}>('integrations/feishu/import', {ids: selected.value});
    notice.value = `新增 ${result.created} 人，更新 ${result.updated} 人，跳过 ${result.skipped} 人。`;
    selected.value = [];
    previewed.value = false;
    emit('imported');
  });
}
async function bindSelf() {
  const userId = auth.user?.id;
  if (!userId) return;
  await run(async () => {
    await managementRequest('auth/feishu/bindings', {user_id: userId, external_id: ownId.value.trim(), reason: '管理员确认绑定自己的飞书身份'});
    ownId.value = '';
    notice.value = '已绑定当前管理员。请在另一个浏览器会话验证飞书登录。';
    emit('imported');
  });
}
onMounted(() => run(load));
</script>

<template>
  <section class="card feishu-directory" :aria-busy="busy">
    <h2>飞书接入与名单导入</h2>
    <form @submit.prevent="save">
      <label>回调地址<input :value="redirectUri" readonly></label>
      <label>App ID<input v-model="appId" :readonly="configured" required></label>
      <label>App Secret<input v-model="secret" type="password" autocomplete="new-password" required></label>
      <label>租户标识（tenant_key）<input v-model="tenantKey" :readonly="configured" required></label>
      <button class="btn btn-primary" :disabled="busy">测试连接并保存</button>
    </form>
    <template v-if="configured">
      <details>
        <summary>绑定当前管理员</summary>
        <p>请输入该应用下你自己的飞书 Open ID。绑定后请先验证飞书登录，再退出当前会话。</p>
        <form @submit.prevent="bindSelf">
          <label>本人的 Open ID<input v-model="ownId" placeholder="ou_…" required></label>
          <button class="btn" :disabled="busy">确认绑定当前账号</button>
        </form>
      </details>
      <button type="button" class="btn" :disabled="busy" @click="run(readPreview)">预览飞书名单</button>
      <div v-if="previewed">
        <label>筛选部门<select v-model="department"><option value="">全部部门</option><option v-for="name in departments" :key="name">{{ name }}</option></select></label>
        <button type="button" class="btn" :disabled="busy || !visible.length" @click="selected = [...new Set([...selected, ...visible.filter(m => m.status !== 'conflict').map(m => m.openId)])]">选择当前可导入人员</button>
        <p v-if="!visible.length">没有可显示的成员。</p>
        <ul class="directory-list">
          <li v-for="member in visible" :key="member.openId">
            <label><input v-model="selected" type="checkbox" :value="member.openId" :disabled="busy || member.status === 'conflict'">
              {{ member.name }} · {{ member.departmentNames.join('、') || '无部门' }} · {{ statusLabel[member.status] }}
            </label>
          </li>
        </ul>
        <button type="button" class="btn btn-primary" :disabled="busy || !selected.length" @click="apply">确认导入 {{ selected.length }} 人</button>
        <button type="button" class="btn" :disabled="busy || !selected.length" @click="selected = []">清空选择</button>
      </div>
    </template>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.feishu-directory { display: grid; gap: 12px; padding: 20px; }
h2 { margin: 0; }
form { display: grid; gap: 10px; max-width: 620px; }
form label { display: grid; gap: 4px; }
form button, .feishu-directory > button { justify-self: start; }
.directory-list { max-height: 350px; overflow: auto; padding-left: 0; list-style: none; }
.directory-list li { padding: 5px 0; }
[role="alert"] { color: #ad1c24; }
</style>
