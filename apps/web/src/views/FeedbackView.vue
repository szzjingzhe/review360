<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useAuth } from '../stores/auth';
import { mockApi } from '../api';
import { feedbackError } from '../lib/feedback';

const auth = useAuth();
const route = useRoute();
const canManage = computed(() => auth.hasCapability('feedback.manage'));
const managementView = computed(() => route.path === '/feedback/manage');

const mine = ref<any[]>([]);
const all = ref<any[]>([]);
const form = ref({ cycleId: '', reason: '' });
const cycles = ref<any[]>([]);
const ok = ref('');
const err = ref('');

const resolveNote = ref<Record<string, string>>({});
const rereviewReason = ref<Record<string, string>>({});

onMounted(load);
async function load() {
  cycles.value = await mockApi.listCycles();
  if (auth.user && !managementView.value) mine.value = await mockApi.listFeedback(auth.user.id);
  if (!form.value.cycleId) form.value.cycleId = cycles.value[0]?.id ?? '';
  if (canManage.value) all.value = await mockApi.listAllFeedback();
}
async function submit() {
  err.value = ''; ok.value = '';
  if (!auth.user) return;
  try {
    await mockApi.requestFeedback({ cycleId: form.value.cycleId, targetId: auth.user.id, reason: form.value.reason });
    await load();
    ok.value = '反馈申请已提交，可在下方查看处理进度';
    form.value.reason = '';
  } catch (e: any) {
    err.value = '提交失败：' + (e?.message ?? e);
  }
}
async function resolve(f: any, decision: 'APPROVED' | 'REJECTED') {
  const note = resolveNote.value[f.id]?.trim();
  if (!note) { err.value = '请填写处理意见。'; return; }
  try { await mockApi.resolveFeedback(f.id, decision, note); await load(); }
  catch (error) { err.value = feedbackError(error); }
}
async function openRereview(f: any) {
  err.value = ''; ok.value = '';
  const reason = rereviewReason.value[f.id]?.trim();
  if (!reason) { err.value = '请填写二次申诉理由'; return; }
  try {
    await mockApi.openRereview(f.id, reason);
    await load();
    ok.value = '二次申诉已发起，可在下方查看复核进度';
    rereviewReason.value[f.id] = '';
  } catch (e: any) {
    err.value = '发起失败：' + (e?.message ?? e);
  }
}
async function resolveRereview(f: any, decision: 'APPROVED' | 'REJECTED') {
  const note = resolveNote.value[f.id]?.trim();
  if (!note) { err.value = '请填写复核意见。'; return; }
  try { await mockApi.resolveRereview(f.id, decision, note); await load(); }
  catch (error) { err.value = feedbackError(error); }
}
function statusChip(s: string) {
  if (s === 'PENDING') return 'chip-amber';
  if (s === 'REREVIEW_PENDING') return 'chip-amber';
  if (s === 'REREVIEW_DONE') return 'chip-green';
  if (s === 'REREVIEW_REJECTED') return 'chip-gray';
  if (s === 'DONE') return 'chip-green';
  return 'chip-gray';
}
function statusText(s: string) {
  switch (s) {
    case 'PENDING': return '待处理';
    case 'DONE': return '已闭环';
    case 'REJECTED': return '已驳回';
    case 'REREVIEW_PENDING': return '二审待处理';
    case 'REREVIEW_DONE': return '二次申诉成立';
    case 'REREVIEW_REJECTED': return '二次申诉驳回';
    default: return s;
  }
}
function canRereview(s: string) {
  return s === 'DONE' || s === 'REJECTED';
}
</script>

<template>
  <div class="personal-standard feedback-workspace">
    <h1 class="page-title">{{ managementView ? '反馈申诉处理' : '反馈申诉' }}</h1>
    <p class="page-sub">{{ managementView ? '查看并处理成员提交的反馈申请；处理结果会同步到申请人的个人端。' : '对结果有异议时，可在发布后 3 个工作日内向组织发起反馈申请；处理人审批后闭环。窗口外申请将被拒绝。' }}</p>

    <div v-if="!managementView" class="card">
      <h3>发起反馈申请</h3>
      <div class="grid grid-2">
        <div class="field"><label>关联周期</label>
          <select v-model="form.cycleId"><option v-for="cycle in cycles" :key="cycle.id" :value="cycle.id">{{ cycle.title }}（{{ cycle.month }} · {{ cycle.status }}）</option></select>
        </div>
        <div class="field"><label>反馈理由</label><input v-model="form.reason" placeholder="例如：希望了解某维度评分依据" /></div>
      </div>
      <button class="btn btn-primary" @click="submit">提交申请</button>
      <span class="muted" v-if="ok">{{ ok }}</span>
      <span class="err" v-if="err">{{ err }}</span>
    </div>

    <div v-if="!managementView" class="card">
      <h3>我的反馈记录</h3>
      <div v-if="mine.length === 0" class="empty">暂无反馈记录</div>
      <div v-for="f in mine" :key="f.id" style="margin-bottom:10px">
        <div class="row" style="justify-content:space-between">
          <span>{{ f.reason }}</span>
          <span class="chip" :class="statusChip(f.status)">{{ statusText(f.status) }}</span>
        </div>
        <div class="tag">周期 {{ f.cycleId }} · 提交于 {{ new Date(f.createdAt).toLocaleString() }}<template v-if="f.handlerNote"> · 处理说明：{{ f.handlerNote }}</template></div>
        <div v-if="f.status === 'REREVIEW_PENDING'" class="tag">二次申诉理由：{{ f.rereviewReason }}</div>
        <div v-if="canRereview(f.status)" class="row" style="margin-top:8px">
          <input v-model="rereviewReason[f.id]" class="input input-sm" placeholder="二次申诉理由" />
          <button class="btn btn-sm btn-primary" @click="openRereview(f)">发起二次申诉</button>
        </div>
      </div>
    </div>

    <div class="card" v-if="canManage">
      <h3>反馈处理台（feedback.manage）</h3>
      <div v-if="all.length === 0" class="empty">暂无反馈申请</div>
      <div v-for="f in all" :key="f.id" style="margin-bottom:14px; padding-bottom:10px; border-bottom:1px dashed #eee">
        <div class="row" style="justify-content:space-between">
          <span><b>{{ f.reason }}</b></span>
          <span class="chip" :class="statusChip(f.status)">{{ statusText(f.status) }}</span>
        </div>
        <div class="tag">申请人 {{ f.targetId }} · 周期 {{ f.cycleId }} · {{ new Date(f.createdAt).toLocaleString() }}</div>
        <div v-if="f.status === 'REREVIEW_PENDING'" class="tag">二次申诉理由：{{ f.rereviewReason }}</div>
        <div v-if="f.status === 'PENDING'" class="row" style="margin-top:8px">
          <input v-model="resolveNote[f.id]" class="input input-sm" placeholder="处理意见（必填）" />
          <button class="btn btn-sm btn-primary" @click="resolve(f, 'APPROVED')">通过并闭环</button>
          <button class="btn btn-sm" @click="resolve(f, 'REJECTED')">驳回</button>
        </div>
        <div v-else-if="f.status === 'REREVIEW_PENDING'" class="row" style="margin-top:8px">
          <input v-model="resolveNote[f.id]" class="input input-sm" placeholder="复核意见（必填）" />
          <button class="btn btn-sm btn-primary" @click="resolveRereview(f, 'APPROVED')">二次申诉成立</button>
          <button class="btn btn-sm" @click="resolveRereview(f, 'REJECTED')">维持原结论</button>
        </div>
        <div v-else-if="f.handlerNote" class="tag">处理说明：{{ f.handlerNote }}</div>
      </div>
    </div>
    <p v-if="!canManage" class="page-sub" style="margin-top:12px">当前身份无 <code>feedback.manage</code>，无法查看处理台；请切换为具备该能力的处理人（演示：示例成员01 / 赵敏）后重试。</p>
  </div>
</template>
