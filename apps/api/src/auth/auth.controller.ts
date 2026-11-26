import { FeishuAdmissionService, FEISHU_STATE_COOKIE, FEISHU_ADMISSION_COOKIE } from './feishu-admission.service';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Param,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Pool } from 'pg';
import { SessionService, SESSION_COOKIE } from './session.service';
import { SessionGuard, AuthedRequest } from './session.guard';
import { CurrentUser, AuthContext } from './current-user.decorator';
import { PolicyService } from '../authz/policy.service';
import { FeishuService } from './feishu.service';
import { CapabilityGuard, RequireCapabilities } from '../authz/capability.guard';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller()
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
    @Inject('DATABASE_POOL') private readonly db: Pool,
    private readonly policy: PolicyService,
    private readonly feishu: FeishuService,
    private readonly admission: FeishuAdmissionService,
  ) {}

  @Get('auth/feishu/start')
  feishuStart(@Res({ passthrough: true }) res: Response) {
    if (!this.feishu.enabled()) throw new ForbiddenException({ code: 'FEISHU_NOT_CONFIGURED' });
    const state = this.admission.issueState();
    res.cookie(FEISHU_STATE_COOKIE,state,this.admission.cookieOptions(true));
    res.redirect(this.feishu.authorizeUrl(state));
  }

  @Get('auth/feishu/callback')
  async feishuCallback(@Req() req: Request, @Res() res: Response) {
    const state=typeof req.query.state==='string'?req.query.state:'';
    const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(FEISHU_STATE_COOKIE+'='))?.slice(FEISHU_STATE_COOKIE.length+1)??'';
    res.clearCookie(FEISHU_STATE_COOKIE,this.admission.cookieOptions(true));
    try { this.admission.consumeState(state,cookie); }
    catch { return this.admission.deny('FEISHU_STATE_INVALID'); }
    const code=typeof req.query.code==='string'?req.query.code:'';
    if(!code)return this.admission.deny('FEISHU_CODE_MISSING');
    let identity:Record<string,unknown>;
    try { identity=await this.feishu.exchange(code); }
    catch { return this.admission.deny('FEISHU_EXCHANGE_FAILED'); }
    let token:string;
    try { token=await this.admission.login(identity,req.headers['user-agent']); }
    catch(error) {
      const reason=error instanceof UnauthorizedException?error.getResponse():null;
      if(!reason||typeof reason!=='object'||(reason as {code?:string}).code!=='FEISHU_IDENTITY_NOT_APPROVED')throw error;
      // Unknown identities never create applications, accounts or sessions.
      res.clearCookie(SESSION_COOKIE,this.admission.cookieOptions());
      res.clearCookie(FEISHU_ADMISSION_COOKIE,this.admission.cookieOptions(true));
      res.setHeader('Cache-Control','no-store');
      return res.redirect('/login?error=FEISHU_ACCOUNT_UNLINKED');
    }
    res.clearCookie(FEISHU_ADMISSION_COOKIE,this.admission.cookieOptions(true));
    res.cookie(SESSION_COOKIE,token,this.admission.cookieOptions());
    return res.redirect('/');
  }

  @Get('auth/feishu/bindings')
  @UseGuards(SessionGuard,CapabilityGuard)
  @RequireCapabilities('org.manage')
  async listBindings(@CurrentUser() actor:AuthContext) {return {data:await this.admission.listBindings(actor)};}

  @Post('auth/feishu/bindings')
  @UseGuards(SessionGuard,CapabilityGuard)
  @RequireCapabilities('org.manage')
  async bindFeishu(@CurrentUser() actor:AuthContext,@Body() body:{user_id?:unknown;external_id?:unknown;reason?:unknown}) {
    return {data:await this.admission.bind(actor,body)};
  }

  @Post('auth/feishu/bindings/:id/revoke')
  @UseGuards(SessionGuard,CapabilityGuard)
  @RequireCapabilities('org.manage')
  @HttpCode(200)
  async revokeFeishu(@CurrentUser() actor:AuthContext,@Param('id') id:string) {
    return {data:await this.admission.revoke(actor,id)};
  }

  @Post('integrations/feishu/sync')
  @UseGuards(SessionGuard, CapabilityGuard)
  @RequireCapabilities('org.manage')
  async feishuSync(@CurrentUser() user: AuthContext) { return { data: await this.feishu.sync(user.orgId) }; }

  /**
   * 受限测试登录：仅 DEMO_LOGIN_ENABLED=true 且非生产环境可用。
   * 启动时 env 校验已拒绝生产+演示组合，这里做运行期双保险。
   */
  @Post('auth/demo-login')
  @HttpCode(200)
  async demoLogin(
    @Body() body: { user_id?: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const demoEnabled = this.config.get('DEMO_LOGIN_ENABLED') === 'true';
    const env = this.config.get('APP_ENV');
    if (!demoEnabled || env === 'production' || process.env.NODE_ENV === 'production') {
      throw new ForbiddenException({ code: 'DEMO_LOGIN_DISABLED' });
    }

    const userId = typeof body?.user_id === 'string' ? body.user_id : '';
    if (!UUID_RE.test(userId)) {
      throw new UnauthorizedException({ code: 'USER_NOT_FOUND' });
    }

    const { rows } = await this.db.query(
      `SELECT id, org_id, display_name FROM users WHERE id = $1 AND status = 'ACTIVE'`,
      [userId],
    );
    const user = rows[0];
    if (!user) throw new UnauthorizedException({ code: 'USER_NOT_FOUND' });

    const token = await this.sessions.createSession(
      user.id,
      user.org_id,
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    );
    await this.sessions.writeAudit(user.id, user.org_id, 'AUTH_DEMO_LOGIN', 'user', user.id);

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env === 'production',
      path: '/api/v1',
      maxAge: 12 * 60 * 60 * 1000,
    });
    return {
      data: { user_id: user.id, display_name: user.display_name, org_id: user.org_id },
    };
  }

  /**
   * 受限演示用户列表：仅 DEMO_LOGIN_ENABLED=true 且非生产可用。
   * 供登录页在「未登录」时按端口选择身份（/organization 需登录，故单独开此只读端点）。
   * 同时返回 roles / capabilities，供前端按端口过滤（个人端/部门端/监管端）并在登录前校验可进入性。
   */
  @Get('auth/demo-users')
  async demoUsers() {
    const demoEnabled = this.config.get('DEMO_LOGIN_ENABLED') === 'true';
    const env = this.config.get('APP_ENV');
    if (!demoEnabled || env === 'production' || process.env.NODE_ENV === 'production') {
      throw new ForbiddenException({ code: 'DEMO_LOGIN_DISABLED' });
    }
    const { rows } = await this.db.query(
      `SELECT u.id, u.display_name, u.org_id, d.name AS dept_name,
              COALESCE(ap.roles, ARRAY[]::text[]) AS roles,
              COALESCE(cg.capabilities, ARRAY[]::text[]) AS capabilities
         FROM users u
         LEFT JOIN LATERAL (
           SELECT array_agg(a.role) AS roles
             FROM appointments a
            WHERE a.user_id = u.id AND a.valid_to IS NULL
         ) ap ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT g.capability) AS capabilities
             FROM effective_capability_grants g
            WHERE g.user_id = u.id AND g.revoked_at IS NULL
         ) cg ON true
         LEFT JOIN department_memberships m ON m.user_id = u.id AND m.valid_to IS NULL
         LEFT JOIN departments d ON d.id = m.department_id
        WHERE u.status = 'ACTIVE'
        ORDER BY d.name NULLS LAST, u.display_name
        LIMIT 60`,
    );
    return { data: rows };
  }

  @Post('auth/logout')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async logout(
    @CurrentUser() user: AuthContext,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = (req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    if (token) {
      await this.sessions.revokeSession(token);
      await this.sessions.writeAudit(
        user.userId,
        user.orgId,
        'AUTH_LOGOUT',
        'session',
        user.sessionIdHash,
      );
    }
    res.clearCookie(SESSION_COOKIE, this.admission.cookieOptions());
    return { data: { ok: true } };
  }

  /** GET /me：当前用户、部门、任命与有效能力（技术文档 11 API 契约） */
  @Get('me')
  @UseGuards(SessionGuard)
  async me(@CurrentUser() user: AuthContext) {
    const { rows: deptRows } = await this.db.query(
      `SELECT d.id AS dept_id, d.code AS dept_code, d.name AS dept_name
       FROM department_memberships m
       JOIN departments d ON d.id = m.department_id
       WHERE m.user_id = $1 AND m.valid_to IS NULL`,
      [user.userId],
    );
    const { rows: appointmentRows } = await this.db.query(
      `SELECT role, scope_dept_id FROM appointments WHERE user_id = $1 AND valid_from<=CURRENT_DATE AND (valid_to IS NULL OR valid_to>CURRENT_DATE) AND role <> 'HRPB'`,
      [user.userId],
    );
    const capabilities = await this.policy.listCapabilities(user.userId, user.orgId);
    return {
      data: {
        user: { id: user.userId, display_name: user.displayName, org_id: user.orgId },
        department: deptRows[0] ?? null,
        isGuidance: user.isGuidance === true,
        isResultViewer: user.isResultViewer === true,
        appointments: appointmentRows,
        capabilities,
      },
    };
  }
}
