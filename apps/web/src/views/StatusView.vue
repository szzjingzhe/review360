<script setup lang="ts">
import { onMounted } from 'vue';
import { useSystemStore, type HealthState } from '../stores/system';

const system = useSystemStore();

async function probe(path: string, setter: (s: HealthState) => void) {
  try {
    const res = await fetch(`/api/v1${path}`);
    setter(res.ok ? 'ok' : 'bad');
  } catch {
    setter('bad');
  }
}

onMounted(() => {
  void probe('/health/live', system.setLive);
  void probe('/health/ready', system.setReady);
});
</script>

<template>
  <div class="card">
    <div class="row">
      <span>后端存活探针 <code>GET /api/v1/health/live</code></span>
      <span :class="system.live">{{ system.live === 'ok' ? '正常' : system.live === 'bad' ? '不可达' : '检测中…' }}</span>
    </div>
    <div class="row">
      <span>后端就绪探针 <code>GET /api/v1/health/ready</code>（校验数据库可达）</span>
      <span :class="system.ready">{{ system.ready === 'ok' ? '正常' : system.ready === 'bad' ? '不可达' : '检测中…' }}</span>
    </div>
    <div class="row">
      <span>当前里程碑</span>
      <span class="pending">M0 — 项目基础</span>
    </div>
  </div>
  <p class="note">
    本页面用于 M0 联通验收：Vite 开发服务器通过代理访问 NestJS API。
    正式页面（P01—P14）从 M1 起逐步实现。
  </p>
</template>

<style scoped>
.note { color: var(--lark-text-2); font-size: 13px; line-height: 1.8; margin: 8px 4px 0; }
</style>
