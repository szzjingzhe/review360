import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { MaterialsService } from './materials.service';

@Module({
  imports: [DatabaseModule, AuthModule, AuthzModule],
  controllers: [ReportController],
  providers: [ReportService, MaterialsService],
  exports: [ReportService],
})
export class ReportModule {}
