<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mockApi } from '../api';

/**
 * 系统设置 → 模型配置。
 * 组织可自由维护 OpenAI 兼容的模型服务地址与密钥；默认模型用于月评的 AI 成长分析。
 */
interface Provider {
  id: string; name: string; baseUrl: string; protocol: string; model: string;
  contextWindow: number | null; maxOutputTokens: number | null; supportsVision: boolean;
  temperature: number; timeoutMs: number; isDefault: boolean;
  apiKeyMask: string; hasApiKey: boolean; updatedAt: string;
  lastTestAt: string | null; lastTestOk: boolean | null; lastTestError: string | null;
}

const items = ref<Provider[]>([]);
const canManage = ref(false);
const loading = ref(true);
const error = ref('');
const message = ref('');
const editing = ref<Record<string, any> | null>(null);
const saving = ref(false);
const testingId = ref('');
const testResult = ref<Record<string, any> | null>(null);
const busyId = ref('');

const protocols = [
  { value: 'openai', label: 'OpenAI Chat Completions' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
];

const errorText = (e: any) => ({
  NAME_REQUIRED: '请填写显示名称。',
  MODEL_REQUIRED: '请填写模型名称。',
  BASE_URL_REQUIRED: '请填写 API 地址。',
  BASE_URL_INVALID: 'API 地址需以 http:// 或 https:// 开头。',
  API_KEY_REQUIRED: '请填写 API 密钥。',
  NAME_DUPLICATED: '已有同名配置，请换一个名称。',
  PROTOCOL_INVALID: '接口协议不受支持。',
  FORBIDDEN: '没有维护模型配置的权限。',
  LLM_PROVIDER_NOT_FOUND: '配置已不存在，请刷新后重试。',
} as Record<string, string>)[String(e?.code ?? e?.message ?? e)] ?? '操作失败，请稍后重试。';

function emptyForm() {
  return { name: '', baseUrl: 'https://', apiKey: '', protocol: 'openai', model: '', contextWindow: 128000, maxOutputTokens: 4096, supportsVision: false, temperature: 0.2, timeoutMs: 60000, isDefault: items.value.length === 0 };
}

async function load() {
  loading.value = true; error.value = '';
  try {
    const data = await mockApi.listLlmProviders();
    items.value = data.items ?? [];
    canManage.value = !!data.canManage;
  } catch (e) { error.value = errorText(e); }
  finally { loading.value = false; }
}

function startCreate() { editing.value = emptyForm(); testResult.value = null; message.value = ''; }

function startEdit(item: Provider) {
  editing.value = {
    id: item.id, name: item.name, baseUrl: item.baseUrl, apiKey: '',
    protocol: item.protocol, model: item.model,
    contextWindow: item.contextWindow, maxOutputTokens: item.maxOutputTokens,
    supportsVision: item.supportsVision, temperature: item.temperature,
    timeoutMs: item.timeoutMs, isDefault: item.isDefault,
  };
  testResult.value = null; message.value = '';
}

function cancel() { editing.value = null; testResult.value = null; }

async function save() {
  const form = editing.value;
  if (!form || saving.value) return;
  saving.value = true; error.value = ''; message.value = '';
  try {
    const payload = {
      name: form.name, baseUrl: form.baseUrl, protocol: form.protocol, model: form.model,
      contextWindow: form.contextWindow === '' ? null : Number(form.contextWindow),
      maxOutputTokens: form.maxOutputTokens === '' ? null : Number(form.maxOutputTokens),
      supportsVision: !!form.supportsVision, temperature: Number(form.temperature),
      timeoutMs: Number(form.timeoutMs), isDefault: !!form.isDefault,
      ...(String(form.apiKey ?? '').trim() ? { apiKey: String(form.apiKey).trim() } : {}),
    };
    if (form.id) await mockApi.updateLlmProvider(form.id, payload);
    else await mockApi.createLlmProvider(payload);
    editing.value = null;
    message.value = '模型配置已保存。';
    await load();
  } catch (e) { error.value = errorText(e); }
  finally { saving.value = false; }
}

async function remove(item: Provider) {
  if (!window.confirm(`删除模型配置「${item.name}」？已生成的成长分析不受影响。`)) return;
  busyId.value = item.id; error.value = ''; message.value = '';
  try { await mockApi.deleteLlmProvider(item.id); message.value = '已删除。'; await load(); }
  catch (e) { error.value = errorText(e); }
  finally { busyId.value = ''; }
}

async function setDefault(item: Provider) {
  busyId.value = item.id; error.value = ''; message.value = '';
  try { await mockApi.setDefaultLlmProvider(item.id); message.value = `已把「${item.name}」设为默认模型。`; await load(); }
  catch (e) { error.value = errorText(e); }
  finally { busyId.value = ''; }
}

async function runTest(item: Provider) {
  testingId.value = item.id; testResult.value = null; error.value = '';
  try {
    const result = await mockApi.testLlmProvider(item.id);
    testResult.value = { id: item.id, ...result };
    await load();
  } catch (e) { error.value = errorText(e); }
  finally { testingId.value = ''; }
}

const statusText = (item: Provider) => {
  if (item.lastTestOk === true) return { label: '连接正常', tone: 'ok' };
  if (item.lastTestOk === false) return { label: '连接失败', tone: 'bad' };
  return { label: '尚未测试', tone: 'idle' };
};

const editorTitle = computed(() => (editing.value?.id ? '编辑模型配置' : '新增模型配置'));

onMounted(load);
</script>

<template>
 <div class="llm-settings">
  <div class="module-intro">
   <div>
    <h2>模型配置</h2>
    <p>配置月评「AI 成长分析」可用的大模型服务。支持 OpenAI Chat Completions 兼容接口与 Anthropic Messages 接口，密钥仅保存在本组织数据库内，页面只显示掩码。</p>
   </div>
   <button v-if="canManage" class="btn btn-primary" type="button" @click="startCreate">新增模型</button>
  </div>

  <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
  <p v-if="message" class="notice notice-success" role="status">{{ message }}</p>

  <section v-if="editing" class="card editor" aria-labelledby="llm-editor-title">
   <header class="editor-head"><h3 id="llm-editor-title">{{ editorTitle }}</h3><button class="link" type="button" @click="cancel">取消</button></header>
   <div class="grid">
    <label class="field"><span>显示名称</span><input v-model="editing.name" type="text" placeholder="例如：算力公社-DeepSeek" maxlength="40"></label>
    <label class="field"><span>API 密钥</span><input v-model="editing.apiKey" type="password" autocomplete="new-password" :placeholder="editing.id ? '留空则继续使用已保存的密钥' : 'sk-...'"></label>
    <label class="field wide"><span>API 地址</span><input v-model="editing.baseUrl" type="text" placeholder="https://example.com/v1" spellcheck="false"><small>填到版本号为止，不要带 /chat/completions。例如 <code>https://api.deepseek.com/v1</code>。</small></label>
    <label class="field"><span>API 协议</span><select v-model="editing.protocol"><option v-for="p in protocols" :key="p.value" :value="p.value">{{ p.label }}</option></select></label>
    <label class="field"><span>模型名称</span><input v-model="editing.model" type="text" placeholder="例如：deepseek-chat" spellcheck="false"></label>
    <label class="field"><span>上下文窗口（token）</span><input v-model="editing.contextWindow" type="number" min="1000" step="1000" placeholder="128000"></label>
    <label class="field"><span>最大输出 token</span><input v-model="editing.maxOutputTokens" type="number" min="256" step="256" placeholder="4096"></label>
    <label class="field"><span>温度</span><input v-model="editing.temperature" type="number" min="0" max="2" step="0.1" placeholder="0.2"><small>成长分析建议 0.2 左右，结果更稳定。</small></label>
    <label class="field"><span>超时（毫秒）</span><input v-model="editing.timeoutMs" type="number" min="5000" max="180000" step="1000" placeholder="60000"><small>推理型模型首包较慢，建议不低于 60000。</small></label>
    <div class="field"><span>输入类型</span><div class="checks"><label><input v-model="editing.supportsVision" type="checkbox">支持图片</label><label class="muted">文本始终支持</label></div></div>
    <div class="field"><span>默认模型</span><div class="checks"><label><input v-model="editing.isDefault" type="checkbox">设为默认（AI 成长分析使用该配置）</label></div></div>
   </div>
   <footer class="editor-foot"><button class="btn" type="button" @click="cancel">取消</button><button class="btn btn-primary" type="button" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button></footer>
  </section>

  <p v-if="loading" class="panel-state" role="status">正在读取模型配置…</p>
  <section v-else-if="!items.length" class="card empty">
   <h3>还没有配置模型</h3>
   <p>未配置时，月评结果仍会按规则计算并发布，但「AI 成长分析」不可用。配置一个默认模型后即可在结果页生成成长分析。</p>
   <button v-if="canManage" class="btn btn-primary" type="button" @click="startCreate">新增模型</button>
  </section>

  <template v-else>
  <section v-for="item in items" :key="item.id" class="card provider">
   <header class="provider-head">
    <div class="title-line">
     <h3>{{ item.name }}</h3>
     <span v-if="item.isDefault" class="tag tag-blue">默认</span>
     <span class="status" :class="statusText(item).tone"><i></i>{{ statusText(item).label }}</span>
    </div>
    <div class="row-actions">
     <button class="btn" type="button" :disabled="testingId === item.id || !canManage" @click="runTest(item)">{{ testingId === item.id ? '测试中…' : '测试连接' }}</button>
     <button v-if="canManage && !item.isDefault" class="btn" type="button" :disabled="busyId === item.id" @click="setDefault(item)">设为默认</button>
     <button v-if="canManage" class="btn" type="button" @click="startEdit(item)">编辑</button>
     <button v-if="canManage" class="btn btn-danger" type="button" :disabled="busyId === item.id" @click="remove(item)">删除</button>
    </div>
   </header>
   <dl class="meta">
    <div><dt>API 地址</dt><dd class="mono">{{ item.baseUrl }}</dd></div>
    <div><dt>接口协议</dt><dd>{{ protocols.find(p => p.value === item.protocol)?.label ?? item.protocol }}</dd></div>
    <div><dt>模型</dt><dd class="mono">{{ item.model }}</dd></div>
    <div><dt>密钥</dt><dd class="mono">{{ item.apiKeyMask || '未设置' }}</dd></div>
    <div><dt>上下文 / 输出</dt><dd>{{ item.contextWindow ? item.contextWindow.toLocaleString() : '—' }} / {{ item.maxOutputTokens ? item.maxOutputTokens.toLocaleString() : '—' }} token</dd></div>
    <div><dt>最近测试</dt><dd>{{ item.lastTestAt ? new Date(item.lastTestAt).toLocaleString('zh-CN') : '未测试' }}</dd></div>
   </dl>
   <p v-if="item.lastTestOk === false && item.lastTestError" class="test-error">最近一次测试失败：{{ item.lastTestError }}</p>
   <div v-if="testResult && testResult.id === item.id" class="test-result" :class="testResult.ok ? 'ok' : 'bad'">
    <template v-if="testResult.ok">
     <b>连接成功</b> · 耗时 {{ testResult.latencyMs }}ms<template v-if="testResult.sample"> · 返回：{{ testResult.sample }}</template>
    </template>
    <template v-else>
     <b>连接失败</b> · {{ testResult.error }}<template v-if="testResult.detail"> · {{ testResult.detail }}</template>
    </template>
   </div>
  </section>
  </template>

  <section class="card tips">
   <h3>配置说明</h3>
   <ul>
    <li>只有「默认模型」会被 AI 成长分析使用；切换默认会立即生效，无需重启服务。</li>
    <li>密钥保存后不再回显，编辑时留空表示沿用原密钥。</li>
    <li>推理型模型（如 DeepSeek-R1 / V4 系列）首包较慢，建议把超时设置为 60000 毫秒以上。</li>
    <li>测试连接会真实调用一次模型接口，少量消耗额度。</li>
   </ul>
  </section>
 </div>
</template>

<style scoped>
.llm-settings{min-width:0;display:grid;gap:16px}
.module-intro{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
.module-intro h2{margin:0 0 8px;font-size:18px;font-weight:600}
.module-intro p{margin:0;max-width:760px;color:#646a73;font-size:13px;line-height:22px}
.editor-head,.provider-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.editor-head h3,.provider-head h3,.empty h3,.tips h3{margin:0;font-size:15px;font-weight:600;line-height:24px}
.link{border:0;background:none;color:#3370ff;font:inherit;font-size:13px;cursor:pointer;padding:0}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px;margin:18px 0}
.field{display:flex;flex-direction:column;gap:6px;min-width:0}
.field.wide{grid-column:1/-1}
.field>span{font-size:13px;color:#4e5969}
.field small{color:#8a919f;font-size:12px;line-height:18px}
.field code{background:#f2f4f7;border-radius:3px;padding:1px 4px;font-size:12px}
.field input[type=text],.field input[type=password],.field input[type=number],.field select{width:100%}
.checks{display:flex;align-items:center;gap:16px;min-height:36px;font-size:13px;color:#4e5969}
.checks label{display:flex;align-items:center;gap:6px;cursor:pointer}
.checks .muted{color:#8a919f;cursor:default}
.editor-foot{display:flex;justify-content:flex-end;gap:10px;padding-top:14px;border-top:1px solid #eef0f3}
.title-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tag{border-radius:4px;padding:1px 7px;font-size:12px;line-height:20px}
.tag-blue{background:#eaf1ff;color:#3370ff}
.status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#646a73}
.status i{width:7px;height:7px;border-radius:50%;background:#c9cdd4;display:inline-block}
.status.ok i{background:#28a35b}.status.ok{color:#1f7a45}
.status.bad i{background:#e34d59}.status.bad{color:#b42318}
.row-actions{display:flex;gap:8px;flex-wrap:wrap}
.btn-danger{color:#b42318;border-color:#f4d1cd}
.btn-danger:hover:not(:disabled){background:#fff4f3;border-color:#efb4ae;color:#b42318}
.meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 20px;margin:16px 0 0;padding:14px 16px;background:#f8f9fb;border-radius:8px}
.meta div{min-width:0}
.meta dt{color:#8a919f;font-size:12px;margin-bottom:3px}
.meta dd{margin:0;color:#1f2329;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.test-error{margin:10px 0 0;color:#b42318;font-size:12px;line-height:20px}
.test-result{margin-top:12px;padding:10px 12px;border-radius:7px;font-size:13px;line-height:21px}
.test-result.ok{background:#eefaf2;color:#1f7a45;border:1px solid #d3f0de}
.test-result.bad{background:#fff4f3;color:#b42318;border:1px solid #f7dad7}
.empty{display:grid;gap:8px;justify-items:start}
.empty p{margin:0;color:#646a73;font-size:13px;line-height:22px}
.panel-state{text-align:center;color:#8a919f;font-size:13px;padding:28px 0}
.tips ul{margin:10px 0 0;padding-left:18px;color:#646a73;font-size:13px;line-height:24px}
@media(max-width:860px){.grid{grid-template-columns:1fr}.meta{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.meta{grid-template-columns:1fr}.module-intro{flex-direction:column}}
</style>
