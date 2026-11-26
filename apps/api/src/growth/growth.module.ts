import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { SettingsModule } from '../settings/settings.module';
import { GrowthController } from './growth.controller';
import { GrowthService } from './growth.service';
@Module({ imports: [DatabaseModule, AuthModule, AuthzModule, SettingsModule], controllers: [GrowthController], providers: [GrowthService] })
export class GrowthModule {}
