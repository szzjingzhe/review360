<script setup lang="ts">
import type { FeedbackFilter } from '../../contracts/feedback';
defineProps<{ counts: Record<FeedbackFilter, number>; selected: FeedbackFilter; loading: boolean; unavailable: boolean; busy: boolean }>();
defineEmits<{ select: [value: FeedbackFilter] }>();
const metrics: Array<{ key: FeedbackFilter; label: string; icon: string }> = [
  { key: 'all', label: '全部申诉', icon: 'fa-regular fa-file-lines' },
  { key: 'pending', label: '待处理', icon: 'fa-regular fa-clock' },
  { key: 'rereview', label: '待复核', icon: 'fa-solid fa-arrows-rotate' },
  { key: 'closed', label: '已办结', icon: 'fa-regular fa-circle-check' },
];
</script>
<template>
  <section class="fm-overview" aria-label="当前周期申诉概览" :aria-busy="loading">
    <button v-for="metric in metrics" :key="metric.key" type="button" class="fm-metric" :class="[metric.key, { selected: selected === metric.key }]"
      :aria-pressed="selected === metric.key" :disabled="loading || unavailable || busy" @click="$emit('select', metric.key)">
      <span class="fm-metric-icon"><i :class="metric.icon" aria-hidden="true"></i></span>
      <span><strong>{{ loading || unavailable ? '—' : counts[metric.key] }}</strong><span>{{ metric.label }}</span></span>
    </button>
  </section>
</template>
