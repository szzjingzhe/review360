<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mockApi } from '../api';
import { publishedHistory } from '../lib/publishedHistory';

const cycles = ref<any[]>([]);
const selectedId = ref('');
const scores = ref<any[]>([]);
const loading = ref(true);
const detailLoading = ref(false);
const error = ref('');
const publications=ref<any[]>([]);
const archived = computed(() => publishedHistory(cycles.value,publications.value));
const selected = computed(() => archived.value.find(c => c.id === selectedId.value));
async function loadDetail(id: string) {
  selectedId.value = id; detailLoading.value = true; error.value = '';
  try { scores.value = publications.value.filter(r=>r.cycle_id===id); }
  catch (e: any) { error.value = e?.message ?? '历史评分加载失败'; scores.value = []; }
  finally { detailLoading.value = false; }
}
onMounted(async () => {
  try { [cycles.value,publications.value] = await Promise.all([mockApi.listCycles(),mockApi.listPublishedResults()]); if (archived.value[0]) await loadDetail(archived.value[0].id); }
  catch (e: any) { error.value = e?.message ?? '任务归档加载失败'; }
  finally { loading.value = false; }
});
function scoreOf(row: any) { const v = row.final_score; return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(2); }
</script>

<template>
  <div>
    <div class="page-head"><div><p class="eyebrow">ARCHIVED TASKS</p><h1 class="page-title">任务归档</h1><p class="page-sub">查看授权范围内已正式发布的最终成绩及历史周期。</p></div></div>
    <div v-if="error" class="notice notice-warning">{{ error }}</div>
    <div v-if="loading" class="card empty">正在加载历史任务…</div>
    <div v-else-if="!archived.length" class="card empty">暂无已归档的历史环评任务。</div>
    <div v-else class="archive-layout">
      <section class="card archive-list"><div class="card-title"><h2>历史环评月份</h2><span>{{ archived.length }} 个周期</span></div>
        <button v-for="c in archived" :key="c.id" class="archive-item" :class="{active:c.id===selectedId}" @click="loadDetail(c.id)"><span><b>{{ c.month }} 环评</b><small>{{ c.title || '月度评价任务' }}</small></span><em>{{ c.status === 'PUBLISHED' ? '已发布' : c.status === 'ARCHIVED' ? '已归档' : '部分发布' }}</em><strong>›</strong></button>
      </section>
      <section class="card archive-detail"><div class="card-title"><div><h2>{{ selected?.month }} 环评详情</h2><span>{{ selected?.title || '历史评价任务' }} · 数据只读</span></div><span class="chip chip-green">{{ selected?.status === 'ARCHIVED' ? '已归档' : '已发布结果' }}</span></div>
        <div class="summary"><div><small>参评人数</small><b>{{ selected?.participantCount ?? '—' }}</b></div><div><small>评价状态</small><b>{{ selected?.status === 'ARCHIVED' ? '已归档' : selected?.status === 'PUBLISHED' ? '已发布' : '部分发布' }}</b></div><div><small>评价时间</small><b>{{ selected?.openAt ? new Date(selected.openAt).toLocaleDateString() : '—' }}</b></div></div>
        <div v-if="detailLoading" class="empty">正在加载评分数据…</div><div v-else-if="!scores.length" class="empty">该周期暂无可展示的评分数据。</div>
        <table v-else><thead><tr><th>被评价成员</th><th>最终综合成绩</th><th>数据状态</th></tr></thead><tbody><tr v-for="(row,i) in scores" :key="row.id || i"><td>{{ row.target_name || '—' }}</td><td class="score">{{ scoreOf(row) }}</td><td><span class="chip chip-green">已完成</span></td></tr></tbody></table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.eyebrow{margin:0 0 4px;color:var(--lark-primary);font:12px/18px 'Times New Roman',serif;letter-spacing:.12em}.archive-layout{display:grid;grid-template-columns:320px 1fr;gap:18px}.card{background:#fff;border:1px solid var(--lark-border-light);border-radius:10px}.archive-list{padding:18px}.archive-detail{padding:20px}.card-title{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--lark-border-light);padding-bottom:15px;margin-bottom:6px}.card-title h2{margin:0;font-size:17px}.card-title span{color:var(--lark-text-3);font-size:12px}.archive-item{width:100%;display:flex;align-items:center;gap:10px;text-align:left;padding:13px 6px;border:0;border-bottom:1px solid var(--lark-border-light);background:none;cursor:pointer;color:inherit}.archive-item span{flex:1}.archive-item b,.archive-item small{display:block}.archive-item small{margin-top:4px;color:var(--lark-text-3);font-size:12px}.archive-item em{font-style:normal;color:#86909c;font-size:12px}.archive-item strong{font-size:20px;color:#86909c}.archive-item.active{color:var(--lark-primary);background:var(--lark-primary-bg);border-radius:7px}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}.summary div{padding:14px;background:#f7f8fa;border-radius:8px}.summary small,.summary b{display:block}.summary small{color:var(--lark-text-3);font-size:12px}.summary b{margin-top:6px;font-size:18px}.empty{text-align:center;padding:50px;color:var(--lark-text-3)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--lark-border-light);font-size:13px}th{color:var(--lark-text-2);font-weight:500}.score{font-weight:700;color:var(--lark-primary)}@media(max-width:850px){.archive-layout{grid-template-columns:1fr}.summary{grid-template-columns:1fr 1fr}}
</style>
