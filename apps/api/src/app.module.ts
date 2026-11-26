import { ManagementModule } from './management/management.module';
import { GrowthModule } from './growth/growth.module';
import { ConfigModule } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { AuthzModule } from './authz/authz.module';
import { OrgModule } from './org/org.module';
import { CyclesModule } from './cycles/cycles.module';
import { ReviewsModule } from './reviews/reviews.module';
import { CalibrationModule } from './calibration/calibration.module';
import { ResultsModule } from './results/results.module';
import { AwardModule } from './award/award.module';
import { FeedbackModule } from './feedback/feedback.module';
import { ReportModule } from './report/report.module';
import { AuditModule } from './audit/audit.module';
import { AnnouncementModule } from './announcement/announcement.module';
import { SettingsModule } from './settings/settings.module';
@Module({
  imports: [
    // .env 位于仓库根目录；进程工作目录为 apps/api，因此向上查找
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: process.env.APP_ENV === 'test',
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
    }),
    HealthModule,
    AuthModule,
    AuthzModule,
    OrgModule,
    CyclesModule,
    ReviewsModule,
    CalibrationModule,
    ResultsModule,
    AwardModule,
    FeedbackModule,
    ReportModule,
    AuditModule,
    AnnouncementModule,
    SettingsModule,
    GrowthModule,
    ManagementModule,
  ],
})
export class AppModule {}
