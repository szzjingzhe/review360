<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mockApi } from '../api';
import {auditLabel} from '../lib/management-labels';
import { useAuth } from '../stores/auth';
import type { AuditEvent } from '../mock/data';
import { oversightPreviewActive } from '../lib/visualPreview';

const auth = useAuth();
const preview = computed(() => oversightPreviewActive(auth.user?.id));
const events = ref<AuditEvent[]>([]);
const action = ref('');
const from = ref('');
const to = ref('');
const loading = ref(false);

const actionOptions = computed(() => {
  const set = new Set(events.value.map((e) => e.action));
  return [...set].sort();
});

const filtered = computed(() => {
  return events.value.filter((e) => {
    if (action.value && e.action !== action.value) return false;
    if (from.value && e.createdAt < from.value) return false;
    if (to.value && e.createdAt > to.value + 'T23:59:59') return false;
    return true;
  });
});

onMounted(load);
async function load() {
  loading.value = true;
  try {
    events.value = await mockApi.listAuditEvents();
  } finally {
    loading.value = false;
  }
}

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
async function exportCsv() {
  const r = await mockApi.exportAudit(filtered.value, 'csv');
  download(r.content, r.filename, r.mime);
}
async function exportPdf() {
  const r = await mockApi.exportAudit(filtered.value, 'pdf');
  const blob = new Blob([r.content], { type: `${r.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
}
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h2>审计事件</h2>
        <p class="sub">全组织操作留痕导出（audit.export），支持 CSV / PDF</p>
      </div>
      <div class="ctrl">
        <button class="btn primary" @click="exportCsv" :disabled="preview || !filtered.length">导出 CSV</button>
        <button class="btn" @click="exportPdf" :disabled="preview || !filtered.length">导出 PDF</button>
      </div>
    </header>

    <p v-if="!auth.hasCapability('audit.export')" class="deny">当前身份无 audit.export 权限，请切换为获授权的监管身份查看与导出。</p>

    <div v-else class="body">
      <section class="filters">
        <label>操作类型
          <select v-model="action">
            <option value="">全部</option>
            <option v-for="a in actionOptions" :key="a" :value="a">{{ auditLabel(a) }}（{{a}}）</option>
          </select>
        </label>
        <label>起
          <input type="date" v-model="from" />
        </label>
        <label>止
          <input type="date" v-model="to" />
        </label>
        <span class="count">共 {{ filtered.length }} 条</span>
      </section>

      <div class="table-scroll" role="region" aria-label="审计事件列表" tabindex="0">
        <table class="tbl">
          <thead>
            <tr><th>时间</th><th>操作人</th><th>操作</th><th>资源类型</th><th>资源ID</th><th>原因</th><th>请求ID</th></tr>
          </thead>
          <tbody>
            <tr v-for="e in filtered" :key="e.id">
              <td>{{ e.createdAt }}</td>
              <td>{{ e.actorName ?? e.actorId }}</td>
              <td>{{auditLabel(e.action)}}<details><summary>事件编码</summary><code>{{e.action}}</code></details></td>
              <td>{{ e.resourceType }}</td>
              <td>{{ e.resourceId ?? '—' }}</td>
              <td class="reason-cell">{{ e.reason ?? '—' }}</td>
              <td>{{ e.requestId ?? '—' }}</td>
            </tr>
            <tr v-if="filtered.length === 0"><td colspan="7" class="empty">无审计事件</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 与其它页面统一：内边距由全局 .content 提供，避免二次内缩 */
.page { padding: 0; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.sub { color: var(--lark-text-2); font-size: 13px; margin: 4px 0 0; }
.ctrl { display: flex; gap: 8px; }
.btn {
  min-height: 32px; padding: 5px 16px; font-size: 14px; line-height: 20px;
  border: 1px solid var(--lark-border); color: var(--lark-text-1);
  background: var(--lark-bg-card); border-radius: var(--lark-radius); cursor: pointer;
  transition: background-color .1s ease, border-color .1s ease;
}
.btn:hover:not(:disabled) { background: var(--lark-bg-hover); }
.btn.primary { background: var(--lark-primary); border-color: var(--lark-primary); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--lark-primary-hover); border-color: var(--lark-primary-hover); }
.btn:disabled { color: var(--lark-text-4); background: var(--lark-fill-2); border-color: var(--lark-border-light); cursor: not-allowed; }
.deny { color: var(--lark-danger); background: var(--lark-danger-bg); border: 1px solid #ffc9c7; padding: 8px 12px; border-radius: var(--lark-radius); font-size: 13px; }
.filters { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; font-size: 13px; color: var(--lark-text-2); }
.filters select, .filters input { padding: 4px 8px; min-height: 28px; font-size: 13px; border: 1px solid var(--lark-border); border-radius: var(--lark-radius); background: var(--lark-bg-card); color: var(--lark-text-1); }
.count { color: var(--lark-text-2); }
.table-scroll { width: 100%; max-width: 100%; overflow-x: auto; border: 1px solid var(--lark-border-light); border-radius: var(--lark-radius-lg); background: var(--lark-bg-card); }
.tbl { width: max-content; min-width: 1320px; border-collapse: collapse; table-layout: auto; font-size: 14px; background: var(--lark-bg-card); }
.tbl th, .tbl td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--lark-border-light); white-space: nowrap; }
.tbl th:nth-child(1) { min-width: 155px; }
.tbl th:nth-child(2) { min-width: 120px; }
.tbl th:nth-child(3) { min-width: 150px; }
.tbl th:nth-child(4) { min-width: 125px; }
.tbl th:nth-child(5) { min-width: 250px; }
.tbl th:nth-child(6) { min-width: 300px; }
.tbl th:nth-child(7) { min-width: 220px; }
.tbl td.reason-cell { white-space: normal; min-width: 300px; max-width: 520px; word-break: normal; overflow-wrap: anywhere; line-height: 1.6; }
.tbl th { background: var(--lark-bg-page); color: var(--lark-text-2); font-weight: 500; }
.tbl tr:hover td { background: var(--lark-bg-hover); }
.tbl code { background: var(--lark-fill-2); padding: 1px 6px; border-radius: var(--lark-radius-sm); font-size: 12px; color: var(--lark-text-2); }
.empty { color: var(--lark-text-3); text-align: center; }
</style>
