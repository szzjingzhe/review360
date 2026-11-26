import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PolicyService } from './policy.service';
import { CapabilityGuard } from './capability.guard';

@Module({
  imports: [DatabaseModule],
  providers: [PolicyService, CapabilityGuard],
  exports: [PolicyService, CapabilityGuard],
})
export class AuthzModule {}
