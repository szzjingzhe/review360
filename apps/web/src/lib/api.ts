/**
 * 简易 fetch 包装：统一注入 cookie、统一解析响应。
 * 不引入 axios，避免锁版本。
 */
export interface ApiError { code?: string; status: number; message?: string }

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: { data?: T; code?: string; message?: string } | null = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err: ApiError = { status: res.status, code: json?.code, message: json?.message };
    throw err;
  }
  return (json?.data ?? (json as unknown as T)) as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
};
