import { Module } from '@nestjs/common';
import { OrgController } from './org.controller';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [AuthModule, AuthzModule, DatabaseModule],
  controllers: [OrgController],
})
export class OrgModule {}
