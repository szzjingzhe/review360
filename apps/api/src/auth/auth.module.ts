import { OpenSetupController } from './open-setup.controller';
import {FeishuPrebindingService} from './feishu-prebinding.service';
import {FeishuPrebindingController} from './feishu-prebinding.controller';
import { FeishuAdmissionService } from './feishu-admission.service';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { AuthzModule } from '../authz/authz.module';
import { DatabaseModule } from '../database/database.module';
import { FeishuService } from './feishu.service';

@Module({
  imports: [AuthzModule, DatabaseModule],
  controllers: [AuthController,FeishuPrebindingController,OpenSetupController],
  providers: [FeishuPrebindingService,FeishuAdmissionService, SessionService, SessionGuard, FeishuService],
  exports: [SessionService, SessionGuard, FeishuService],
})
export class AuthModule {}
