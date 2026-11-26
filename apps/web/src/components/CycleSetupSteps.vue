<script setup lang="ts">
import { computed } from 'vue';
import { monthlyPath } from '../lib/monthly-navigation';

const props = defineProps<{
  cycleId: string;
  current: number;
  status?: string;
  canNext?: boolean;
  nextLabel?: string;
  nextHint?: string;
  doneHint?: string;
}>();
const emit = defineEmits<{ (e: 'next'): void }>();

const steps = [
  { n: 1, label: '周期配置', to: 'cycles' },
  { n: 2, label: '评价分配', to: 'relations' },
  { n: 3, label: '公告编辑', to: 'announcement' },
  { n: 4, label: '确认发布', to: '' },
] as const;

/** 只在周期还没真正开期时展示，避免已评价中的周期出现"下一步"误导。 */
const visible = computed(() => !props.status || ['DRAFT', 'PENDING_OPEN'].includes(props.status));
const linkFor = (to: string) => (to ? monthlyPath(to, props.cycleId) : '');
</script>

<template>
  <section v-if="visible && cycleId" class="setup-steps" aria-label="月评发起流程">
    <ol>
      <li v-for="s in steps" :key="s.n" :class="{ done: s.n < current, active: s.n === current }">
        <RouterLink v-if="s.to && s.n !== current && s.n > current" :to="linkFor(s.to)">
          <span class="num">{{ s.n }}</span>
          <span class="txt">{{ s.label }}</span>
        </RouterLink>
        <RouterLink v-else-if="s.to && s.n !== current && s.n < current" :to="linkFor(s.to)">
          <span class="num">✓</span>
          <span class="txt">{{ s.label }}</span>
        </RouterLink>
        <span v-else class="static">
          <span class="num">{{ s.n < current ? '✓' : s.n }}</span>
          <span class="txt">{{ s.label }}</span>
        </span>
      </li>
    </ol>
    <div v-if="nextLabel" class="step-next">
      <span v-if="doneHint" class="hint is-done">{{ doneHint }}</span>
      <span v-else-if="nextHint" class="hint">{{ nextHint }}</span>
      <button class="btn btn-primary btn-sm" type="button" :disabled="!canNext" @click="emit('next')">{{ nextLabel }}</button>
    </div>
  </section>
</template>

<style scoped>
.setup-steps { background: #fff; border: 1px solid var(--lark-border-light, #e8edf4); border-radius: 12px; padding: 14px 18px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; box-shadow: 0 2px 6px rgba(23, 43, 77, .03); }
.setup-steps ol { list-style: none; display: flex; align-items: center; gap: 6px; margin: 0; padding: 0; flex-wrap: wrap; }
.setup-steps li { position: relative; }
.setup-steps li + li::before { content: ''; display: inline-block; width: 18px; height: 1px; background: #dbe3ef; vertical-align: middle; margin-right: 6px; }
.setup-steps a, .setup-steps .static { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--lark-text-2, #646a73); text-decoration: none; }
.setup-steps a:hover .txt { color: var(--lark-primary, #3370ff); }
.setup-steps .num { width: 20px; height: 20px; border-radius: 50%; background: #f0f3f8; color: #7b8798; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex: none; }
.setup-steps li.active .num { background: var(--lark-primary, #3370ff); color: #fff; }
.setup-steps li.active .txt { color: var(--lark-text-1, #1f2329); font-weight: 600; }
.setup-steps li.done .num { background: #e4f6ec; color: #1f9b5a; }
.step-next { display: flex; align-items: center; gap: 12px; }
.step-next .hint { font-size: 12px; color: var(--lark-text-3, #8f959e); max-width: 320px; line-height: 18px; }
.step-next .hint.is-done { color: #1f9b5a; }
@media (max-width: 900px) { .setup-steps { flex-direction: column; align-items: flex-start; } }
</style>
