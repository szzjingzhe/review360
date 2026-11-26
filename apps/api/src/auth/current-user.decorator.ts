import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from './session.guard';

export interface AuthContext {
  sessionIdHash: string;
  userId: string;
  orgId: string;
  displayName: string;
  isGuidance?: boolean;
  isResultViewer?: boolean;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.auth) throw new Error('CurrentUser 必须在 SessionGuard 之后使用');
    return req.auth;
  },
);
