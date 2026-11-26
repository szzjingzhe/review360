<script setup lang="ts">
import { decodeAppeal } from '../../lib/memberFeedback';
import type { FeedbackFilter, FeedbackRecord } from '../../contracts/feedback';
import { feedbackStage, feedbackState, feedbackStatus, feedbackTime, feedbackTitle } from '../../lib/feedback';
defineProps<{ records: FeedbackRecord[]; selectedId: string; total: number; page: number; pageCount: number;
  query: string; state: FeedbackFilter; stage: string; sort: string; loading: boolean; error: string; busy: boolean }>();
defineEmits<{ select: [id: string]; retry: []; 'update:query': [value: string]; 'update:state': [value: FeedbackFilter];
  'update:stage': [value: string]; 'update:sort': [value: string]; 'update:page': [value: number] }>();
</script>
<template>
  <section class="fm-list fm-panel" aria-labelledby="fm-list-title" :aria-busy="loading">
    <header class="fm-list-header"><h2 id="fm-list-title">申诉记录</h2><span class="fm-count">{{ loading || error ? '—' : total }} 条</span></header>
    <div class="fm-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
      <input :value="query" :disabled="busy" type="search" aria-label="搜索申请人、申诉内容或编号" placeholder="搜索申请人、申诉内容或编号…"
        @input="$emit('update:query', ($event.target as HTMLInputElement).value)"></div>
    <div class="fm-filters">
      <select :value="state" :disabled="busy" aria-label="申诉状态" @change="$emit('update:state', ($event.target as HTMLSelectElement).value as FeedbackFilter)">
        <option value="all">全部状态</option><option value="pending">待处理</option><option value="rereview">待复核</option><option value="closed">已办结</option>
      </select>
      <select :value="stage" :disabled="busy" aria-label="申诉阶段" @change="$emit('update:stage', ($event.target as HTMLSelectElement).value)">
        <option value="all">全部申诉阶段</option><option value="first">首次申诉</option><option value="rereview">二次复核</option>
      </select>
      <select :value="sort" :disabled="busy" aria-label="提交时间排序" @change="$emit('update:sort', ($event.target as HTMLSelectElement).value)">
        <option value="desc">最新提交优先</option><option value="asc">最早提交优先</option>
      </select>
    </div>
    <div v-if="loading" class="fm-list-state" role="status"><span class="fm-spinner"></span>正在加载申诉记录…</div>
    <div v-else-if="error" class="fm-list-state"><p class="fm-error" role="alert">{{ error }}</p><button class="fm-button" @click="$emit('retry')">重新加载</button></div>
    <div v-else-if="!records.length" class="fm-list-state"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><strong>暂无符合条件的申诉</strong><p>可切换评价周期或调整搜索、筛选条件。</p></div>
    <div v-else class="fm-records">
      <button v-for="record in records" :key="record.id" type="button" class="fm-record" :class="{ selected: selectedId === record.id }"
        :aria-pressed="selectedId === record.id" :disabled="busy" @click="$emit('select', record.id)">
        <span class="fm-record-top"><strong>{{ feedbackTitle(record) }}</strong><span class="fm-status" :class="feedbackState(record.status)">{{ feedbackStatus(record.status) }}</span></span>
        <span class="fm-record-meta">{{ record.applicantName || '姓名未记录' }}<template v-if="record.departmentName"> · {{ record.departmentName }}</template><span>{{ feedbackTime(record.createdAt) }}</span></span>
        <span class="fm-record-summary">{{ decodeAppeal(record.reason).reason }}</span>
        <span class="fm-record-bottom"><span class="fm-tag">{{ feedbackStage(record) }}</span><span class="fm-muted">{{ decodeAppeal(record.reason).scope }}</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span>
      </button>
    </div>
    <footer v-if="!loading && !error" class="fm-pagination"><span>共 {{ total }} 条 · {{ page }} / {{ pageCount }} 页</span><div>
      <button class="fm-page-button" :disabled="page <= 1 || busy" aria-label="上一页" @click="$emit('update:page', page - 1)">‹</button>
      <span class="fm-current-page" aria-current="page">{{ page }}</span>
      <button class="fm-page-button" :disabled="page >= pageCount || busy" aria-label="下一页" @click="$emit('update:page', page + 1)">›</button>
    </div></footer>
  </section>
</template>
