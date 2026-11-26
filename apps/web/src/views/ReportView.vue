<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mockApi } from '../api';
import { useAuth } from '../stores/auth';
import type { MonthlyReport } from '../mock/data';

const auth = useAuth();
const cycles = ref<{ id: string; title: string; month: string; status: string }[]>([]);
const cycleId = ref('');
const report = ref<MonthlyReport | null>(null);
const loading = ref(false);
const error = ref('');

onMounted(async () => {
  try {
    cycles.value = await mockApi.listCycles();
    cycleId.value = cycles.value.find((cycle) => cycle.status === 'PUBLISHED')?.id ?? cycles.value[0]?.id ?? '';
    if (cycleId.value && auth.hasCapability('report.view')) await load();
  } catch (e: any) { error.value = `周期加载失败：${e?.message ?? e}`; }
});
async function load() {
  if (!cycleId.value || !auth.hasCapability('report.view')) return;
  loading.value = true;
  error.value = '';
  try {
    report.value = await mockApi.getMonthlyReport(cycleId.value);
  } catch (e: any) {
    report.value = null;
    error.value = `月报数据加载失败：${e?.message ?? e}`;
  } finally {
    loading.value = false;
  }
}

const buckets = [
  // 飞书状态色：优秀=绿 / 良好=蓝 / 合格=橙 / 待改进=红
  { key: 'excellent', label: '优秀 (≥90)', color: '#2ea121' },
  { key: 'good', label: '良好 (80-89)', color: '#3370ff' },
  { key: 'qualified', label: '合格 (60-79)', color: '#ff8800' },
  { key: 'low', label: '待改进 (<60)', color: '#f54a45' },
] as const;

const maxBucket = computed(() => {
  if (!report.value) return 1;
  const d = report.value.org.distribution;
  return Math.max(1, d.excellent, d.good, d.qualified, d.low);
});
function pct(n: number) {
  return Math.round((n / maxBucket.value) * 100);
}
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h2>月报洞察</h2>
        <p class="sub">基于已发布结果的组织 / 部门月度汇总（report.view）。这是<b>组织级统计视图</b>，与个人「月度成果」中的材料提交是两件事；个人材料请在「月度成果」页维护。</p>
      </div>
      <div class="ctrl">
        <select v-model="cycleId" @change="load" :disabled="!cycles.length || loading">
          <option v-for="c in cycles" :key="c.id" :value="c.id">{{ c.title }}（{{ c.month }}）</option>
        </select>
        <button class="btn" @click="load" :disabled="loading">{{ loading ? '生成中…' : '生成月报' }}</button>
      </div>
    </header>

    <p v-if="!auth.hasCapability('report.view')" class="deny">当前身份无 report.view 权限，请切换为获授权的监管身份查看。</p>

    <p v-else-if="error" class="deny" role="alert">{{ error }}</p>
    <p v-else-if="!loading && !cycles.length" class="empty">服务端当前没有可查看的评价周期。</p>
    <p v-if="loading" class="empty">正在从服务端读取月报数据…</p>

    <div v-if="report" class="body">
      <section class="cards">
        <div class="card"><span class="k">参与人数</span><b>{{ report.org.participantCount }}</b></div>
        <div class="card"><span class="k">已发布</span><b>{{ report.org.publishedCount }}</b></div>
        <div class="card"><span class="k">平均分</span><b>{{ report.org.avgScore }}</b></div>
        <div class="card"><span class="k">评优人数</span><b>{{ report.org.awardedCount }}</b></div>
        <div class="card"><span class="k">反馈 / 已处理</span><b>{{ report.org.feedbackCount }} / {{ report.org.feedbackResolved }}</b></div>
      </section>

      <section class="block">
        <h3>分数分布</h3>
        <div v-for="b in buckets" :key="b.key" class="bar-row">
          <span class="bl">{{ b.label }}</span>
          <div class="track"><div class="fill" :style="{ width: pct(report.org.distribution[b.key]) + '%', background: b.color }"></div></div>
          <span class="bn">{{ report.org.distribution[b.key] }} 人</span>
        </div>
      </section>

      <section class="block">
        <h3>部门明细</h3>
        <table class="tbl">
          <thead>
            <tr><th>部门</th><th>人数</th><th>平均分</th><th>最高分</th><th>最低分</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in report.departments" :key="d.deptId">
              <td>{{ d.deptName }}</td>
              <td>{{ d.count }}</td>
              <td>{{ d.avgScore }}</td>
              <td>{{ d.maxScore }}</td>
              <td>{{ d.minScore }}</td>
            </tr>
            <tr v-if="report.departments.length === 0"><td colspan="5" class="empty">该周期暂无部门聚合数据</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 0; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.sub { color: var(--lark-text-2); font-size: 13px; margin: 4px 0 0; }
.ctrl { display: flex; gap: 8px; }
.ctrl select { padding: 4px 8px; min-height: 32px; font-size: 14px; }
.btn {
  min-height: 32px; padding: 5px 16px; font-size: 14px; line-height: 20px;
  border: 1px solid var(--lark-border); color: var(--lark-text-1);
  background: var(--lark-bg-card); border-radius: var(--lark-radius); cursor: pointer;
  transition: background-color .1s ease, border-color .1s ease;
}
.btn:hover:not(:disabled) { background: var(--lark-bg-hover); }
.btn:disabled { color: var(--lark-text-4); background: var(--lark-fill-2); border-color: var(--lark-border-light); cursor: not-allowed; }
.deny { color: var(--lark-danger); background: var(--lark-danger-bg); border: 1px solid #ffc9c7; padding: 8px 12px; border-radius: var(--lark-radius); font-size: 13px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }
.card { background: var(--lark-bg-card); border: 1px solid var(--lark-border-light); border-radius: var(--lark-radius-lg); padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
.card .k { font-size: 12px; color: var(--lark-text-2); }
.card b { font-size: 20px; font-weight: 600; color: var(--lark-text-1); font-variant-numeric: tabular-nums; }
.block { background: var(--lark-bg-card); border: 1px solid var(--lark-border-light); border-radius: var(--lark-radius-lg); padding: 16px; margin-bottom: 16px; box-shadow: var(--lark-shadow-card); }
.block h3 { margin: 0 0 12px; font-size: 16px; font-weight: 600; color: var(--lark-text-1); }
.bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.bl { width: 120px; font-size: 12px; color: var(--lark-text-2); }
.track { flex: 1; height: 8px; background: var(--lark-fill-2); border-radius: var(--lark-radius-sm); overflow: hidden; }
.fill { height: 100%; border-radius: var(--lark-radius-sm); transition: width .3s ease; }
.bn { width: 48px; text-align: right; font-size: 12px; color: var(--lark-text-2); }
.tbl { width: 100%; border-collapse: collapse; font-size: 14px; }
.tbl th, .tbl td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--lark-border-light); }
.tbl th { color: var(--lark-text-2); font-weight: 500; background: var(--lark-bg-page); }
.tbl tr:hover td { background: var(--lark-bg-hover); }
.empty { color: var(--lark-text-3); text-align: center; }
</style>
