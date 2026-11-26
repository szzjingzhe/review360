import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { DATABASE_POOL } from '../database/database.module';

/**
 * 幂等执行器（PRD A13：双击或网络重试只产生一份有效评分）。
 *
 * 复用既有 `idempotency_records`（唯一键 actor_id + route + key）：
 *  - 未带 key：直接执行（不改变原行为）
 *  - 首次：占位 IN_FLIGHT → 执行 → 落 response_json / COMPLETED
 *  - 重复且已完成：直接回放上次结果（不重复落库）
 *  - 重复且仍在执行：409 IDEMPOTENCY_IN_FLIGHT
 *  - 同 key 但请求体不同：409 IDEMPOTENCY_KEY_REUSED
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  async run<T>(
    actorId: string,
    route: string,
    key: string | undefined,
    requestBody: unknown,
    fn: (client?:PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!key) return fn();

    const requestHash = createHash('sha256')
      .update(JSON.stringify(requestBody ?? null))
      .digest('hex');

    const client=await this.db.connect();const lockKey=JSON.stringify(['idempotency',actorId,route,key]);
    try{
      await client.query('BEGIN');
      const locked=(await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[lockKey])).rows[0].locked;
      if(!locked)throw new ConflictException({code:'IDEMPOTENCY_IN_FLIGHT'});
      const row=(await client.query('SELECT id,request_hash,status,response_json,expires_at,now() AS now FROM idempotency_records WHERE actor_id=$1 AND route=$2 AND key=$3',[actorId,route,key])).rows[0];
      if(row&&row.expires_at>row.now){
        if(row.request_hash!==requestHash)throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED'});
        if(row.status==='COMPLETED'){await client.query('COMMIT');return row.response_json as T;}
      }
      // The transaction lock is unowned: an old placeholder may be recovered.
      if(row)await client.query('DELETE FROM idempotency_records WHERE id=$1',[row.id]);
      const record=(await client.query("INSERT INTO idempotency_records(id,actor_id,route,key,request_hash,status,expires_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,'IN_FLIGHT',now()+interval '24 hours') RETURNING id",[actorId,route,key,requestHash])).rows[0];
      const result=await fn(client);
      await client.query("UPDATE idempotency_records SET status='COMPLETED',response_json=$1 WHERE id=$2",[JSON.stringify(result),record.id]);
      await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
}
