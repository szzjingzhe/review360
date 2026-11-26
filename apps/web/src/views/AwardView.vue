<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { mockApi } from '../api';
import { useAuth } from '../stores/auth';

const auth = useAuth();
const canManage = computed(() => auth.hasCapability('award.manage'));

const cycleId = ref('');
const cycles = ref<Awaited<ReturnType<typeof mockApi.listCycles>>>([]);
const candidates = ref<any[]>([]);
const decisions = ref<any[]>([]);

async function load() {
  candidates.value = await mockApi.listAwardCandidates(cycleId.value || undefined);
  decisions.value = cycleId.value ? await mockApi.listAwardDecisions(cycleId.value) : [];
}
onMounted(async () => { cycles.value = await mockApi.listCycles(); await load(); });

function decisionOf(userId: string): any {
  return decisions.value.find((d) => d.targetId === userId && d.category === '优秀员工');
}
function statusLabel(d: string) {
  return d === 'AWARDED' ? '评优' : d === 'NOMINATED' ? '提名' : d === 'NONE' ? '不参评' : '未评定';
}

// 行内评定表单
const editing = ref<string | null>(null);
const form = ref({ decision: 'AWARDED', reason: '' });
const saving = ref(false);
const msg = ref('');

function startEdit(c: any) {
  const cur = decisionOf(c.userId);
  form.value = { decision: cur?.decision ?? 'AWARDED', reason: cur?.reason ?? '' };
  editing.value = c.userId;
  msg.value = '';
}
async function saveDecision(c: any) {
  saving.value = true;
  msg.value = '';
  try {
    await mockApi.saveAwardDecision({ cycleId: c.cycleId, targetId: c.userId, category: '优秀员工', decision: form.value.decision as any, reason: form.value.reason });
    await load();
    editing.value = null;
    msg.value = `已保存「${c.displayName}」的评定：${statusLabel(form.value.decision)}`;
  } catch (e: any) {
    msg.value = '保存失败：' + (e?.message ?? e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <h1 class="page-title">评优候选</h1>
    <p class="page-sub">基于已发布、完整同角色结果自动汇集的高分人员（仅管理角色可见）。系统不自动授奖，由管理角色人工提名 / 评定。</p>
    <div class="row" style="margin-bottom:12px">
      <button class="btn btn-sm" :class="{ 'btn-primary': !cycleId }" @click="cycleId=''; load()">全部周期</button>
      <button v-for="cycle in cycles" :key="cycle.id" class="btn btn-sm" :class="{ 'btn-primary': cycleId===cycle.id }" @click="cycleId=cycle.id; load()">{{ cycle.title }}（{{ cycle.month }}）</button>
    </div>
    <div v-if="msg" class="alert alert-ok">{{ msg }}</div>
    <div v-if="candidates.length === 0" class="empty">暂无评优候选</div>
    <table v-else class="table card" style="padding:0">
      <thead><tr><th>姓名</th><th>部门</th><th>周期</th><th>最终分</th><th>等级</th><th>当前评定</th><th v-if="canManage">操作</th></tr></thead>
      <tbody>
        <tr v-for="c in candidates" :key="`${c.cycleId}:${c.userId}`">
          <td><b>{{ c.displayName }}</b></td>
          <td>{{ c.deptName }}</td>
          <td>{{ c.month }}</td>
          <td class="score">{{ c.finalScore }}</td>
          <td><span class="chip" :class="c.level==='优秀'?'chip-green':'chip-amber'">{{ c.level }}</span></td>
          <td>
            <span v-if="decisionOf(c.userId)" class="chip" :class="decisionOf(c.userId).decision==='AWARDED'?'chip-green':decisionOf(c.userId).decision==='NOMINATED'?'chip-blue':'chip-gray'">
              {{ statusLabel(decisionOf(c.userId).decision) }}
            </span>
            <span v-else class="chip chip-gray">未评定</span>
          </td>
          <td v-if="canManage">
            <button v-if="editing !== c.userId" class="btn btn-sm btn-outline" @click="startEdit(c)">评定</button>
            <div v-else style="min-width:240px">
              <div class="row">
                <select v-model="form.decision" class="input input-sm">
                  <option value="AWARDED">评优</option>
                  <option value="NOMINATED">提名</option>
                  <option value="NONE">不参评</option>
                </select>
                <button class="btn btn-sm btn-primary" :disabled="saving" @click="saveDecision(c)">保存</button>
                <button class="btn btn-sm" @click="editing=null">取消</button>
              </div>
              <input v-model="form.reason" class="input input-sm" style="margin-top:6px" placeholder="评定理由（评优/提名必填）" />
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!canManage" class="page-sub" style="margin-top:12px">当前身份无 <code>award.manage</code>，仅可查看候选名单；切换为管理角色（如示例成员18）可进行评定。</p>
  </div>
</template>
