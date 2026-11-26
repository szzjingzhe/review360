import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../database/database.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  /** 存活探针：进程本身可用即返回 */
  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  /** 就绪探针：数据库可达才返回 200，否则 503 */
  @Get('ready')
  @HttpCode(200)
  async ready() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok', database: 'reachable' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'unreachable' });
    }
  }
}
