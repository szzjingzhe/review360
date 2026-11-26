/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'true' 时前端走内置 mock（内存数据）；'false' 时走真实后端 /api/v1 */
  readonly VITE_USE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
