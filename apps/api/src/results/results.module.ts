import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';
import { PublishedDirectoryService } from './published-directory.service';
import { PublishService } from './publish.service';

@Module({
  imports: [DatabaseModule, AuthModule, AuthzModule],
  controllers: [ResultsController],
  providers: [ResultsService, PublishService, PublishedDirectoryService],
  exports: [ResultsService, PublishService],
})
export class ResultsModule {}
