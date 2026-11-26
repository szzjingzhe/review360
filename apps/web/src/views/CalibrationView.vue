<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuth } from '../stores/auth';
import { mockApi, userName } from '../api';

const auth = useAuth();
const cases = ref<any[]>([]);
const cycleId = ref('');
const cycles = ref<any[]>([]);
const filter = ref<'ALL' | 'OPEN' | 'RESOLVED'>('ALL');
const current = ref<any>(null);
const action = ref('CONFIRM');
const reason = ref('');
const err = ref('');

onMounted(async () => {
  cycles.value = await mockApi.listCycles();
  cycleId.value = cycles.value.find((c) => c.status === 'CALIBRATING')?.id ?? cycles.value[0]?.id ?? '';
  await load();
});
async function load() {
  try { cases.value = await mockApi.listCalibrationCases(cycleId.value);err.value=''; }
  catch(e:any){cases.value=[];err.value=e.message||'核验数据加载失败';}
}
async function openCase(c: any) {
  current.value = c;
  action.value = 'CONFIRM';
  reason.value = '';
  err.value = '';
}
async function submit() {
  if (!current.value) return;
  try {
    const updated = await mockApi.takeCalibrationAction(current.value.id, action.value, reason.value, auth.user!.id);
    const idx = cases.value.findIndex((c) => c.id === updated.id);
    if (idx >= 0) cases.value[idx] = updated;
    current.value = updated;
    err.value = '';
  } catch (e: any) {
    err.value = e.message || '操作失败';
  }
}
const shown = computed(() => cases.value.filter((c) => filter.value === 'ALL' || c.status === filter.value));
</script>

<template>
  <div>
    <h1 class="page-title">核验</h1>
    <p class="page-sub">监管人员对触发阈值的评价进行人工核验与处置（本人/作者自动排除）。</p>

    <div class="row" style="margin-bottom:14px">
      <button class="btn btn-sm" :class="{ 'btn-primary': filter === 'ALL' }" @click="filter = 'ALL'">全部</button>
      <button class="btn btn-sm" :class="{ 'btn-primary': filter === 'OPEN' }" @click="filter = 'OPEN'">待处理</button>
      <button class="btn btn-sm" :class="{ 'btn-primary': filter === 'RESOLVED' }" @click="filter = 'RESOLVED'">已处置</button>
    </div>

    <div class="grid grid-2">
      <div>
        <div v-for="c in shown" :key="c.id" class="card" style="cursor:pointer" :class="{ 'nav-active': current?.id === c.id }" @click="openCase(c)">
          <div class="row" style="justify-content:space-between">
            <span class="chip chip-amber">{{ c.trigger }}</span>
            <span class="chip" :class="c.status === 'OPEN' ? 'chip-red' : 'chip-green'">{{ c.status }}</span>
          </div>
          <div style="margin-top:6px"><b>{{ userName(c.targetId) }}</b> <span class="tag">· 评分者 {{ userName(c.reviewerId) }}</span></div>
          <div class="muted" style="margin-top:4px;font-size:12px">{{ c.reason }}</div>
          <div class="tag" style="margin-top:4px" v-if="c.resolvedBy">已由 {{ c.resolvedBy }} 处置：{{ c.resolvedAction }}</div>
        </div>
      </div>

      <div v-if="current">
        <div class="card">
          <h3>核验处置</h3>
          <div class="tag">触发：<b>{{ current.trigger }}</b></div>
          <div style="margin-top:8px">被评价人：<b>{{ userName(current.targetId) }}</b></div>
          <div class="muted" style="margin-top:4px">{{ current.reason }}</div>
          <div class="tag" style="margin-top:6px">他评份数：{{ current.peerCount ?? '—' }} · 总分：{{ current.totalScore }}</div>

          <div class="field" style="margin-top:14px">
            <label>处置动作</label>
            <select v-model="action" :disabled="current.status !== 'OPEN'">
              <option value="CONFIRM">CONFIRM（确认有效，维持）</option>
              <option value="REQUEST_SUPPLEMENT">退回补充</option>
              <option value="SUGGEST_REVISION">要求原评价人更正</option>
              <option value="VOID_REQUEST">提交作废申请</option>
              <option value="VOID_APPROVE">独立复核批准作废</option>
              <option value="VOID_REJECT">驳回作废申请</option>
              <option value="DISMISS">关闭核验项</option>
            </select>
          </div>
          <div class="field">
            <label>处置理由</label>
            <textarea v-model="reason" rows="2" :disabled="current.status !== 'OPEN'"></textarea>
          </div>
          <button class="btn btn-primary" :disabled="current.status !== 'OPEN' || !reason.trim()" @click="submit">提交处置</button>
          <span class="muted" style="color:var(--lark-danger)">{{ err }}</span>
          <div class="muted" style="margin-top:8px;font-size:12px">提示：以"被评价人本人"或"原评分作者"身份处置会被 SELF_CONFLICT / AUTHOR_CONFLICT 拦截（可在右上角切换身份体验）。</div>
        </div>
      </div>
      <div v-else class="empty">选择左侧核验项查看详情</div>
    </div>
  </div>
</template>
