<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mockApi } from '../api';
import { managementRequest } from '../api/management';
import { monthlyPath } from '../lib/monthly-navigation';
import CycleSetupSteps from './CycleSetupSteps.vue';
import type { AnncData, AnncTimeline } from '../contracts/announcement';

interface CycleOption { id: string; title: string; month: string; status: string }

const route = useRoute();
const router = useRouter();
const cycles = ref<CycleOption[]>([]);
const cycleId = ref('');
const data = ref<AnncData | null>(null);
const draftTitle = ref('');
const draftBody = ref('');
const published = ref(true);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const toast = ref('');

const publishOpen = ref(false);
const publishing = ref(false);
const publishError = ref('');
const publishRun = ref<{ id: string; edge_count?: number; feasible?: boolean } | null>(null);
const memberCount = ref<number | null>(null);

const STAGE: Record<string, string> = {
  DRAFT: '草稿', PENDING_OPEN: '待开期', REVIEWING: '评价中', PAUSED: '已暂停',
  CALIBRATING: '核验中', PARTIALLY_PUBLISHED: '部分发布', PUBLISHED: '已发布', ARCHIVED: '已归档',
};
const stateLabel: Record<AnncTimeline['state'], string> = { done: '已结束', active: '进行中', upcoming: '待开始', missing: '未设置' };

const fmt = (v: string | null) => {
  if (!v) return '待定';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '待定';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
};

const previewBody = computed(() => (draftBody.value.trim() ? draftBody.value : data.value?.autoBody ?? ''));
const previewTitle = computed(() => draftTitle.value.trim() || `${data.value?.cycle?.month ?? ''} 月评公告`.trim());
const isDefaultText = computed(() => !data.value?.announcement.customized);
const cycleStatus = computed(() => data.value?.cycle?.status ?? '');
const canPublish = computed(() => ['DRAFT', 'PENDING_OPEN'].includes(cycleStatus.value));

function apply(next: AnncData) {
  data.value = next;
  draftTitle.value = next.announcement.customized ? next.announcement.title : `${next.cycle?.month ?? ''} 月评公告`.trim();
  draftBody.value = next.announcement.customized ? next.announcement.body : next.autoBody;
  published.value = next.announcement.isPublished;
}

/** 时间轴取值：优先用后端返回的节点，缺少时以「待定」占位。 */
function timelineAt(key: AnncTimeline['key']): string {
  const hit = data.value?.timeline.find((t) => t.key === key);
  return hit?.at ? fmt(hit.at) : '待定';
}

const templates = computed(() => {
  const month = data.value?.cycle?.month ?? '';
  const open = timelineAt('OPEN');
  const selfClose = timelineAt('SELF');
  const close = timelineAt('PEER');
  const publish = timelineAt('PUBLISH');
  return [
    {
      key: 'notice',
      name: '标准通知版',
      desc: '分点写清时间与规则，适合正式通知',
      title: `${month} 月评公告`,
      body: [
        `本期 ${month} 月度环评已经启动，请按下面的时间节点推进：`,
        '',
        `1. 材料上传与自评：${open} — ${selfClose}`,
        `2. 他评开放：${selfClose} — ${close}`,
        `3. 结果公布：${publish}`,
        '',
        '几点提醒：',
        '· 材料入口在左侧「月报宝」，可以直接上传文件，也可以粘贴飞书云文档链接。',
        '· 材料锁定后最多可以解锁 2 次，请确认无误后再锁定。',
        '· 75—95 分之间的评分不需要填写理由；低于 75 分或 96 分及以上需要说明原因。',
        '· 自评截止后不能再补交材料，也不能再修改自评。',
        '',
        '有问题请在群里找我。',
      ].join('\n'),
    },
    {
      key: 'brief',
      name: '简洁提醒版',
      desc: '三行说清截止时间，适合群里补发',
      title: `${month} 月评提醒`,
      body: [
        `【${month} 月评】本期环评进行中，请留意时间：`,
        `· 自评截止：${selfClose}`,
        `· 他评截止：${close}`,
        `· 结果公布：${publish}`,
        '',
        '材料请尽早上传，锁定前确认无误。75—95 分无需写理由。',
      ].join('\n'),
    },
    {
      key: 'group',
      name: '群公告版',
      desc: '带图标分点，适合直接发到群里',
      title: `${month} 月度环评通知`,
      body: [
        `📢 ${month} 月度环评开始啦`,
        '',
        '⏰ 时间安排',
        `· 材料上传与自评：${open} — ${selfClose}`,
        `· 他评：${selfClose} — ${close}`,
        `· 结果公布：${publish}`,
        '',
        '📌 注意事项',
        '1. 材料入口在左侧「月报宝」，支持上传文件或飞书云文档链接。',
        '2. 材料锁定后最多解锁 2 次，确认后再锁。',
        '3. 75—95 分不用写理由，96 分及以上或低于 75 分才需要说明。',
        '4. 自评截止后不能补交，也不能修改。',
        '',
        '有疑问随时找我～',
      ].join('\n'),
    },
  ];
});

function useTemplate(key: string) {
  const tpl = templates.value.find((t) => t.key === key);
  if (!tpl) return;
  draftTitle.value = tpl.title;
  draftBody.value = tpl.body;
  toast.value = `已套用「${tpl.name}」，可继续修改后保存`;
}

const errMsg = (e: unknown, fallback: string) => {
  const t = e instanceof Error ? e.message : String(e);
  if (t === 'AUTH_REQUIRED') return '登录状态已失效，请刷新页面重新登录。';
  return t || fallback;
};

async function loadCycles() {
  loading.value = true; error.value = '';
  try {
    const all = (await mockApi.listCycles()) as unknown as CycleOption[];
    cycles.value = all.filter((c) => c.status !== 'CANCELLED');
    const active = (await mockApi.getAnnouncement()) as AnncData;
    const wanted = String(route.params.cycleId ?? route.query.cycleId ?? '');
    const pick = wanted && cycles.value.some((c) => c.id === wanted) ? wanted : active.cycle?.id ?? cycles.value[0]?.id ?? '';
    if (!pick) { cycleId.value = ''; data.value = null; return; }
    cycleId.value = pick;
    apply(pick === active.cycle?.id ? active : (await mockApi.getCycleAnnouncement(pick)) as AnncData);
  } catch (e) {
    error.value = errMsg(e, '加载失败');
  } finally { loading.value = false; }
}

async function switchCycle() {
  if (!cycleId.value) return;
  loading.value = true; error.value = ''; toast.value = '';
  try { apply((await mockApi.getCycleAnnouncement(cycleId.value)) as AnncData); }
  catch (e) { error.value = errMsg(e, '加载失败'); }
  finally { loading.value = false; }
}

async function save(): Promise<boolean> {
  if (!cycleId.value) { error.value = '请先选择月评周期'; return false; }
  saving.value = true; error.value = ''; toast.value = '';
  try {
    const next = (await mockApi.saveAnnouncement(cycleId.value, {
      title: draftTitle.value.trim() || '月评公告',
      body: draftBody.value,
      isPublished: published.value,
    })) as AnncData;
    apply(next);
    toast.value = published.value ? '公告已保存，个人端立即生效' : '公告已保存（当前为停用状态，学员看不到）';
    return true;
  } catch (e) {
    error.value = errMsg(e, '保存失败');
    return false;
  } finally { saving.value = false; }
}

/** 保存并进入确认发布：先落库公告，再检查分配方案。 */
async function saveAndNext() {
  const ok = await save();
  if (ok) await openPublish();
}

async function openPublish() {
  if (!cycleId.value) return;
  publishOpen.value = true; publishError.value = ''; publishRun.value = null;
  try {
    const preview = await managementRequest<{ id: string; edge_count?: number; feasible?: boolean } | null>(`cycles/${cycleId.value}/assignment/confirmed-preview`);
    if (!preview) {
      publishError.value = '评价分配方案还没有保存，请先到「评价分配」预览并保存方案，再回来发布。';
      return;
    }
    publishRun.value = preview;
    try {
      const detail = await managementRequest<{ participants?: Array<{ eligibility?: string }> }>(`management/cycle-detail?cycleId=${encodeURIComponent(cycleId.value)}`);
      memberCount.value = Array.isArray(detail?.participants) ? detail.participants.filter((p) => p.eligibility !== 'EXCLUDED').length : null;
    } catch { memberCount.value = null; }
  } catch (e) {
    publishError.value = (e as Error).message === 'FORBIDDEN'
      ? '当前账号没有本周期分配检查权限，请联系管理员。'
      : '分配状态检查失败，请稍后重试。';
  }
}

async function doPublish() {
  if (!cycleId.value || !publishRun.value || publishing.value) return;
  publishing.value = true; publishError.value = '';
  const id = cycleId.value;
  try {
    if (cycleStatus.value === 'DRAFT') await managementRequest(`cycles/${id}/submit`, {});
    await managementRequest(`cycles/${id}/open`, { run_id: publishRun.value.id });
    publishOpen.value = false;
    toast.value = '月评已发起，个人端现在可以上传材料';
    await router.push({ path: monthlyPath('cycles', id), query: { panel: 'config' } });
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    publishError.value = ({
      OPEN_WINDOW_CLOSED: '评价截止时间已过，无法发起周期。请先修改周期时间。',
      OPEN_PREREQUISITE_MISSING: '尚未满足开期所需的系统配置，请检查评价规则与评价分配。',
      RUN_INPUT_CHANGED: '参评名单或评价关系已变化，请到「评价分配」重新预览并保存。',
      RUN_NOT_FEASIBLE: '分配方案未通过检查，请到「评价分配」处理缺口。',
      ASSIGNMENT_LOCKED: '周期状态已变化，请刷新后重试。',
      STATE_CONFLICT: '周期状态已变化，请刷新后重试。',
    } as Record<string, string>)[code] ?? '发布失败，请稍后重试。';
  } finally { publishing.value = false; }
}

function resetToDefault() {
  draftBody.value = data.value?.autoBody ?? '';
  draftTitle.value = `${data.value?.cycle?.month ?? ''} 月评公告`.trim();
  toast.value = '已填入系统默认文案，保存后生效';
}

onMounted(loadCycles);
</script>

<template>
  <section class="annc-admin">
    <div class="annc-admin-head">
      <div>
        <h2>月评公告</h2>
        <p>在这里写清本期的时间节点与注意事项。公告会显示在每位同学右上角的铃铛里，保存后立即生效。</p>
      </div>
      <div class="annc-picker">
        <label for="annc-cycle">周期</label>
        <select id="annc-cycle" v-model="cycleId" :disabled="loading || saving" @change="switchCycle">
          <option v-for="c in cycles" :key="c.id" :value="c.id">{{ c.title }}（{{ c.month }}）</option>
        </select>
      </div>
    </div>

    <CycleSetupSteps
      v-if="cycleId && canPublish"
      :cycle-id="cycleId"
      :current="3"
      :status="cycleStatus"
      :can-next="!!data"
      next-label="下一步：确认发布"
      next-hint="点一下会保存公告并检查评价分配"
      done-hint="公告会自动保存，然后进入确认发布"
      @next="saveAndNext"
    />

    <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    <p v-if="toast" class="notice notice-success" role="status">{{ toast }}</p>
    <p v-if="loading" class="annc-loading">正在加载…</p>

    <div v-if="!loading && !data" class="annc-empty">
      <div class="annc-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 10v4a2 2 0 0 0 2 2h2l6 4V4L8 8H6a2 2 0 0 0-2 2Z"/><path d="M18 9a4 4 0 0 1 0 6"/></svg>
      </div>
      <p class="annc-empty-title">还没有可编辑的月评周期</p>
      <p class="annc-empty-hint">公告依附于当期周期。目前没有进行中或待开期的周期，先去「周期管理」创建或重启一个周期，再回来写公告。</p>
      <button class="btn btn-primary btn-sm" type="button" @click="router.push({ path: monthlyPath('cycles') })">前往周期管理</button>
    </div>

    <div v-if="data" class="annc-grid">
      <div class="annc-panel">
        <div class="annc-row">
          <span class="annc-badge" :class="data.cycle?.status === 'REVIEWING' ? 'is-live' : ''">{{ STAGE[data.cycle?.status ?? ''] ?? data.cycle?.status ?? '—' }}</span>
          <span class="annc-muted">{{ data.cycle?.title ?? '未选择周期' }}</span>
          <span v-if="data.announcement.updatedAt" class="annc-muted">最近更新 {{ fmt(data.announcement.updatedAt) }}</span>
        </div>

        <div class="annc-templates">
          <span class="annc-templates-label">公告模板</span>
          <button v-for="tpl in templates" :key="tpl.key" class="annc-tpl" type="button" :title="tpl.desc" @click="useTemplate(tpl.key)">
            <strong>{{ tpl.name }}</strong>
            <em>{{ tpl.desc }}</em>
          </button>
        </div>

        <label class="annc-field">
          <span>公告标题</span>
          <input v-model="draftTitle" maxlength="120" placeholder="例如：2026-12 月评公告" />
        </label>

        <label class="annc-field">
          <span>公告正文<em v-if="isDefaultText">当前使用系统默认文案，可直接修改后保存</em></span>
          <textarea v-model="draftBody" rows="14" maxlength="4000" placeholder="写清楚本期时间节点和注意事项…" />
        </label>

        <label class="annc-toggle">
          <input v-model="published" type="checkbox" />
          <span>发布给学员（取消勾选后学员端不再显示这条公告）</span>
        </label>

        <div class="annc-actions">
          <button class="btn btn-sm" type="button" :disabled="saving" @click="resetToDefault">恢复默认文案</button>
          <button class="btn btn-sm" type="button" :disabled="saving || !cycleId" @click="save">{{ saving ? '保存中…' : '仅保存公告' }}</button>
          <button v-if="canPublish" class="btn btn-primary btn-sm" type="button" :disabled="saving || !cycleId" @click="saveAndNext">保存并进入发布</button>
        </div>

        <div class="annc-timeline-note">
          <h3>本期时间节点（自动同步周期设置）</h3>
          <ul>
            <li v-for="item in data.timeline" :key="item.key">
              <span class="dot" :class="'st-' + item.state" aria-hidden="true"></span>
              <span class="label">{{ item.label }}</span>
              <span class="at">{{ fmt(item.at) }}</span>
              <span class="chip" :class="item.state === 'done' ? 'chip-gray' : item.state === 'active' ? 'chip-amber' : 'chip-blue'">{{ stateLabel[item.state] }}</span>
            </li>
          </ul>
          <p class="annc-hint">时间节点来自「周期管理」里的设置，改周期时间会自动生效，无需在正文里重复填写。</p>
        </div>
      </div>

      <aside class="annc-preview">
        <header>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 10.5v3a1.5 1.5 0 0 0 1.5 1.5H6l4.6 3.9c.66.56 1.66.09 1.66-.77V5.87c0-.86-1-1.33-1.66-.77L6 9H4.5A1.5 1.5 0 0 0 3 10.5Z" fill="currentColor"/>
            <path d="M16 8.2a5.2 5.2 0 0 1 0 7.6M18.6 5.4a9 9 0 0 1 0 13.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          </svg>
          <strong>学员端预览</strong>
        </header>
        <div class="annc-preview-body">
          <p class="annc-preview-title">{{ previewTitle }}</p>
          <p v-for="(line, i) in previewBody.split('\n')" :key="i" :class="{ gap: line.trim() === '' }">{{ line }}</p>
        </div>
      </aside>
    </div>

    <div v-if="publishOpen" class="annc-overlay" @click.self="!publishing && (publishOpen = false)">
      <div class="annc-dialog" role="dialog" aria-modal="true" aria-labelledby="annc-publish-title">
        <h2 id="annc-publish-title">确认发布月评</h2>
        <p class="annc-dialog-sub">{{ data?.cycle?.title }} · {{ data?.cycle?.month }}</p>
        <dl class="annc-summary">
          <div><dt>参评人数</dt><dd>{{ memberCount ?? '—' }}</dd></div>
          <div><dt>评价关系</dt><dd>{{ publishRun?.edge_count ? publishRun.edge_count + ' 条' : '—' }}</dd></div>
          <div><dt>自评截止</dt><dd>{{ timelineAt('SELF') }}</dd></div>
          <div><dt>他评截止</dt><dd>{{ timelineAt('PEER') }}</dd></div>
          <div><dt>结果公布</dt><dd>{{ timelineAt('PUBLISH') }}</dd></div>
          <div><dt>当前状态</dt><dd>{{ STAGE[cycleStatus] ?? cycleStatus }}</dd></div>
        </dl>
        <p class="annc-dialog-note">确认后会锁定评价关系，个人端立刻可以上传材料并填写自评。月评成绩仍需在「结果管理」里单独发布。</p>
        <p v-if="publishError" class="notice notice-error" role="alert">{{ publishError }}</p>
        <div class="annc-dialog-actions">
          <RouterLink v-if="publishError" :to="{ path: monthlyPath('relations', cycleId) }" class="annc-link">前往评价分配 →</RouterLink>
          <button class="btn btn-sm" type="button" :disabled="publishing" @click="publishOpen = false">先不发布</button>
          <button class="btn btn-primary btn-sm" type="button" :disabled="publishing || !publishRun" @click="doPublish">{{ publishing ? '正在发布…' : '确认发布月评' }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.annc-admin { color: #172b4d; }
.annc-admin-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; flex-wrap: wrap; }
.annc-admin-head h2 { margin: 0 0 6px; font-size: 18px; font-weight: 600; color: var(--lark-text-1); }
.annc-admin-head p { margin: 0; font-size: 13px; line-height: 21px; color: var(--lark-text-2); max-width: 620px; }
.annc-picker { display: flex; align-items: center; gap: 8px; }
.annc-picker label { margin: 0; font-size: 13px; color: var(--lark-text-2); white-space: nowrap; }
.annc-picker select { min-width: 240px; min-height: 34px; border: 1px solid var(--lark-border, #dce4ef); border-radius: 7px; padding: 5px 10px; font: inherit; font-size: 13px; background: #fff; }
.annc-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 18px; align-items: start; }
.annc-panel { background: #fff; border: 1px solid var(--lark-border-light, #e8edf4); border-radius: 12px; padding: 20px 22px 18px; box-shadow: 0 2px 6px rgba(23, 43, 77, .03); }
.annc-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.annc-badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 4px; background: var(--lark-fill-2, #f2f3f5); color: var(--lark-text-2); font-size: 12px; }
.annc-badge.is-live { background: var(--lark-primary-bg, #e1eaff); color: var(--lark-primary, #3370ff); }
.annc-muted { font-size: 12px; color: var(--lark-text-3, #8f959e); }
.annc-field { display: block; margin-bottom: 14px; }
.annc-field > span { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; font-size: 13px; color: var(--lark-text-2); }
.annc-field em { font-style: normal; font-size: 12px; color: var(--lark-text-3); }
.annc-field input, .annc-field textarea { width: 100%; border: 1px solid var(--lark-border, #dce4ef); border-radius: 7px; padding: 8px 11px; font: inherit; font-size: 13px; line-height: 21px; box-sizing: border-box; }
.annc-field textarea { resize: vertical; min-height: 220px; }
.annc-field input:focus, .annc-field textarea:focus { outline: none; border-color: var(--lark-primary, #3370ff); box-shadow: 0 0 0 2px rgba(51, 112, 255, .18); }
.annc-toggle { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; font-size: 13px; color: var(--lark-text-2); cursor: pointer; }
.annc-toggle input { width: 15px; height: 15px; }
.annc-actions { display: flex; justify-content: flex-end; gap: 8px; }
.annc-timeline-note { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--lark-border-light, #eef1f6); }
.annc-timeline-note h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: var(--lark-text-1); }
.annc-timeline-note ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.annc-timeline-note li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--lark-text-1); }
.annc-timeline-note .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--lark-border, #dee0e3); flex: none; }
.annc-timeline-note .dot.st-done { background: #34c724; }
.annc-timeline-note .dot.st-active { background: var(--lark-primary, #3370ff); box-shadow: 0 0 0 3px var(--lark-primary-bg, #e1eaff); }
.annc-timeline-note .dot.st-missing { background: var(--lark-text-4, #bbbfc4); }
.annc-timeline-note .label { min-width: 84px; font-weight: 500; }
.annc-timeline-note .at { color: var(--lark-text-2); font-variant-numeric: tabular-nums; }
.annc-hint { margin: 12px 0 0; font-size: 12px; color: var(--lark-text-3); line-height: 19px; }
.annc-preview { background: #fff; border: 1px solid var(--lark-border-light, #e8edf4); border-radius: 12px; overflow: hidden; position: sticky; top: 96px; }
.annc-preview header { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--lark-border-light, #eef1f6); font-size: 13px; color: var(--lark-text-1); }
.annc-preview header svg { width: 18px; height: 18px; color: #e54545; }
.annc-preview-body { padding: 16px; max-height: 560px; overflow: auto; }
.annc-preview-title { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: var(--lark-text-1); }
.annc-preview-body p { margin: 0 0 6px; font-size: 13px; line-height: 22px; color: var(--lark-text-1); white-space: pre-wrap; word-break: break-word; }
.annc-preview-body p.gap { height: 3px; margin: 0; }
.annc-loading { font-size: 13px; color: var(--lark-text-3); }
.annc-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 56px 24px; background: #fff; border: 1px solid var(--lark-border); border-radius: 12px; text-align: center; }
.annc-empty-icon { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; background: #eef4ff; color: #3370ff; }
.annc-empty-icon svg { width: 22px; height: 22px; }
.annc-empty-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--lark-text-1); }
.annc-empty-hint { margin: 0; max-width: 460px; font-size: 13px; line-height: 1.7; color: var(--lark-text-3); }
.notice-error { color: #b42318; background: #fff4f3; border: 1px solid #fee4e2; border-radius: 7px; padding: 9px 12px; font-size: 13px; margin: 0 0 14px; }
.notice-success { color: #18815f; background: #effaf4; border: 1px solid #d9f2e4; border-radius: 7px; padding: 9px 12px; font-size: 13px; margin: 0 0 14px; }
@media (max-width: 1100px) { .annc-grid { grid-template-columns: minmax(0, 1fr); } .annc-preview { position: static; } }
.annc-templates { display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.annc-templates-label { font-size: 13px; color: var(--lark-text-2); align-self: center; margin-right: 2px; }
.annc-tpl { text-align: left; border: 1px solid var(--lark-border-light, #e8edf4); background: #fbfcfe; border-radius: 8px; padding: 8px 12px; cursor: pointer; display: grid; gap: 2px; transition: .15s; }
.annc-tpl:hover { border-color: var(--lark-primary, #3370ff); background: var(--lark-primary-bg, #f0f5ff); }
.annc-tpl strong { font-size: 13px; font-weight: 600; color: var(--lark-text-1); }
.annc-tpl em { font-style: normal; font-size: 11px; color: var(--lark-text-3, #8f959e); }
.annc-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, .38); display: grid; place-items: center; z-index: 1200; }
.annc-dialog { width: min(520px, 92vw); max-height: 86vh; overflow: auto; background: #fff; border-radius: 14px; padding: 22px 24px 18px; box-shadow: 0 12px 40px rgba(23, 43, 77, .18); }
.annc-dialog h2 { margin: 0 0 4px; font-size: 17px; font-weight: 600; color: var(--lark-text-1); }
.annc-dialog-sub { margin: 0 0 16px; font-size: 13px; color: var(--lark-text-2); }
.annc-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0 0 14px; }
.annc-summary > div { background: #f7f9fc; border-radius: 8px; padding: 10px 12px; }
.annc-summary dt { font-size: 12px; color: var(--lark-text-3, #8f959e); margin-bottom: 3px; }
.annc-summary dd { margin: 0; font-size: 13px; font-weight: 600; color: var(--lark-text-1); font-variant-numeric: tabular-nums; }
.annc-dialog-note { margin: 0 0 12px; font-size: 12px; line-height: 19px; color: var(--lark-text-2); }
.annc-dialog-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.annc-link { font-size: 12px; color: var(--lark-primary, #3370ff); text-decoration: none; margin-right: auto; }
</style>
