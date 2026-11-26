<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { mockApi } from '../api';
import type { AnncData, AnncTimeline } from '../contracts/announcement';

const props = defineProps<{ data: AnncData }>();
const emit = defineEmits<{ (e: 'close', dontShow: boolean): void; (e: 'saved', data: AnncData): void }>();

const dontShow = ref(false);
const editing = ref(false);
const draftTitle = ref('');
const draftBody = ref('');
const saving = ref(false);
const error = ref('');
const data = ref<AnncData>(props.data);
watch(() => props.data, (v) => { data.value = v; });

const title = computed(() => data.value.announcement.title || '月评公告');
const bodyText = computed(() => (data.value.announcement.customized ? data.value.announcement.body : data.value.autoBody));
const paragraphs = computed(() => bodyText.value.split('\n'));

const fmt = (v: string | null) => {
  if (!v) return '待定';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '待定';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
};
const stateLabel: Record<AnncTimeline['state'], string> = { done: '已结束', active: '进行中', upcoming: '待开始', missing: '未设置' };

function startEdit() {
  editing.value = true;
  error.value = '';
  draftTitle.value = data.value.announcement.customized ? data.value.announcement.title : `${data.value.cycle?.month ?? ''} 月评公告`.trim();
  draftBody.value = data.value.announcement.customized ? data.value.announcement.body : data.value.autoBody;
}
async function save() {
  if (!data.value.cycle) { error.value = '当前没有可挂载的月评周期'; return; }
  saving.value = true; error.value = '';
  try {
    const next = await mockApi.saveAnnouncement(data.value.cycle.id, { title: draftTitle.value, body: draftBody.value, isPublished: true });
    data.value = next as AnncData;
    emit('saved', data.value);
    editing.value = false;
  } catch (e) {
    error.value = (e as Error).message || '保存失败';
  } finally { saving.value = false; }
}
</script>

<template>
  <Teleport to="body">
    <div class="annc-backdrop" @click.self="emit('close', dontShow)">
      <section class="annc-card" role="dialog" aria-modal="true" aria-labelledby="annc-title">
        <header class="annc-head">
          <h2 id="annc-title">
            <svg class="horn" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 10.5v3a1.5 1.5 0 0 0 1.5 1.5H6l4.6 3.9c.66.56 1.66.09 1.66-.77V5.87c0-.86-1-1.33-1.66-.77L6 9H4.5A1.5 1.5 0 0 0 3 10.5Z" fill="currentColor"/>
              <path d="M16 8.2a5.2 5.2 0 0 1 0 7.6M18.6 5.4a9 9 0 0 1 0 13.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
            </svg>
            {{ editing ? '编辑月评公告' : title }}
          </h2>
          <button class="annc-close" type="button" @click="emit('close', dontShow)">关闭</button>
        </header>

        <div class="annc-body">
          <div v-if="error" class="annc-err" role="alert">{{ error }}</div>

          <template v-if="editing">
            <label class="annc-label">公告标题</label>
            <input v-model="draftTitle" maxlength="120" placeholder="例如：2026-12 月评公告" />
            <label class="annc-label" style="margin-top:12px">公告正文</label>
            <textarea v-model="draftBody" rows="12" maxlength="4000" placeholder="写清楚本期的时间节点和注意事项。留空则展示系统按周期时间自动生成的文案。" />
            <p class="annc-hint">正文会原样展示给所有同学；时间节点由上方周期设置自动生成，无需重复填写。</p>
            <div class="annc-edit-actions">
              <button class="btn" type="button" :disabled="saving" @click="editing = false">取消</button>
              <button class="btn btn-primary" type="button" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存并发布' }}</button>
            </div>
          </template>

          <template v-else>
            <div class="annc-frame">
              <div class="annc-meta">
                <span class="annc-cycle">{{ data.cycle ? data.cycle.title : '暂无进行中的月评' }}</span>
                <span v-if="data.cycle" class="chip chip-blue">{{ data.phaseLabel }}</span>
                <span v-if="data.announcement.customized && data.announcement.updatedAt" class="tag">更新于 {{ fmt(data.announcement.updatedAt) }}</span>
              </div>

              <ol v-if="data.timeline.length" class="annc-timeline">
                <li v-for="item in data.timeline" :key="item.key" :class="['st-' + item.state]">
                  <span class="dot" aria-hidden="true"></span>
                  <div class="line">
                    <p class="when">
                      <strong>{{ item.label }}</strong>
                      <span class="at">{{ fmt(item.at) }}</span>
                      <span class="chip" :class="item.state === 'done' ? 'chip-gray' : item.state === 'active' ? 'chip-amber' : 'chip-blue'">{{ stateLabel[item.state] }}</span>
                    </p>
                    <p class="note">{{ item.note }}</p>
                  </div>
                </li>
              </ol>

              <div class="annc-text">
                <p v-for="(line, i) in paragraphs" :key="i" :class="{ gap: line.trim() === '' }">{{ line }}</p>
              </div>
            </div>
          </template>
        </div>

        <footer class="annc-foot">
          <label class="annc-check">
            <input v-model="dontShow" type="checkbox" :disabled="editing" />
            <span>今日不再自动弹出当前展开公告</span>
          </label>
          <button v-if="data.canEdit && !editing" class="btn btn-sm" type="button" @click="startEdit">编辑公告</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.annc-backdrop {
  position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: rgba(31, 35, 41, .45); backdrop-filter: blur(2px);
}
.annc-card {
  width: min(860px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column;
  background: #fff; border-radius: 12px; box-shadow: 0 18px 48px rgba(15, 23, 42, .22); overflow: hidden;
}
.annc-head {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 20px 24px 12px;
}
.annc-head h2 { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 19px; font-weight: 600; color: var(--lark-text-1); }
.horn { width: 24px; height: 24px; color: #e54545; flex: none; }
.annc-close {
  border: 0; background: none; padding: 4px 2px; font-size: 14px; color: var(--lark-text-1);
  cursor: pointer; font-family: inherit;
}
.annc-close:hover { color: var(--lark-primary); }
.annc-body { padding: 0 24px 4px; overflow-y: auto; }
.annc-frame { border: 1px solid var(--lark-border); border-radius: 8px; padding: 22px 24px 8px; }
.annc-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.annc-cycle { font-size: 15px; font-weight: 600; color: var(--lark-text-1); }
.annc-timeline { list-style: none; margin: 0 0 18px; padding: 0; }
.annc-timeline li { display: flex; gap: 12px; padding-bottom: 14px; position: relative; }
.annc-timeline li:not(:last-child)::before {
  content: ''; position: absolute; left: 4px; top: 14px; bottom: 0; width: 1px; background: var(--lark-border-light);
}
.annc-timeline .dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 7px; flex: none; background: var(--lark-border); }
.annc-timeline .st-done .dot { background: #34c724; }
.annc-timeline .st-active .dot { background: var(--lark-primary); box-shadow: 0 0 0 3px var(--lark-primary-bg); }
.annc-timeline .st-missing .dot { background: var(--lark-text-4); }
.annc-timeline .when { display: flex; align-items: center; gap: 8px; margin: 0; flex-wrap: wrap; font-size: 14px; color: var(--lark-text-1); }
.annc-timeline .when strong { font-weight: 600; }
.annc-timeline .at { color: var(--lark-text-2); font-variant-numeric: tabular-nums; }
.annc-timeline .note { margin: 2px 0 0; font-size: 13px; color: var(--lark-text-3); line-height: 20px; }
.annc-text p { margin: 0 0 8px; font-size: 14px; line-height: 24px; color: var(--lark-text-1); white-space: pre-wrap; word-break: break-word; }
.annc-text p.gap { height: 4px; margin: 0; }
.annc-label { display: block; font-size: 13px; color: var(--lark-text-2); margin-bottom: 6px; }
.annc-hint { margin: 8px 0 0; font-size: 12px; color: var(--lark-text-3); }
.annc-edit-actions { display: flex; justify-content: flex-end; gap: 8px; margin: 16px 0 8px; }
.annc-err { margin-bottom: 12px; padding: 8px 12px; border-radius: 6px; background: var(--lark-danger-bg); color: var(--lark-danger); font-size: 13px; }
.annc-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 24px 18px; border-top: 1px solid var(--lark-border-light); margin-top: 8px;
}
.annc-check { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; color: var(--lark-text-2); cursor: pointer; }
.annc-check input { width: 15px; height: 15px; }
@media (max-width: 640px) {
  .annc-backdrop { padding: 0; align-items: flex-end; }
  .annc-card { max-height: 92vh; border-radius: 12px 12px 0 0; }
  .annc-body { padding: 0 16px 4px; }
  .annc-frame { padding: 16px 16px 4px; }
}
</style>
