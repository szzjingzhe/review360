<script setup lang="ts">
import { decodeAppeal } from '../../lib/memberFeedback';
import { computed, ref, watch } from 'vue';
import type { FeedbackContext, FeedbackRecord } from '../../contracts/feedback';
import { feedbackStage, feedbackState, feedbackStatus, feedbackTime, feedbackTitle } from '../../lib/feedback';
import FeedbackReviewForm from './FeedbackReviewForm.vue';
const props = defineProps<{ record: FeedbackRecord | null; context: FeedbackContext | null; loading: boolean;
  error: string; busy: boolean; canManage: boolean; note: string }>();
const emit = defineEmits<{ retry: []; 'update:note': [value: string]; submit: [decision: 'APPROVED' | 'REJECTED', note: string] }>();
const copyMessage = ref('');
watch(() => props.record?.id, () => { copyMessage.value = ''; });
const actionable = computed(() => props.record && ['PENDING', 'REREVIEW_PENDING'].includes(props.record.status));
const formatScore = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
async function copyId() {
  if (!props.record) return;
  try { await navigator.clipboard.writeText(props.record.id); copyMessage.value = '编号已复制'; }
  catch { copyMessage.value = '未能复制，请选中下方完整编号复制。'; }
}
function handlingDecision(stage: string, decision: string | null) {
  if (decision === 'APPROVED') return stage === 'FIRST' ? '说明并办结' : '支持二次申诉';
  if (decision === 'REJECTED') return stage === 'FIRST' ? '驳回申诉' : '维持原结论';
  return '结论未记录';
}
</script>
<template>
  <section class="fm-detail fm-panel" aria-labelledby="fm-detail-title">
    <div v-if="!record" class="fm-detail-empty"><i class="fa-regular fa-file-lines" aria-hidden="true"></i><h2 id="fm-detail-title">申诉详情</h2><p>从左侧选择一条申诉，查看内容和处理记录。</p></div>
    <template v-else>
      <header class="fm-detail-header"><div><div class="fm-detail-title"><h2 id="fm-detail-title">{{ feedbackTitle(record) }}</h2><span class="fm-status" :class="feedbackState(record.status)">{{ feedbackStatus(record.status) }}</span></div>
        <p class="fm-detail-number">编号：<span>{{ record.id }}</span><br>提交时间：{{ feedbackTime(record.createdAt) }}</p></div>
        <button class="fm-button compact" type="button" @click="copyId"><i class="fa-regular fa-copy" aria-hidden="true"></i>复制编号</button>
      </header>
      <p v-if="copyMessage" class="fm-copy-message" role="status">{{ copyMessage }}</p>
      <section class="fm-basic" aria-labelledby="fm-basic-title"><h3 id="fm-basic-title">基本信息</h3><dl>
        <dt>申请人</dt><dd>{{ record.applicantName || '姓名未记录' }} <span class="fm-muted">{{ record.departmentName ? `（${record.departmentName}）` : '（无部门归属记录）' }}</span></dd>
        <dt>关联周期</dt><dd>{{ record.cycleMonth }} · {{ record.cycleTitle }}</dd>
        <dt>评价窗口</dt><dd>{{ record.cycleOpenAt && record.cycleCloseAt ? `${feedbackTime(record.cycleOpenAt)} — ${feedbackTime(record.cycleCloseAt)}` : '历史周期未记录完整起止时间' }}</dd>
        <dt>申诉阶段</dt><dd>{{ feedbackStage(record) }}</dd><dt>申诉类型</dt><dd>{{ decodeAppeal(record.reason).type }}</dd>
        <dt>涉及评价范围</dt><dd>{{ decodeAppeal(record.reason).scope }}</dd>
        <dt>当前状态</dt><dd>{{ feedbackStatus(record.status) }}</dd>
      </dl></section>
      <section class="fm-detail-section"><h3>申诉内容</h3><div class="fm-prose">{{ decodeAppeal(record.reason).reason }}</div>
        <template v-if="record.rereviewReason"><h4>二次申诉理由 <span class="fm-muted">{{ feedbackTime(record.rereviewOpenedAt) }}</span></h4><div class="fm-prose">{{ record.rereviewReason }}</div><p class="fm-help">本次复核与上述原申诉使用同一记录，保留首次处理结论。</p></template>
      </section>
      <section class="fm-detail-section" aria-labelledby="fm-results-title"><div class="fm-section-heading"><h3 id="fm-results-title">相关评价结果</h3><span class="fm-muted">自评独立展示 · 他评匿名汇总</span></div>
        <div v-if="loading" class="fm-inline-state" role="status"><span class="fm-spinner"></span>正在读取关联发布结果…</div>
        <div v-else-if="error" class="fm-inline-state"><p class="fm-error" role="alert">{{ error }}</p><button class="fm-button" @click="$emit('retry')">重新加载</button></div>
        <template v-else-if="context?.result">
          <p v-if="context.result.simulationNotice" class="fm-simulation">{{ context.result.simulationNotice }}</p>
          <div class="fm-table-wrap"><table class="fm-result-table"><thead><tr><th>评价维度</th><th>本人自评</th><th>匿名他评均分</th><th>权重</th></tr></thead><tbody>
            <tr v-for="dimension in context.result.dimensions" :key="dimension.key"><td>{{ dimension.label }}</td><td>{{ formatScore(dimension.selfScore) }}</td><td>{{ formatScore(dimension.peerScore) }}</td><td>{{ dimension.weight == null ? '—' : `${dimension.weight}%` }}</td></tr>
            <tr v-if="!context.result.dimensions.length"><td colspan="4" class="fm-muted">该历史快照缺少可核对的正式指标数据。</td></tr>
          </tbody></table></div>
          <p class="fm-help">关联发布版本 v{{ context.result.publicationVersion }} · {{ context.result.notice }}</p>
        </template>
        <p v-else class="fm-unavailable">{{ context?.resultUnavailableReason || '未取得可展示的关联评价数据。' }}</p>
      </section>
      <section v-if="record.handlingRecords.length" class="fm-detail-section"><h3>已有处理记录</h3>
        <div v-for="(handling, index) in record.handlingRecords" :key="index" class="fm-handling-record">
          <div class="fm-handling-heading"><strong>{{ handling.stage === 'FIRST' ? '首次处理' : '二次复核' }}</strong><span>{{ handlingDecision(handling.stage, handling.decision) }}</span></div>
          <p>{{ handling.note || '历史记录未填写处理意见。' }}</p><small>{{ handling.handlerName || '处理人姓名未记录' }} · {{ feedbackTime(handling.handledAt) }}</small>
        </div>
      </section>
      <FeedbackReviewForm v-if="actionable && canManage" :key="record.id + record.status" :record="record" :model-value="note" :busy="busy"
        @update:model-value="emit('update:note', $event)" @submit="(decision, value) => emit('submit', decision, value)" />
      <div v-else class="fm-readonly"><i class="fa-solid fa-lock" aria-hidden="true"></i><span>{{ !canManage ? '当前账号没有申诉处理权限。' : feedbackState(record.status) === 'closed' ? '此申诉已办结，当前为只读状态。' : '当前状态未提供可执行的处理操作。' }}<template v-if="!record.handlingRecords.length && feedbackState(record.status) === 'closed'"> 历史处理时间和意见未记录。</template></span></div>
    </template>
  </section>
</template>
