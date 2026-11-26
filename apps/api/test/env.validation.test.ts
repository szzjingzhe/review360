import { describe, expect, it } from 'vitest';
import { EnvValidationError, validateEnv } from '../src/config/env.validation';

const BASE = {
  APP_ENV: 'development',
  APP_ORIGIN: 'http://localhost:5173',
  ORG_TIMEZONE: 'Asia/Shanghai',
  DEMO_LOGIN_ENABLED: 'true',
  DATABASE_URL: 'postgres://review360:review360_dev@localhost:5432/review360',
  SESSION_SECRET: 'dev-secret-not-used-in-production-000',
};

describe('validateEnv', () => {
  it('HTTP production login requires an explicit matching origin exception',()=>{
    const prod={...BASE,APP_ENV:'production',DEMO_LOGIN_ENABLED:'false',APP_ORIGIN:'http://81.70.191.136',FEISHU_REDIRECT_URI:'http://81.70.191.136/api/v1/auth/feishu/callback',FEISHU_APP_ID:'app',FEISHU_APP_SECRET:'secret',FEISHU_TENANT_KEY:'tenant',FEISHU_ORG_ID:'11111111-1111-4111-8111-111111111111'};
    expect(()=>validateEnv(prod)).toThrow(/HTTPS/);
    expect(validateEnv({...prod,ALLOW_INSECURE_HTTP_ORIGIN:prod.APP_ORIGIN}).APP_ENV).toBe('production');
    expect(()=>validateEnv({...prod,ALLOW_INSECURE_HTTP_ORIGIN:'http://other.example'})).toThrow(/exception/);
    expect(()=>validateEnv({...prod,ALLOW_INSECURE_HTTP_ORIGIN:prod.APP_ORIGIN,FEISHU_REDIRECT_URI:'http://other.example/callback'})).toThrow(/exception/);
  });
  it('通过：开发环境合法配置', () => {
    const config = validateEnv(BASE);
    expect(config.APP_ENV).toBe('development');
    expect(config.FEISHU_APP_ID).toBe('');
  });

  it('拒绝：缺失必填变量时抛出并列出变量名', () => {
    const broken = { ...BASE } as Record<string, string | undefined>;
    delete broken.DATABASE_URL;
    expect(() => validateEnv(broken)).toThrowError(EnvValidationError);
    expect(() => validateEnv(broken)).toThrowError(/DATABASE_URL/);
  });

  it('拒绝：生产环境开启演示登录（技术文档 4.1）', () => {
    expect(() => validateEnv({ ...BASE, APP_ENV: 'production', DEMO_LOGIN_ENABLED: 'true' })).toThrowError(
      /DEMO_LOGIN_ENABLED/,
    );
  });

  it('拒绝：生产环境使用默认或过短的 SESSION_SECRET（技术文档 14.2）', () => {
    const prod = { ...BASE, APP_ENV: 'production', DEMO_LOGIN_ENABLED: 'false' };
    expect(() => validateEnv({ ...prod, SESSION_SECRET: 'change-me' })).toThrowError(/SESSION_SECRET/);
    expect(() => validateEnv({ ...prod, SESSION_SECRET: 'short' })).toThrowError(/SESSION_SECRET/);
  });

  it('通过：生产环境合法配置', () => {
    const config = validateEnv({
      ...BASE,
      APP_ENV: 'production',
      DEMO_LOGIN_ENABLED: 'false',
      SESSION_SECRET: 'a'.repeat(48),
    });
    expect(config.APP_ENV).toBe('production');
  });
});
