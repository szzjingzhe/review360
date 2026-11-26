import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

export const DATABASE_POOL = 'DATABASE_POOL';

@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool =>
        new Pool({ connectionString: config.getOrThrow<string>('DATABASE_URL'), max: 10 }),
    },
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule {}
