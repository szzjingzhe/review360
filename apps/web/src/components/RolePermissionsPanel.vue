<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuth } from '../stores/auth';
import { managementRequest } from '../api/management';
import { capabilityLabels } from '../lib/management-labels';

type Member = {
  id: string; display_name: string; departments?: string; status?: string;
  primary_department_id?: string | null; primary_department_name?: string | null;
};
type Grant = {
  id: string; user_id: string; display_name?: string; capability: string; scope_type: string;
  scope_id?: string | null; reason?: string | null; valid_from?: string; valid_to?: string | null; revoked_at?: string | null;
};

const auth = useAuth();
const users = ref<Member[]>([]);
const grants = ref<Grant[]>([]);
const nameFilter = ref('');
const departmentFilter = ref('');
const expanded = ref<Record<string, boolean>>({});
const reasonByUser = ref<Record<string, string>>({});
const draftPermissions = ref<Record<string, string[]>>({});
const rowError = ref<Record<string, string>>({});
const busyUsers = ref<Record<string, boolean>>({});
const error = ref('');
const loading = ref(false);

// Only offer capabilities the current operator already holds. The server also
// checks both org.manage and the delegated capability before saving.
const permissionOptions = computed(() => Object.keys(capabilityLabels)
  .map((value) => ({ value, label: capabilityLabels[value] }))
  .filter((item) => auth.user?.capabilities.includes(item.value)));

function memberDepartment(member: Member) {
  return member.primary_department_name?.trim() || '未分配部门';
}
const departments = computed(() => [...new Set(users.value.map(memberDepartment))]
  .sort((a, b) => a.localeCompare(b, 'zh-CN')));
const filteredUsers = computed(() => users.value.filter((member) => {
  const department = memberDepartment(member);
  return (!departmentFilter.value || department === departmentFilter.value)
    && (!nameFilter.value.trim() || member.display_name.toLowerCase().includes(nameFilter.value.trim().toLowerCase()));
}));
const groups = computed(() => {
  const grouped = new Map<string, Member[]>();
  for (const member of filteredUsers.value) {
    const department = memberDepartment(member);
    if (!grouped.has(department)) grouped.set(department, []);
    grouped.get(department)!.push(member);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'));
});

function activeOrgGrants(userId: string) {
  const now = Date.now();
  return grants.value.filter((grant) => grant.user_id === userId && grant.scope_type === 'ORG'
    && !grant.revoked_at && (!grant.valid_from || Date.parse(grant.valid_from) <= now)
    && (!grant.valid_to || Date.parse(grant.valid_to) > now));
}
function hasGrant(userId: string, capability: string) {
  return activeOrgGrants(userId).some((grant) => grant.capability === capability);
}
function grantedCapabilities(userId: string) {
  return [...new Set(activeOrgGrants(userId).map((grant) => grant.capability))];
}
function pendingAdditions(userId: string) {
  const selected = draftPermissions.value[userId] ?? grantedCapabilities(userId);
  const current = new Set(grantedCapabilities(userId));
  return selected.filter((capability) => !current.has(capability));
}
function hasDraftChanges(userId: string) {
  const selected = new Set(draftPermissions.value[userId] ?? grantedCapabilities(userId));
  const current = new Set(grantedCapabilities(userId));
  return selected.size !== current.size || [...selected].some((capability) => !current.has(capability));
}
function pickerToggled(member: Member, event: Event) {
  const picker = event.currentTarget as HTMLDetailsElement;
  if (picker.open) {
    draftPermissions.value[member.id] = grantedCapabilities(member.id);
    reasonByUser.value[member.id] = '';
    rowError.value[member.id] = '';
  }
}
function draftPermission(member: Member, capability: string, event: Event) {
  const selected = new Set(draftPermissions.value[member.id] ?? grantedCapabilities(member.id));
  if ((event.target as HTMLInputElement).checked) selected.add(capability);
  else selected.delete(capability);
  draftPermissions.value[member.id] = [...selected];
  rowError.value[member.id] = '';
}
function cancelPermissionChanges(member: Member, event: Event) {
  draftPermissions.value[member.id] = grantedCapabilities(member.id);
  reasonByUser.value[member.id] = '';
  rowError.value[member.id] = '';
  (event.currentTarget as HTMLButtonElement).closest('details')?.removeAttribute('open');
}
function toggleDepartment(department: string) {
  expanded.value[department] = !(expanded.value[department] ?? true);
}
function displayError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/^Error:\s*/, '') || '操作失败，请稍后重试';
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [memberData, grantData] = await Promise.all([
      managementRequest<Member[]>('user-management'),
      managementRequest<Grant[]>('capability-grants'),
    ]);
    users.value = memberData;
    grants.value = grantData;
  } catch (reason) {
    error.value = displayError(reason);
  } finally {
    loading.value = false;
  }
}

async function authorizeChanges(member: Member, event: Event) {
  const picker = (event.currentTarget as HTMLButtonElement).closest('details');
  const selected = new Set(draftPermissions.value[member.id] ?? grantedCapabilities(member.id));
  const current = new Set(grantedCapabilities(member.id));
  const additions = [...selected].filter((capability) => !current.has(capability));
  const removals = [...current].filter((capability) => !selected.has(capability));
  const previous = [...grants.value];
  rowError.value[member.id] = '';
  if (busyUsers.value[member.id]) return;
  if (!additions.length && !removals.length) {
    rowError.value[member.id] = '尚未选择权限变更';
    return;
  }
  const reason = reasonByUser.value[member.id]?.trim() ?? '';
  if (additions.length && !reason) {
    rowError.value[member.id] = '请填写授权原因';
    return;
  }

  busyUsers.value[member.id] = true;
  try {
    // Apply grants first so an authorization failure never removes existing access.
    for (const capability of additions) {
      await managementRequest<Grant>('capability-grants', {
        user_id: member.id, capability, scope_type: 'ORG', reason,
      });
    }
    for (const capability of removals) {
      const toRevoke = activeOrgGrants(member.id).filter((grant) => grant.capability === capability);
      for (const grant of toRevoke) await managementRequest(`capability-grants/${grant.id}/revoke`, {});
    }
    grants.value = await managementRequest<Grant[]>('capability-grants');
    draftPermissions.value[member.id] = grantedCapabilities(member.id);
    reasonByUser.value[member.id] = '';
    picker?.removeAttribute('open');
  } catch (reason) {
    grants.value = previous;
    rowError.value[member.id] = displayError(reason);
    // Existing APIs persist one capability at a time. Reload after an error so
    // the staged checklist reflects any earlier request accepted by the server.
    try {
      grants.value = await managementRequest<Grant[]>('capability-grants');
      draftPermissions.value[member.id] = grantedCapabilities(member.id);
    } catch { /* retain the locally restored state and the original error */ }
  } finally {
    busyUsers.value[member.id] = false;
  }
}

async function revokeScopedGrant(grant: Grant) {
  if (busyUsers.value[grant.user_id]) return;
  const previous = [...grants.value];
  busyUsers.value[grant.user_id] = true;
  rowError.value[grant.user_id] = '';
  grants.value = grants.value.map((item) => item.id === grant.id ? { ...item, revoked_at: new Date().toISOString() } : item);
  try {
    await managementRequest(`capability-grants/${grant.id}/revoke`, {});
  } catch (reason) {
    grants.value = previous;
    rowError.value[grant.user_id] = displayError(reason);
  } finally {
    busyUsers.value[grant.user_id] = false;
  }
}

const scopedAndHistory = computed(() => grants.value.filter((grant) => grant.scope_type !== 'ORG'
  || !!grant.revoked_at || (grant.valid_to && Date.parse(grant.valid_to) <= Date.now())));
onMounted(load);
</script>

<template>
  <section class="permission-page">
    <header class="page-heading">
      <div>
        <h2>角色权限</h2>
        <p>按组织部门管理成员的额外权限。组织身份与基础角色权限保持不变。</p>
      </div>
      <button class="refresh-button" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
    </header>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>

    <section class="member-panel" aria-label="成员权限管理">
      <div class="panel-heading">
        <h3>成员权限管理</h3>
        <span class="member-total">{{ filteredUsers.length }} 人</span>
      </div>
      <div class="filters">
        <label class="filter-field">
          <span>部门</span>
          <select v-model="departmentFilter" aria-label="按部门筛选">
            <option value="">全部部门</option>
            <option v-for="department in departments" :key="department" :value="department">{{ department }}</option>
          </select>
        </label>
        <label class="filter-field name-filter">
          <span>姓名</span>
          <input v-model="nameFilter" type="search" placeholder="搜索成员姓名" aria-label="按姓名搜索">
        </label>
      </div>

      <div v-if="loading && !users.length" class="empty-state">正在加载成员…</div>
      <div v-else-if="!groups.length" class="empty-state">没有符合条件的成员</div>
      <section v-for="([department, members]) in groups" :key="department" class="department-group">
        <button class="department-heading" :aria-expanded="expanded[department] ?? true" @click="toggleDepartment(department)">
          <span class="department-icon" aria-hidden="true">▤</span>
          <strong>{{ department }}</strong>
          <span class="department-count">{{ members.length }} 人</span>
          <span class="chevron" :class="{ collapsed: expanded[department] === false }" aria-hidden="true">⌄</span>
        </button>

        <div v-if="expanded[department] ?? true" class="member-list">
          <article v-for="member in members" :key="member.id" class="member-row">
            <div class="member-main">
              <div class="member-summary">
                <span class="avatar" aria-hidden="true">{{ member.display_name.slice(0, 1) }}</span>
                <strong>{{ member.display_name }}</strong>
                <span v-if="member.status && member.status !== 'ACTIVE'" class="status-label">{{ member.status }}</span>
              </div>

              <details v-if="!member.status || member.status === 'ACTIVE'" class="permission-picker" @toggle="pickerToggled(member, $event)">
                <summary :aria-label="`选择${member.display_name}的权限`">
                  <span>权限选择</span><span class="picker-chevron" aria-hidden="true">⌄</span>
                </summary>
                <div class="permission-menu">
                  <p class="menu-title">可授权权限</p>
                  <label v-for="option in permissionOptions" :key="option.value" class="permission-option">
                    <input
                      type="checkbox"
                      :checked="(draftPermissions[member.id] ?? grantedCapabilities(member.id)).includes(option.value)"
                      :disabled="busyUsers[member.id]"
                      @change="draftPermission(member, option.value, $event)"
                    >
                    <span>{{ option.label }}</span>
                    <small>{{ hasGrant(member.id, option.value) ? '已授权' : '' }}</small>
                  </label>
                  <p v-if="!permissionOptions.length" class="menu-hint">当前账号没有可授予的权限</p>
                  <label v-if="pendingAdditions(member.id).length" class="reason-field">
                    <span>授权原因</span>
                    <textarea v-model="reasonByUser[member.id]" maxlength="500" rows="3" placeholder="填写本次授权原因，最多500字"></textarea>
                  </label>
                  <p class="menu-hint">勾选新增权限后填写授权原因；取消勾选已授权项可撤销。</p>
                  <div class="menu-actions">
                    <button type="button" class="menu-cancel" :disabled="busyUsers[member.id]" @click="cancelPermissionChanges(member, $event)">取消</button>
                    <button type="button" class="menu-authorize" :disabled="busyUsers[member.id] || !hasDraftChanges(member.id)" @click="authorizeChanges(member, $event)">{{ busyUsers[member.id] ? '提交中…' : '授权' }}</button>
                  </div>
                </div>
              </details>
              <span v-else class="inactive-note">账号不可授权</span>
            </div>

            <div v-if="activeOrgGrants(member.id).length" class="grant-tags" aria-label="当前额外权限">
              <span v-for="grant in activeOrgGrants(member.id)" :key="grant.id" class="grant-tag">
                {{ capabilityLabels[grant.capability] ?? grant.capability }}
              </span>
            </div>
            <p v-else class="no-grants">暂无额外授权</p>
            <p v-if="rowError[member.id]" class="row-error" role="alert">{{ rowError[member.id] }}</p>
          </article>
        </div>
      </section>

      <p class="panel-note">基础角色权限由组织身份决定，不能在此修改。列表只提供当前操作账号已有权限范围内的授权选项。</p>
    </section>

    <section v-if="scopedAndHistory.length" class="history-panel">
      <div class="panel-heading">
        <div><h3>其他范围与历史授权</h3><p>包含部门或周期范围授权，以及已撤销记录。</p></div>
        <span class="member-total">{{ scopedAndHistory.length }} 条</span>
      </div>
      <div class="history-list">
        <article v-for="grant in scopedAndHistory" :key="grant.id" class="history-row">
          <div>
            <strong>{{ grant.display_name }}</strong>
            <span class="history-permission">{{ capabilityLabels[grant.capability] ?? grant.capability }}</span>
          </div>
          <span class="scope-badge">{{ grant.scope_type === 'DEPARTMENT' ? '部门范围' : grant.scope_type === 'CYCLE' ? '周期范围' : '组织范围' }}</span>
          <span class="history-status" :class="{ revoked: grant.revoked_at }">{{ grant.revoked_at ? '已撤销' : '已授予' }}</span>
          <button v-if="!grant.revoked_at" class="text-button" :disabled="busyUsers[grant.user_id]" @click="revokeScopedGrant(grant)">撤销</button>
          <span v-else class="history-date">{{ grant.revoked_at.slice(0, 10) }}</span>
          <p v-if="grant.reason" class="history-reason">原因：{{ grant.reason }}</p>
          <p v-if="rowError[grant.user_id]" class="row-error history-error" role="alert">{{ rowError[grant.user_id] }}</p>
        </article>
      </div>
    </section>
  </section>
</template>

<style scoped>
.permission-page{display:flex;flex-direction:column;gap:18px;color:#183153}
.page-heading,.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}
.page-heading h2,.panel-heading h3{margin:0;color:#17345d;font-weight:700}
.page-heading h2{font-size:22px}.page-heading p,.panel-heading p{margin:6px 0 0;color:#73839b;font-size:13px}
.refresh-button,.text-button{border:1px solid #d6e3f5;border-radius:8px;background:#fff;color:#2767d8;cursor:pointer}
.refresh-button{padding:8px 14px}.refresh-button:disabled,.text-button:disabled{opacity:.55;cursor:wait}
.member-panel,.history-panel{padding:20px 22px;background:#fff;border:1px solid #e1e9f4;border-radius:14px;box-shadow:0 4px 14px #1b4a7a08}
.panel-heading{justify-content:flex-start;margin-bottom:16px}.panel-heading h3{font-size:17px}.member-total{color:#73839b;font-size:13px}
.filters{display:flex;gap:12px;margin:0 0 14px}.filter-field{display:flex;align-items:center;gap:8px;color:#667891;font-size:13px}
.filter-field select,.filter-field input{height:36px;min-width:170px;padding:0 11px;border:1px solid #dce5f1;border-radius:8px;background:#fff;color:#243c5c;outline:none}
.filter-field select:focus,.filter-field input:focus,.reason-field textarea:focus{border-color:#75a5ff;box-shadow:0 0 0 3px #3478f61a}.name-filter input{width:210px}
.department-group+.department-group{margin-top:6px}.department-heading{width:100%;display:flex;align-items:center;gap:9px;padding:13px 4px;border:0;border-bottom:1px solid #e8eef6;background:#fff;text-align:left;color:#233b5b;cursor:pointer}
.department-icon{color:#3478f6;font-size:16px}.department-count{color:#7b8ba2;font-size:13px}.chevron{margin-left:auto;color:#73839b;font-size:19px;transition:transform .15s}.chevron.collapsed{transform:rotate(-90deg)}
.member-row{padding:14px 2px 12px;border-bottom:1px solid #edf1f7}.member-row:last-child{border-bottom:0}.member-main{display:flex;align-items:center;justify-content:space-between;gap:18px}
.member-summary{display:flex;align-items:center;gap:9px;min-width:0}.member-summary strong{color:#1d3556;font-size:14px}.avatar{display:grid;place-items:center;width:32px;height:32px;flex:0 0 32px;border-radius:50%;background:#eff5ff;color:#3478f6;font-size:14px;font-weight:600}.status-label{color:#a46a11;font-size:12px}
.permission-picker{position:relative;flex:0 0 210px}.permission-picker summary{height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border:1px solid #d8e2ef;border-radius:9px;background:#fff;color:#62758f;font-size:13px;cursor:pointer;list-style:none}.permission-picker summary::-webkit-details-marker{display:none}.permission-picker[open] summary{border-color:#8bb4ff;color:#2767d8}.picker-chevron{font-size:18px}
.inactive-note{color:#a0aaba;font-size:12px}
.permission-menu{position:absolute;z-index:5;top:42px;right:0;width:min(440px,calc(100vw - 72px));max-height:min(68vh,620px);overflow:auto;padding:14px;background:#fff;border:1px solid #dfe7f1;border-radius:12px;box-shadow:0 10px 28px #193b641f}
.menu-title{margin:3px 5px 8px;color:#7b8ba2;font-size:12px}.permission-option{display:flex;align-items:center;gap:9px;min-height:36px;padding:6px 8px;border-radius:7px;color:#263d5b;font-size:13px;cursor:pointer}.permission-option:hover{background:#f5f8fc}.permission-option input{width:15px;height:15px;margin:0;accent-color:#3478f6}.permission-option small{margin-left:auto;color:#3875d5;font-size:11px}.permission-option input:disabled{cursor:wait}.reason-field{display:flex;flex-direction:column;gap:6px;margin:10px 5px 5px;padding-top:10px;border-top:1px solid #edf1f7;color:#5c708a;font-size:12px}.reason-field textarea{resize:vertical;min-height:72px;padding:9px;border:1px solid #dce5f1;border-radius:7px;font:inherit;font-size:12px;outline:none}.menu-hint{margin:7px 5px 2px;color:#8795a9;font-size:11px}.menu-actions{position:sticky;bottom:-14px;display:flex;justify-content:flex-end;gap:9px;margin:12px -14px -14px;padding:12px 14px;background:#fff;border-top:1px solid #edf1f7}.menu-actions button{min-width:72px;min-height:34px;padding:6px 14px;border-radius:7px;font:inherit;font-size:13px;cursor:pointer}.menu-actions button:disabled{opacity:.55;cursor:wait}.menu-cancel{border:1px solid #d8e2ef;background:#fff;color:#526780}.menu-authorize{border:1px solid #3478f6;background:#3478f6;color:#fff}
.grant-tags{display:flex;flex-wrap:wrap;gap:6px;margin:9px 0 0 41px}.grant-tag{padding:4px 9px;border-radius:999px;background:#eaf3ff;color:#3475d5;font-size:12px;line-height:1.2}.no-grants{margin:8px 0 0 41px;color:#929fb0;font-size:12px}.row-error,.page-error{margin:8px 0 0;color:#c33d48;font-size:12px}.page-error{padding:10px 12px;border:1px solid #f3c9cd;border-radius:8px;background:#fff6f6;font-size:13px}
.panel-note{margin:14px 0 0;color:#7c8ba0;font-size:12px;line-height:1.6}.history-panel .panel-heading{justify-content:space-between}.history-list{border-top:1px solid #edf1f7}.history-row{display:grid;grid-template-columns:minmax(180px,1fr) auto auto auto;align-items:center;gap:12px;padding:12px 2px;border-bottom:1px solid #edf1f7;font-size:13px}.history-row>div{display:flex;align-items:center;gap:10px}.history-permission{color:#5e718a}.scope-badge{padding:3px 8px;border-radius:999px;background:#f2f6fb;color:#687b95;font-size:11px}.history-status{color:#287c54;font-size:12px}.history-status.revoked{color:#8995a5}.text-button{padding:5px 10px}.history-date{color:#8995a5;font-size:12px}.history-reason,.history-error{grid-column:1/-1;margin:0;color:#7b8ba2;font-size:12px}.empty-state{padding:34px 12px;color:#8996a8;text-align:center;font-size:13px}
@media(max-width:700px){.member-panel,.history-panel{padding:16px}.filters{align-items:stretch;flex-direction:column}.filter-field{justify-content:space-between}.filter-field select,.filter-field input,.name-filter input{width:68%;min-width:0}.permission-picker{flex-basis:150px}.history-row{grid-template-columns:1fr auto}.history-row .text-button,.history-date{justify-self:end}}
</style>
