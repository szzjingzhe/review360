<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { mockApi } from '../api';
import { managementRequest } from '../api/management';
import { useAuth } from '../stores/auth';

const query=new URLSearchParams(window.location.search);
const unlinked=query.get('admission')==='1'||['FEISHU_ACCOUNT_UNLINKED','FEISHU_IDENTITY_NOT_APPROVED'].includes(query.get('error')??'');
const error=ref(unlinked?'账号尚未关联，请联系管理员':query.get('error')??'');
const loginWithFeishu = () => { window.location.href = '/api/v1/auth/feishu/start'; };
const account = ref('');
const password = ref('');
const showPassword = ref(false);
const demoNotice = ref('');
const previewLogin = () => {
  demoNotice.value = '账号密码登录暂为界面演示，尚未接入认证。请使用飞书账号登录。';
};
const previewRegistration = () => { demoNotice.value = '注册账号尚未开放，请联系管理员。'; };
const previewRecovery = () => { demoNotice.value = '密码找回尚未开放，请联系管理员。'; };
const isLocalDemo = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);
const router = useRouter();
const auth = useAuth();
const setupAvailable = ref(false);
const setupToken = ref('');
const setupBusy = ref(false);
onMounted(async () => {
  try { setupAvailable.value = (await managementRequest<{available: boolean}>('auth/setup')).available; }
  catch { /* Setup status is optional on existing deployments. */ }
});
async function initialize() {
  setupBusy.value = true;
  error.value = '';
  try {
    await managementRequest('auth/setup', {token: setupToken.value.trim()});
    window.location.assign('/management/settings');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '初始化失败';
  } finally { setupBusy.value = false; }
}
const demoOpen = ref(false);
const demoLoading = ref(false);
const demoEntering = ref(false);
const demoUsers = ref<Awaited<ReturnType<typeof mockApi.listUsers>>>([]);
const demoUserId = ref('');
const demoError = ref('');

async function openLocalDemo() {
  demoOpen.value = !demoOpen.value;
  if (!demoOpen.value || demoUsers.value.length) return;
  demoLoading.value = true;
  demoError.value = '';
  try {
    const users = await mockApi.listDemoUsers();
    demoUsers.value = users;
    demoUserId.value = demoUsers.value[0]?.id ?? '';
    if (!demoUserId.value) demoError.value = '当前没有可演示的人员。';
  } catch {
    demoError.value = '本地人员演示暂不可用，请确认服务端已开启演示登录。';
  } finally { demoLoading.value = false; }
}

async function enterLocalDemo() {
  if (!isLocalDemo || demoEntering.value || !demoUsers.value.some(user => user.id === demoUserId.value)) return;
  demoEntering.value = true;
  demoError.value = '';
  try {
    await auth.login(demoUserId.value, 'personal');
    await router.replace('/');
  } catch {
    demoError.value = '演示登录失败，请稍后重试。';
  } finally { demoEntering.value = false; }
}
</script>

<template>
  <div class="login-page">
    <header class="login-heading">
      <h1>360° 月度环评系统</h1>
      <p>让每一份贡献，都被看见</p>
    </header>

    <section class="login-card" aria-labelledby="login-heading">
      <h2 id="login-heading">账号登录</h2>
      <p v-if="error" class="login-error">{{ error }}</p>
      <form class="account-form" @submit.prevent="previewLogin">
        <div class="login-field">
          <label for="login-account">账号</label>
          <input id="login-account" v-model="account" name="username" autocomplete="username" placeholder="请输入账号" required>
        </div>
        <div class="login-field">
          <label for="login-password">密码</label>
          <div class="password-field">
            <input id="login-password" v-model="password" name="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="请输入密码" required>
            <button class="password-toggle" type="button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" :aria-pressed="showPassword" @click="showPassword = !showPassword">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path v-if="showPassword" d="m4 3 16 18"/></svg>
            </button>
          </div>
        </div>
        <div class="account-actions">
          <button type="button" class="text-action" @click="previewRegistration">注册账号</button>
          <button type="button" class="text-action recovery-action" @click="previewRecovery">忘记密码？</button>
        </div>
        <button class="account-login" type="submit">登录</button>
      </form>
      <p v-if="demoNotice" class="demo-notice" role="status">{{ demoNotice }}</p>
      <div class="login-divider"><span>其他登录方式</span></div>
      <button class="feishu" type="button" @click="loginWithFeishu">
        <span class="feishu-icon" aria-hidden="true">L</span>
        使用飞书账号登录
      </button>
      <form v-if="setupAvailable" class="local-demo local-demo-panel" @submit.prevent="initialize">
        <label for="setup-token">首次部署初始化令牌</label>
        <input id="setup-token" v-model="setupToken" type="password" autocomplete="off" required>
        <button class="demo-enter" :disabled="setupBusy">进入管理员设置</button>
      </form>
      <div v-if="isLocalDemo" class="local-demo">
        <button class="local-demo-toggle" type="button" :aria-expanded="demoOpen" aria-controls="local-demo-panel" @click="openLocalDemo">本地人员演示 <span aria-hidden="true">{{ demoOpen ? '−' : '+' }}</span></button>
        <div v-if="demoOpen" id="local-demo-panel" class="local-demo-panel">
          <p v-if="demoLoading" role="status">正在加载人员…</p>
          <template v-else-if="demoUsers.length">
            <label for="demo-person">演示人员（沿用实际权限）</label>
            <select id="demo-person" v-model="demoUserId" :disabled="demoEntering">
              <option v-for="person in demoUsers" :key="person.id" :value="person.id">{{ person.displayName }}{{ person.deptName ? ` · ${person.deptName}` : '' }}{{ person.roles.includes('HEAD') ? ' · 部长（三端）' : '' }}</option>
            </select>
            <button class="demo-enter" type="button" :disabled="demoEntering" @click="enterLocalDemo">{{ demoEntering ? '正在进入…' : '进入人员演示' }}</button>
          </template>
          <p v-if="demoError" class="demo-error" role="alert">{{ demoError }}</p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Scope the application gutter reset to this login view only. */
:global(.content:has(> .login-page)) {
  max-width: none;
  margin: 0;
  padding: 0;
}

.login-page {
  min-height: 100vh;
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: clamp(64px, 11vh, 120px) 24px 48px;
  color: #142b50;
  background-color: #93d5f8;
  background-image: linear-gradient(135deg, #eaf2ff, #f6f9ff 65%, #e5f2fb);
  background-repeat: no-repeat;
  background-position: center center;
  background-size: cover;
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.login-heading {
  width: 100%;
  margin-bottom: 34px;
  text-align: center;
}

.login-heading h1 {
  margin: 0;
  font-size: 32px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: .015em;
  color: #112f59;
}

.login-heading p {
  margin: 12px 0 0;
  color: #315d89;
  font-size: 16px;
  font-weight: 400;
  line-height: 1.75;
  letter-spacing: .18em;
}

.login-card {
  width: 420px;
  max-width: 100%;
  padding: 32px;
  border: 1px solid rgba(255, 255, 255, .75);
  border-radius: 16px;
  background: rgba(255, 255, 255, .97);
  box-shadow: 0 14px 40px rgba(28, 74, 125, .12), 0 2px 6px rgba(28, 74, 125, .04);
}

.login-card h2 {
  margin: 0 0 24px;
  color: #15243d;
  font-size: 20px;
  font-weight: 650;
  line-height: 1.5;
}

.account-form { display: grid; gap: 20px; }
.login-field label { display: block; margin-bottom: 8px; color: #293c58; font-size: 14px; line-height: 20px; }
.login-field input { width: 100%; height: 44px; padding: 10px 14px; border: 1px solid #d4dce9; border-radius: 10px; background: #fff; color: #203756; font: inherit; font-size: 14px; line-height: 22px; box-shadow: none; }
.login-field input::placeholder { color: #9aa3b2; }
.login-field input:focus { outline: none; border-color: #246bfd; box-shadow: 0 0 0 3px rgba(36, 107, 253, .1); }
.password-field { position: relative; }
.password-field input { padding-right: 48px; }
.password-toggle { position: absolute; top: 1px; right: 2px; display: grid; place-items: center; width: 42px; height: 42px; padding: 0; border: 0; border-radius: 8px; color: #7f8ba0; background: transparent; cursor: pointer; }
.password-toggle:hover { color: #246bfd; }
.password-toggle svg { width: 19px; height: 19px; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.account-actions { display: flex; align-items: center; justify-content: space-between; margin-top: -4px; }
.text-action { padding: 0; border: 0; background: transparent; color: #246bfd; font-family: inherit; font-size: 14px; line-height: 22px; cursor: pointer; }
.recovery-action { color: #54647c; }
.text-action:hover { text-decoration: underline; }
.account-login { min-height: 44px; padding: 10px 16px; border: 1px solid transparent; border-radius: 10px; background: #246bfd; color: #fff; font-family: inherit; font-size: 15px; line-height: 22px; cursor: pointer; }
.account-login:hover { background: #185be1; }
.account-login:active { background: #124dc6; }
.account-login:focus-visible, .text-action:focus-visible, .password-toggle:focus-visible { outline: 2px solid #246bfd; outline-offset: 3px; }
.login-divider { display: flex; align-items: center; gap: 12px; margin: 22px 0; color: #8b95a5; font-size: 12px; line-height: 20px; white-space: nowrap; }
.login-divider::before, .login-divider::after { content: ''; height: 1px; flex: 1; background: #e0e5ed; }
.demo-notice { margin: 16px 0 0; padding: 10px 12px; border-radius: 8px; background: #eef4ff; color: #42618f; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.local-demo { margin-top: 18px; border-top: 1px solid #e4e9f1; padding-top: 14px; }
.local-demo-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 0; border: 0; background: transparent; color: #6a7d98; font: inherit; font-size: 12px; line-height: 22px; cursor: pointer; }
.local-demo-toggle:hover { color: #246bfd; }
.local-demo-toggle:focus-visible, .demo-enter:focus-visible { outline: 2px solid #246bfd; outline-offset: 3px; }
.local-demo-panel { margin-top: 14px; padding: 14px; border-radius: 8px; background: #f3f7fd; }
.local-demo-panel p { margin: 0 0 12px; color: #71819a; font-size: 12px; line-height: 1.7; }
.local-demo-panel label { font-size: 12px; }
.local-demo-panel select { height: 38px; border-color: #d4dce9; border-radius: 8px; }
.demo-enter { width: 100%; margin-top: 12px; min-height: 36px; border: 1px solid #c5d6f5; border-radius: 7px; background: #fff; color: #246bfd; font: inherit; font-size: 13px; cursor: pointer; }
.demo-enter:disabled { opacity: .65; cursor: wait; }
.local-demo-panel .demo-error { margin: 10px 0 0; color: #bf3931; }

.login-description {
  margin: 12px 0 28px;
  color: #778296;
  font-size: 14px;
  line-height: 1.8;
}

.feishu {
  width: 100%;
  min-height: 48px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 10px;
  padding: 11px 16px;
  border: 1px solid #cdd8e9;
  border-radius: 10px;
  background: #fff;
  color: #203756;
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  line-height: 24px;
  cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease;
}

.feishu:hover { border-color: #246bfd; background: #f5f8ff; }
.feishu:active { background: #edf3ff; }
.feishu:focus-visible { outline: 3px solid #246bfd; outline-offset: 3px; }

.feishu-icon {
  width: 23px;
  height: 23px;
  display: grid;
  place-items: center;
  flex: 0 0 23px;
  border-radius: 6px;
  background: #246bfd;
  color: #fff;
  font: 700 15px/1 Arial, sans-serif;
}

.login-note {
  margin: 24px 0 0;
  color: #8b95a5;
  font-size: 12px;
  line-height: 1.8;
  text-align: center;
}

.login-error {
  margin: 0 0 20px;
  padding: 10px 12px;
  border: 1px solid #f1d2cf;
  border-radius: 8px;
  background: #fff4f3;
  color: #bf3931;
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

@media (max-height: 820px) and (min-width: 601px) {
  .login-page { padding-top: 56px; padding-bottom: 32px; }
  .login-heading { margin-bottom: 26px; }
  .login-heading p { margin-top: 8px; }
  .login-card { padding: 28px 32px; }
  .login-card h2 { margin-bottom: 20px; }
  .account-form { gap: 16px; }
  .login-divider { margin-block: 18px; }
}

@media (max-width: 600px) {
  .login-page { padding: 64px 20px 36px; background-position: 50% center; }
  .login-heading { margin-bottom: 28px; }
  .login-heading h1 { font-size: 27px; letter-spacing: 0; }
  .login-heading p { font-size: 14px; letter-spacing: .1em; }
  .login-card { padding: 28px 24px; }
}

@media (max-width: 360px) {
  .login-page { padding-inline: 16px; }
  .login-heading h1 { font-size: 24px; }
  .login-card { padding-inline: 22px; }
}

@media (prefers-reduced-motion: reduce) { .feishu { transition: none; } }
</style>
