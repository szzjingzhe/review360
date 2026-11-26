import {
  CanActivate,
  ForbiddenException,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SessionService, SESSION_COOKIE } from './session.service';

export interface AuthedRequest extends Request {
  auth?: {
    sessionIdHash: string;
    userId: string;
    orgId: string;
    displayName: string;
    isGuidance?: boolean;
    isResultViewer?: boolean;
    /** 拥有 management.access：指导组身份也不再被只读白名单限制 */
    isManager?: boolean;
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      // 同名 Cookie 以第一个为准：浏览器按路径长度降序发送，首个即最具体路径下的会话
      if (key && !(key in out)) {
        try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
      }
    }
  }
  return out;
}

/**
 * 会话守卫：从 HttpOnly Cookie 解析会话，校验有效性与用户状态。
 * 无效/缺失一律 401，不做匿名放行。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) {
      // 诊断：POST 丢失凭证时记录请求特征，便于区分浏览器未发送与代理丢弃
      console.warn('[auth:missing-cookie] ' + JSON.stringify({
        method: req.method,
        url: req.originalUrl,
        cookieHeader: req.headers.cookie ? `len=${req.headers.cookie.length}` : 'absent',
        origin: req.headers.origin ?? null,
        referer: req.headers.referer ?? null,
        ua: (req.headers['user-agent'] ?? '').slice(0, 48),
        proto: req.headers['x-forwarded-proto'] ?? null,
      }));
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED' });
    }

    const session = await this.sessions.resolveSession(token);
    if (!session) throw new UnauthorizedException({ code: 'SESSION_INVALID' });

    if(session.isResultViewer&&!resultViewerRequestAllowed(req.method,req.path))throw new ForbiddenException({code:'RESULT_VIEWER_READ_ONLY'});
    // 指导组默认只读；若该账号已被显式授予管理端入口（management.access），按常规能力授权放行，
    // 这样「业务管理员」可以跨指导组身份使用管理端，撤销授权后自动回到只读。
    if (session.isGuidance && !session.isManager && !guidanceRequestAllowed(req.method, req.path)) {
      throw new ForbiddenException({ code: 'GUIDANCE_READ_ONLY' });
    }
    req.auth = {
      sessionIdHash: session.sessionIdHash,
      userId: session.userId,
      orgId: session.orgId,
      displayName: session.displayName,
      isGuidance: session.isGuidance,
      isResultViewer: session.isResultViewer,
      isManager: session.isManager,
    };

    // 会话即将过期时不续期，前端依赖 401 重新登录
    res.setHeader('Cache-Control', 'no-store');
    return true;
  }
}

export function resultViewerRequestAllowed(method:string,path:string):boolean {
 const p=path.replace(/\/+$/,'');
 return method==='GET'&&['/api/v1/me','/api/v1/published-results'].includes(p)||method==='POST'&&p==='/api/v1/auth/logout';
}

/** Guidance members can only read the directory and published, scoped results. */
export function guidanceRequestAllowed(method: string, path: string): boolean {
  const p=path.replace(/\/+$/, '');
  return method==='GET' && ['/api/v1/me','/api/v1/organization','/api/v1/organization/members','/api/v1/published-results'].includes(p)
    || method==='POST' && p==='/api/v1/auth/logout';
}
