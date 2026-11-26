<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { mockApi } from '../api';
import { useAuth } from '../stores/auth';
import type { FeedbackContext, FeedbackFilter, FeedbackRecord } from '../contracts/feedback';
import { feedbackError, feedbackState, filterFeedback } from '../lib/feedback';
import FeedbackOverview from '../components/feedback/FeedbackOverview.vue';
import FeedbackList from '../components/feedback/FeedbackList.vue';
import FeedbackDetail from '../components/feedback/FeedbackDetail.vue';

const auth = useAuth();
const route = useRoute();
const canManage = computed(() => auth.hasCapability('feedback.manage'));
const cycles = ref<Awaited<ReturnType<typeof mockApi.listCycles>>>([]), records = ref<FeedbackRecord[]>([]);
const cycle = ref(''), query = ref(''), state = ref<FeedbackFilter>('all'), stage = ref('all'), sort = ref('desc'), page = ref(1);
const selectedId = ref(''), loading = ref(true), loadError = ref(''), detailLoading = ref(false), detailError = ref('');
const context = ref<FeedbackContext | null>(null), submitting = ref(false), actionError = ref(''), success = ref('');
const notes = ref<Record<string, string>>({});
let listSequence = 0, detailSequence = 0;
const periodRecords = computed(() => records.value.filter(record => !cycle.value || record.cycleId === cycle.value));
const counts = computed(() => ({ all: periodRecords.value.length,
  pending: periodRecords.value.filter(record => feedbackState(record.status) === 'pending').length,
  rereview: periodRecords.value.filter(record => feedbackState(record.status) === 'rereview').length,
  closed: periodRecords.value.filter(record => feedbackState(record.status) === 'closed').length }));
const filtered = computed(() => filterFeedback(records.value, { cycle: cycle.value, query: query.value, state: state.value, stage: stage.value, sort: sort.value }));
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 6)));
const pageRecords = computed(() => filtered.value.slice((page.value - 1) * 6, page.value * 6));
const selected = computed(() => pageRecords.value.find(record => record.id === selectedId.value) ?? null);
const note = computed({ get: () => selected.value ? notes.value[selected.value.id] ?? '' : '', set: value => { if (selected.value) notes.value[selected.value.id] = value; } });

watch([cycle, query, state, stage, sort], () => { page.value = 1; }, { flush: 'sync' });
watch(pageCount, count => { if (page.value > count) page.value = count; });
watch(pageRecords, rows => { if (!rows.some(row => row.id === selectedId.value)) selectedId.value = rows[0]?.id ?? ''; });
watch(selected, () => { void loadContext(); });
async function loadContext() {
  const record = selected.value, sequence = ++detailSequence;
  context.value = null; detailError.value = ''; detailLoading.value = !!record;
  if (!record) return;
  try { const result = await mockApi.getFeedbackContext(record.id); if (sequence === detailSequence) context.value = result; }
  catch (error) { if (sequence === detailSequence) detailError.value = feedbackError(error); }
  finally { if (sequence === detailSequence) detailLoading.value = false; }
}
async function load() {
  const sequence = ++listSequence;
  loading.value = true; loadError.value = '';
  try {
    if (!canManage.value) throw Object.assign(new Error('没有申诉管理权限'), { status: 403 });
    const [periods, items] = await Promise.all([mockApi.listCycles(), mockApi.listFeedbackManagement()]);
    if (sequence !== listSequence) return;
    cycles.value = periods;
    if (!cycle.value) cycle.value = periods.find(p=>p.id===route.query.cycleId)?.id ?? periods.find(period => items.some(item => item.cycleId === period.id))?.id ?? periods[0]?.id ?? '';
    records.value = items;
  } catch (error) { if (sequence === listSequence) { loadError.value = feedbackError(error); records.value = []; } }
  finally { if (sequence === listSequence) loading.value = false; }
}
async function submit(decision: 'APPROVED' | 'REJECTED', opinion: string) {
  const record = selected.value;
  if (!record || submitting.value || !canManage.value || !['PENDING', 'REREVIEW_PENDING'].includes(record.status)) return;
  if (!opinion.trim()) { actionError.value = '请填写处理意见。'; return; }
  submitting.value = true; actionError.value = ''; success.value = '';
  try {
    if (record.status === 'REREVIEW_PENDING') await mockApi.resolveRereview(record.id, decision, opinion);
    else await mockApi.resolveFeedback(record.id, decision, opinion);
    delete notes.value[record.id];
    success.value = '处理结论已提交，申请人可在个人端查看处理结果及意见。';
    await load();
  } catch (error) {
    actionError.value = feedbackError(error);
    if ((error as { status?: number }).status === 409) await load();
  } finally { submitting.value = false; }
}
onMounted(load);
onBeforeUnmount(() => { listSequence++; detailSequence++; });
</script>
<template>
  <div class="feedback-management">
    <header class="fm-heading"><div><h1>反馈申诉处理</h1><p>统一受理成员申诉，核实评价事实并记录处理结论。</p></div>
      <div class="fm-period"><i class="fa-regular fa-calendar-days" aria-hidden="true"></i><select v-model="cycle" aria-label="评价周期" :disabled="loading || submitting">
        <option v-for="period in cycles" :key="period.id" :value="period.id">{{ period.month }} · {{ period.title }}</option>
        <option v-if="!cycles.length" value="">{{ loading ? '正在加载评价周期…' : '暂无可选评价周期' }}</option>
      </select></div>
    </header>
    <FeedbackOverview :counts="counts" :selected="state" :loading="loading" :unavailable="!!loadError" :busy="submitting" @select="state = $event" />
    <div v-if="success" class="fm-alert success" role="status"><i class="fa-regular fa-circle-check" aria-hidden="true"></i>{{ success }}</div>
    <div v-if="actionError" class="fm-alert danger" role="alert">{{ actionError }}</div>
    <div class="fm-columns">
      <FeedbackList v-model:query="query" v-model:state="state" v-model:stage="stage" v-model:sort="sort" v-model:page="page"
        :records="pageRecords" :selected-id="selectedId" :total="filtered.length" :page-count="pageCount" :loading="loading" :error="loadError" :busy="submitting"
        @select="selectedId = $event; actionError = ''; success = ''" @retry="load" />
      <FeedbackDetail v-model:note="note" :record="selected" :context="context" :loading="detailLoading" :error="detailError" :busy="submitting" :can-manage="canManage"
        @retry="loadContext" @submit="submit" />
    </div>
  </div>
</template>
<style src="../styles/feedback-management.css"></style>
