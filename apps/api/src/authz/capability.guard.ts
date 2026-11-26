import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Capability, isCapability } from './capabilities';
import { PolicyService } from './policy.service';
import type { AuthedRequest } from '../auth/session.guard';

export const CAPABILITY_RESOURCE = 'capability_resource';
export const CapabilityResource = (kind: 'cycle'|'build'|'case'|'feedback'|'collection'|'department'|'participant', param = 'id') => SetMetadata(CAPABILITY_RESOURCE, {kind,param});

export const REQUIRE_CAPABILITIES = 'require_capabilities';

/** 路由级能力要求；全部满足才放行（对象范围仍需 policy 在服务层校验） */
export const RequireCapabilities = (...caps: Capability[]) =>
  SetMetadata(REQUIRE_CAPABILITIES, caps);

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: PolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Capability[]>(
      REQUIRE_CAPABILITIES,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.auth) throw new ForbiddenException({ code: 'UNAUTHENTICATED' });

    try {
    for (const cap of required) {
      if (!isCapability(cap)) throw new ForbiddenException({code:'FORBIDDEN'});
      const resource=this.reflector.getAllAndOverride<{kind:string;param:string}>(CAPABILITY_RESOURCE,[context.getHandler(),context.getClass()]);
      if(resource?.kind==='participant'){await this.policy.assertParticipant(req.auth,cap,req.body?.cycleId,req.body?.targetId);continue;}
      if (resource && resource.kind !== 'collection') {
        const params=(req.params ?? {}) as Record<string,string>;
        await this.policy.assertResource(req.auth,cap,resource.kind==='department'?'cycle':resource.kind,
          params[resource.param],resource.kind==='department'?params.deptId:undefined);
        continue;
      }
      if(resource?.kind==='collection') {
        await this.policy.assertCollection(req.auth,cap,String(req.params?.cycleId ?? req.query?.cycle_id ?? '')||undefined);
        continue;
      }
      const ok = await this.policy.hasCapability(req.auth.userId, req.auth.orgId, cap);
      if (!ok) throw new ForbiddenException({ code: 'FORBIDDEN', capability: cap });
    }
    if(required.includes('calibration.read_raw'))await this.policy.auditRawAccess(req.auth,String(req.route?.path??''));
    return true;
    } catch(error) {
      await this.policy.auditDenied(req.auth,required.join(','));
      throw error;
    }
  }
}
