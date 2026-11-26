import { ReviewMaterialsService } from './review-materials.service';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { IdempotencyService } from './idempotency.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ReviewsController],
  providers: [ReviewMaterialsService, ReviewsService, IdempotencyService],
})
export class ReviewsModule {}
