export interface AppConfig {
  GROWTH_AI_BASE_URL: string;
  GROWTH_AI_MODEL: string;
  GROWTH_AI_API_KEY: string;
  ALLOW_INSECURE_HTTP_ORIGIN: string;
  APP_ENV: string;
  APP_ORIGIN: string;
  ORG_TIMEZONE: string;
  DEMO_LOGIN_ENABLED: string;
  DATABASE_URL: string;
  SESSION_SECRET: string;
  STORAGE_ENDPOINT: string;
  STORAGE_BUCKET: string;
  STORAGE_ACCESS_KEY: string;
  STORAGE_SECRET_KEY: string;
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  FEISHU_REDIRECT_URI: string;
  FEISHU_TENANT_KEY: string;
  FEISHU_ORG_ID: string;
}

const REQUIRED_KEYS = [
  'APP_ENV',
  'APP_ORIGIN',
  'ORG_TIMEZONE',
  'DEMO_LOGIN_ENABLED',
  'DATABASE_URL',
  'SESSION_SECRET',
] as const;

export class EnvValidationError extends Error {}

/** Explicit deployment exception, bound to one exact HTTP origin and callback origin. */
export function insecureHttpApproved(env:Record<string,string|undefined>):boolean {
  try {
    const origin=env.APP_ORIGIN,approved=env.ALLOW_INSECURE_HTTP_ORIGIN;
    if(!origin||!approved||origin!==approved)return false;
    const app=new URL(origin),callback=new URL(env.FEISHU_REDIRECT_URI??'');
    return app.protocol==='http:'&&app.origin===origin&&callback.origin===origin;
  }catch{return false;}
}

/**
 * 启动期环境校验（技术文档 14.2）：
 * - 必填变量缺失：拒绝启动
 * - 生产环境禁止开启演示登录（DEMO_LOGIN_ENABLED=true）
 * - 生产环境禁止默认/弱 SESSION_SECRET
 * 未启用的模块变量（STORAGE_*、FEISHU_*）允许为空，后续里程碑按阶段加严。
 */
export function validateEnv(raw: Record<string, unknown>): AppConfig {
  const env = raw as Record<string, string | undefined>;

  const missing = REQUIRED_KEYS.filter((key) => !env[key] || env[key]!.trim() === '');
  if (missing.length > 0) {
    throw new EnvValidationError(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const isProduction = env.APP_ENV === 'production';
  if(env.ALLOW_INSECURE_HTTP_ORIGIN&&!insecureHttpApproved(env))throw new EnvValidationError('HTTP exception must match the exact web and Feishu callback origin');

  if (isProduction && env.DEMO_LOGIN_ENABLED === 'true') {
    throw new EnvValidationError(
      'DEMO_LOGIN_ENABLED must not be true in production (refuse to boot)',
    );
  }

  if (isProduction) {
    const secret = env.SESSION_SECRET!;
    if (secret.length < 32 || /change[-_ ]?me/i.test(secret)) {
      throw new EnvValidationError(
        'SESSION_SECRET must be a strong random value (>= 32 chars) in production',
      );
    }
  }

  if (env.FEISHU_APP_ID || env.FEISHU_APP_SECRET) {
    if(!env.FEISHU_APP_ID||!env.FEISHU_APP_SECRET||!env.FEISHU_REDIRECT_URI||!env.FEISHU_TENANT_KEY||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(env.FEISHU_ORG_ID??''))
      throw new EnvValidationError('Feishu requires explicit tenant, organization and application configuration');
    if(isProduction&&!insecureHttpApproved(env)&&(!env.FEISHU_REDIRECT_URI.startsWith('https://')||!env.APP_ORIGIN!.startsWith('https://')))
      throw new EnvValidationError('Production Feishu and web origins must use HTTPS');
  }
  return {
    GROWTH_AI_BASE_URL: env.GROWTH_AI_BASE_URL ?? '',
    GROWTH_AI_MODEL: env.GROWTH_AI_MODEL ?? '',
    GROWTH_AI_API_KEY: env.GROWTH_AI_API_KEY ?? '',
    ALLOW_INSECURE_HTTP_ORIGIN: env.ALLOW_INSECURE_HTTP_ORIGIN??'',
    APP_ENV: env.APP_ENV!,
    APP_ORIGIN: env.APP_ORIGIN!,
    ORG_TIMEZONE: env.ORG_TIMEZONE!,
    DEMO_LOGIN_ENABLED: env.DEMO_LOGIN_ENABLED!,
    DATABASE_URL: env.DATABASE_URL!,
    SESSION_SECRET: env.SESSION_SECRET!,
    STORAGE_ENDPOINT: env.STORAGE_ENDPOINT ?? '',
    STORAGE_BUCKET: env.STORAGE_BUCKET ?? '',
    STORAGE_ACCESS_KEY: env.STORAGE_ACCESS_KEY ?? '',
    STORAGE_SECRET_KEY: env.STORAGE_SECRET_KEY ?? '',
    FEISHU_APP_ID: env.FEISHU_APP_ID ?? '',
    FEISHU_APP_SECRET: env.FEISHU_APP_SECRET ?? '',
    FEISHU_REDIRECT_URI: env.FEISHU_REDIRECT_URI ?? '',
    FEISHU_TENANT_KEY: env.FEISHU_TENANT_KEY ?? '',
    FEISHU_ORG_ID: env.FEISHU_ORG_ID ?? '',
  };
}
