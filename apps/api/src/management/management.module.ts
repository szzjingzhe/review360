import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { CycleManagementService } from './cycle-management.service';
import { CockpitService } from './cockpit.service';
import { ManagementController } from './management.controller';
@Module({imports:[DatabaseModule,AuthModule,AuthzModule],controllers:[ManagementController],providers:[CockpitService,CycleManagementService]})
export class ManagementModule {}
