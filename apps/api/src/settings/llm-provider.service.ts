import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../database/database.module';
import { PolicyService } from '../authz/policy.service';
import type { AuthContext } from '../auth/current-user.decorator';

/** 允许的接口协议。当前实现以 OpenAI Chat Completions 兼容层为主。 */
const PROTOCOLS = ['openai', 'anthropic', 'openai_responses'] as const;
type Protocol = (typeof PROTOCOLS)[number];

export interface LlmProviderInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  protocol?: string;
  model?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  supportsVision?: boolean;
  temperature?: number;
  timeoutMs?: number;
  isDefault?: boolean;
}

const mask = (key: string): string => {
  const value = String(key ?? '');
  if (value.length <= 8) return value ? '••••' : '';
  return value.slice(0, 3) + '••••••' + value.slice(-4);
};

const trimUrl = (value: string): string => String(value ?? '').trim().replace(/\/+$/, '');

@Injectable()
export class LlmProviderService {
  constructor(
    @Inject(DATABASE_POOL) private readonly db: Pool,
    private readonly policy: PolicyService,
  ) {}

  private async assertManage(actor: AuthContext): Promise<void> {
    if (!(await this.policy.hasCapability(actor.userId, actor.orgId, 'org.manage'))) {
      throw new ForbiddenException({ code: 'FORBIDDEN' });
    }
  }

  private shape(row: Record<string, any>) {
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      protocol: row.protocol,
      model: row.model,
      contextWindow: row.context_window,
      maxOutputTokens: row.max_output_tokens,
      supportsVision: row.supports_vision,
      temperature: Number(row.temperature),
      timeoutMs: row.timeout_ms,
      isDefault: row.is_default,
      apiKeyMask: mask(row.api_key),
      hasApiKey: !!row.api_key,
      updatedAt: row.updated_at,
      lastTestAt: row.last_test_at,
      lastTestOk: row.last_test_ok,
      lastTestError: row.last_test_error,
    };
  }

  async list(actor: AuthContext) {
    // 读权限放宽到管理端可见，写权限仍要求 org.manage
    if (!(await this.policy.hasCapability(actor.userId, actor.orgId, 'management.access'))) {
      throw new ForbiddenException({ code: 'FORBIDDEN' });
    }
    const rows = (await this.db.query(
      'SELECT * FROM llm_providers WHERE org_id=$1 ORDER BY is_default DESC, updated_at DESC',
      [actor.orgId],
    )).rows;
    return {
      canManage: await this.policy.hasCapability(actor.userId, actor.orgId, 'org.manage'),
      items: rows.map((row) => this.shape(row)),
    };
  }

  /** 供其它模块（如成长分析）取默认模型；没有配置时回退环境变量。 */
  async resolveDefault(orgId: string) {
    const row = (await this.db.query(
      'SELECT base_url, model, api_key, timeout_ms, temperature, max_output_tokens FROM llm_providers WHERE org_id=$1 AND is_default LIMIT 1',
      [orgId],
    )).rows[0];
    if (!row) return null;
    return {
      base: trimUrl(row.base_url),
      model: row.model,
      key: row.api_key,
      timeoutMs: row.timeout_ms,
      temperature: Number(row.temperature),
      maxOutputTokens: row.max_output_tokens,
    };
  }

  private validate(body: LlmProviderInput, requireKey: boolean): { name: string; baseUrl: string; protocol: Protocol; model: string } {
    const name = String(body.name ?? '').trim();
    const baseUrl = trimUrl(String(body.baseUrl ?? ''));
    const model = String(body.model ?? '').trim();
    const protocol = String(body.protocol ?? 'openai') as Protocol;
    if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED' });
    if (!model) throw new BadRequestException({ code: 'MODEL_REQUIRED' });
    if (!baseUrl) throw new BadRequestException({ code: 'BASE_URL_REQUIRED' });
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new BadRequestException({ code: 'BASE_URL_INVALID' });
    }
    if (!['https:', 'http:'].includes(url.protocol)) throw new BadRequestException({ code: 'BASE_URL_INVALID' });
    if (!PROTOCOLS.includes(protocol)) throw new BadRequestException({ code: 'PROTOCOL_INVALID' });
    if (requireKey && !String(body.apiKey ?? '').trim()) throw new BadRequestException({ code: 'API_KEY_REQUIRED' });
    return { name, baseUrl, protocol, model };
  }

  async create(actor: AuthContext, body: LlmProviderInput) {
    await this.assertManage(actor);
    const { name, baseUrl, protocol, model } = this.validate(body, true);
    const duplicated = await this.db.query('SELECT 1 FROM llm_providers WHERE org_id=$1 AND name=$2', [actor.orgId, name]);
    if (duplicated.rowCount) throw new BadRequestException({ code: 'NAME_DUPLICATED' });
    const count = Number((await this.db.query('SELECT count(*)::int AS n FROM llm_providers WHERE org_id=$1', [actor.orgId])).rows[0].n);
    const isDefault = body.isDefault === true || count === 0;
    if (isDefault) await this.db.query('UPDATE llm_providers SET is_default=false WHERE org_id=$1', [actor.orgId]);
    const created = await this.db.query(
      `INSERT INTO llm_providers
        (org_id, name, base_url, api_key, protocol, model, context_window, max_output_tokens,
         supports_vision, temperature, timeout_ms, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        actor.orgId, name, baseUrl, String(body.apiKey ?? '').trim(), protocol, model,
        body.contextWindow ?? null, body.maxOutputTokens ?? null,
        body.supportsVision === true, this.clampTemperature(body.temperature),
        this.clampTimeout(body.timeoutMs), isDefault, actor.userId,
      ],
    );
    return this.shape(created.rows[0]);
  }

  async update(actor: AuthContext, id: string, body: LlmProviderInput) {
    await this.assertManage(actor);
    const existing = (await this.db.query('SELECT * FROM llm_providers WHERE id=$1 AND org_id=$2', [id, actor.orgId])).rows[0];
    if (!existing) throw new NotFoundException({ code: 'LLM_PROVIDER_NOT_FOUND' });
    const { name, baseUrl, protocol, model } = this.validate(
      { ...body, apiKey: body.apiKey ?? existing.api_key },
      !existing.api_key,
    );
    const duplicated = await this.db.query(
      'SELECT 1 FROM llm_providers WHERE org_id=$1 AND name=$2 AND id<>$3',
      [actor.orgId, name, id],
    );
    if (duplicated.rowCount) throw new BadRequestException({ code: 'NAME_DUPLICATED' });
    const apiKey = String(body.apiKey ?? '').trim() || existing.api_key;
    const isDefault = body.isDefault === true ? true : existing.is_default;
    if (isDefault && !existing.is_default) {
      await this.db.query('UPDATE llm_providers SET is_default=false WHERE org_id=$1', [actor.orgId]);
    }
    const updated = await this.db.query(
      `UPDATE llm_providers SET
         name=$3, base_url=$4, api_key=$5, protocol=$6, model=$7,
         context_window=$8, max_output_tokens=$9, supports_vision=$10,
         temperature=$11, timeout_ms=$12, is_default=$13, updated_at=now()
       WHERE id=$1 AND org_id=$2 RETURNING *`,
      [
        id, actor.orgId, name, baseUrl, apiKey, protocol, model,
        body.contextWindow ?? existing.context_window,
        body.maxOutputTokens ?? existing.max_output_tokens,
        body.supportsVision === undefined ? existing.supports_vision : body.supportsVision === true,
        body.temperature === undefined ? Number(existing.temperature) : this.clampTemperature(body.temperature),
        body.timeoutMs === undefined ? existing.timeout_ms : this.clampTimeout(body.timeoutMs),
        isDefault,
      ],
    );
    return this.shape(updated.rows[0]);
  }

  async remove(actor: AuthContext, id: string) {
    await this.assertManage(actor);
    const removed = await this.db.query('DELETE FROM llm_providers WHERE id=$1 AND org_id=$2 RETURNING is_default', [id, actor.orgId]);
    if (!removed.rowCount) throw new NotFoundException({ code: 'LLM_PROVIDER_NOT_FOUND' });
    if (removed.rows[0].is_default) {
      await this.db.query(
        `UPDATE llm_providers SET is_default=true
          WHERE id=(SELECT id FROM llm_providers WHERE org_id=$1 ORDER BY created_at LIMIT 1)`,
        [actor.orgId],
      );
    }
    return { id };
  }

  async setDefault(actor: AuthContext, id: string) {
    await this.assertManage(actor);
    const exists = await this.db.query('SELECT 1 FROM llm_providers WHERE id=$1 AND org_id=$2', [id, actor.orgId]);
    if (!exists.rowCount) throw new NotFoundException({ code: 'LLM_PROVIDER_NOT_FOUND' });
    await this.db.query('UPDATE llm_providers SET is_default=false WHERE org_id=$1', [actor.orgId]);
    const row = await this.db.query('UPDATE llm_providers SET is_default=true, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *', [id, actor.orgId]);
    return this.shape(row.rows[0]);
  }

  /** 用一次最小请求验证地址、密钥与模型是否可用。 */
  async test(actor: AuthContext, id: string) {
    await this.assertManage(actor);
    const row = (await this.db.query('SELECT * FROM llm_providers WHERE id=$1 AND org_id=$2', [id, actor.orgId])).rows[0];
    if (!row) throw new NotFoundException({ code: 'LLM_PROVIDER_NOT_FOUND' });
    const endpoint = row.protocol === 'anthropic'
      ? trimUrl(row.base_url) + '/messages'
      : trimUrl(row.base_url) + '/chat/completions';
    const started = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(Math.min(Number(row.timeout_ms) || 60000, 120000)),
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${row.api_key}`,
          'Content-Type': 'application/json',
          ...(row.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
        },
        body: JSON.stringify(
          row.protocol === 'anthropic'
            ? { model: row.model, max_tokens: 32, messages: [{ role: 'user', content: '只回复 ok' }] }
            : {
                model: row.model,
                max_tokens: 64,
                messages: [{ role: 'user', content: '只回复：ok' }],
              },
        ),
      });
      const latencyMs = Date.now() - started;
      const text = await response.text();
      if (!response.ok) {
        const detail = text.slice(0, 300);
        await this.recordTest(id, false, `HTTP ${response.status}: ${detail}`);
        return { ok: false, latencyMs, status: response.status, error: `HTTP ${response.status}`, detail };
      }
      let sample = '';
      try {
        const json = JSON.parse(text);
        sample = String(
          json?.choices?.[0]?.message?.content ?? json?.content?.[0]?.text ?? '',
        ).slice(0, 120);
      } catch {
        sample = text.slice(0, 120);
      }
      await this.recordTest(id, true, null);
      return { ok: true, latencyMs, status: response.status, model: row.model, sample };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const message = error instanceof Error ? (error.name === 'TimeoutError' ? '请求超时' : error.message) : '连接失败';
      await this.recordTest(id, false, message);
      return { ok: false, latencyMs, status: 0, error: message };
    }
  }

  private async recordTest(id: string, ok: boolean, error: string | null) {
    await this.db.query(
      `UPDATE llm_providers SET last_test_at=now(), last_test_ok=$2, last_test_error=$3 WHERE id=$1`,
      [id, ok, error],
    );
  }

  private clampTemperature(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.2;
    return Math.min(2, Math.max(0, Math.round(n * 100) / 100));
  }

  private clampTimeout(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 60000;
    return Math.min(180000, Math.max(5000, Math.round(n)));
  }
}
