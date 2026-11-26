import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { LlmProviderController } from './llm-provider.controller';
import { LlmProviderService } from './llm-provider.service';
import { ReminderController } from './reminder.controller';

@Module({
  imports: [DatabaseModule, AuthModule, AuthzModule],
  controllers: [LlmProviderController, ReminderController],
  providers: [LlmProviderService],
  exports: [LlmProviderService],
})
export class SettingsModule {}
