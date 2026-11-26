import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { CyclesController } from './cycles.controller';
import { CyclesService } from './cycles.service';
import { RulesetsService } from './rulesets.service';
import { AssignmentService } from './assignment.service';
import { DepartmentProgressService } from './department-progress.service';

@Module({
  imports: [DatabaseModule, AuthModule, AuthzModule],
  controllers: [CyclesController],
  providers: [CyclesService, RulesetsService, AssignmentService, DepartmentProgressService],
})
export class CyclesModule {}
