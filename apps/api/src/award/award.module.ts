import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { AwardController } from './award.controller';
import { AwardService } from './award.service';

@Module({
  imports: [DatabaseModule, AuthModule, AuthzModule],
  controllers: [AwardController],
  providers: [AwardService],
})
export class AwardModule {}
