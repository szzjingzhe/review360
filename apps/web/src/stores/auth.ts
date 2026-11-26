import { defineStore } from 'pinia';
import { ref } from 'vue';
import { mockApi, type MockApi } from '../api';
import type { User } from '../mock/data.js';
import { defaultHome, type WorkspaceKey } from '../lib/workspaces';

const PICKED_KEY = 's360_port_picked';
const PORT_KEY = 's360_port';

function canUseStorage() {
  return typeof sessionStorage !== 'undefined';
}

/**
 * 会话与当前用户状态。
 * - 登录页先选「端口」（个人端 / 部门端 / 监管端）再选身份，picked 标记本次会话已选端口。
 * - mock 模式：login 在演示用户列表中切换。
 * - 真实后端模式：login 走 demo-login 建立会话，whoami 读取 /me（未登录返回 401）。
 */
export const useAuth = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const ready = ref(false);
  const picked = ref(canUseStorage() && sessionStorage.getItem(PICKED_KEY) === '1');
  const port = ref<WorkspaceKey | null>(
    (canUseStorage() ? (sessionStorage.getItem(PORT_KEY) as WorkspaceKey | null) : null) ?? null,
  );

  async function init(): Promise<void> {
    if (ready.value) return;
    try {
      user.value = await mockApi.whoami();
      // OAuth callbacks establish the HttpOnly server session, but do not run
      // the demo login flow that normally records the selected workspace.
      // Treat an authenticated OAuth user as a personal-workspace user by
      // default so the router can complete the redirect to the application.
      if (user.value) {
        const landing = defaultHome({ capabilities: user.value.capabilities, roles: user.value.roles, isResultViewer:user.value.isResultViewer, isGuidance:user.value.isGuidance });
        picked.value = true;
        port.value = landing.port;
        try {
          sessionStorage.setItem(PICKED_KEY, '1');
          sessionStorage.setItem(PORT_KEY, landing.port);
        } catch {
          /* 无 storage 环境忽略 */
        }
      }
    } catch {
      user.value = null; // 真实后端未登录（401）等，交由路由守卫跳登录页
    } finally {
      ready.value = true;
    }
  }

  async function login(userId: string, chosenPort: WorkspaceKey): Promise<void> {
    user.value = await mockApi.loginAs(userId);
    ready.value = true;
    picked.value = true;
    port.value = chosenPort;
    try {
      sessionStorage.setItem(PICKED_KEY, '1');
      sessionStorage.setItem(PORT_KEY, chosenPort);
    } catch {
      /* 无 storage 环境忽略 */
    }
  }

  function hasCapability(cap: string): boolean {
    return !!user.value?.capabilities.includes(cap);
  }

  async function logout(): Promise<void> {
    // Revoke the HttpOnly server session before clearing the local workspace state.
    try {
      await mockApi.logout();
    } catch {
      // Clear local state even when the session already expired or the API is unavailable.
    }
    user.value = null;
    picked.value = false;
    port.value = null;
    try {
      sessionStorage.removeItem(PICKED_KEY);
      sessionStorage.removeItem(PORT_KEY);
    } catch {
      /* ignore */
    }
  }

  return { user, ready, picked, port, init, login, logout, hasCapability };
});

export type { MockApi, User };
