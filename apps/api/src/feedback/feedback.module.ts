import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { FeedbackContextService } from './feedback-context.service';

@Module({
  imports: [DatabaseModule, AuthModule, AuthzModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, FeedbackContextService],
})
export class FeedbackModule {}
