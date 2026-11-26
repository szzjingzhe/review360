<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FeedbackRecord } from '../../contracts/feedback';
import { isRereview } from '../../lib/feedback';
const props = defineProps<{ record: FeedbackRecord; modelValue: string; busy: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; submit: [decision: 'APPROVED' | 'REJECTED', note: string] }>();
const decision = ref<'APPROVED' | 'REJECTED'>('APPROVED');
const error = ref(''), confirmation = ref<HTMLDialogElement | null>(null);
const actionLabel = computed(() => isRereview(props.record)
  ? decision.value === 'APPROVED' ? '支持二次申诉' : '维持原结论'
  : decision.value === 'APPROVED' ? '说明并办结' : '驳回申诉');
function confirm() {
  error.value = '';
  if (!props.modelValue.trim()) { error.value = '请填写处理依据与意见；驳回申诉时必须说明原因。'; return; }
  confirmation.value?.showModal();
}
function submit() {
  if (props.busy) return;
  confirmation.value?.close();
  emit('submit', decision.value, props.modelValue.trim());
}
</script>
<template>
  <section class="fm-review" aria-labelledby="fm-review-title">
    <h3 id="fm-review-title">{{ isRereview(record) ? '二次复核处理' : '审核处理' }}</h3>
    <p class="fm-help">{{ isRereview(record) ? '本次处理针对原申诉的二次复核，请结合首次处理意见作出结论。' : '按现有规则提交最终处理结论。处理申诉不会直接修改评价分数。' }}</p>
    <form @submit.prevent="confirm">
      <div class="fm-review-decision"><label for="fm-decision">处理结论</label><select id="fm-decision" v-model="decision" :disabled="busy">
        <option value="APPROVED">{{ isRereview(record) ? '支持二次申诉' : '说明并办结' }}</option>
        <option value="REJECTED">{{ isRereview(record) ? '维持原结论' : '驳回申诉' }}</option>
      </select></div>
      <label for="fm-note">处理意见 <span class="fm-required">*</span></label>
      <div class="fm-note-input"><textarea id="fm-note" :value="modelValue" :disabled="busy" maxlength="2000" rows="4"
        placeholder="请填写核查情况、处理依据及结论…" :aria-invalid="!!error" :aria-describedby="error ? 'fm-form-error' : 'fm-note-help'"
        @input="error = ''; emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"></textarea><span>{{ modelValue.length }} / 2000</span></div>
      <p v-if="error" id="fm-form-error" class="fm-error" role="alert">{{ error }}</p>
      <div class="fm-review-footer"><span id="fm-note-help" class="fm-help">未提交意见仅保留在当前页面。</span><button class="fm-button primary" :disabled="busy" type="submit"><span v-if="busy" class="fm-spinner"></span>{{ busy ? '正在提交…' : '提交处理结论' }}</button></div>
    </form>
    <Teleport to="body"><dialog ref="confirmation" class="fm-confirmation" aria-labelledby="fm-confirm-title"><h2 id="fm-confirm-title">确认提交处理结论？</h2>
      <p>{{ record.applicantName }} · {{ record.cycleMonth }} 评价结果申诉</p><p>处理结论：<strong>{{ actionLabel }}</strong></p><p class="fm-confirm-note">{{ modelValue.trim() }}</p><p>提交后会更新申诉状态，并向申请人同步处理结果。</p>
      <footer><button class="fm-button" type="button" @click="confirmation?.close()">返回修改</button><button class="fm-button primary" type="button" :disabled="busy" @click="submit">确认提交</button></footer>
    </dialog></Teleport>
  </section>
</template>
