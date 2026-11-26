-- 035: 组织级大模型配置（系统设置 → 模型配置）
-- 让管理员在界面里自由配置 OpenAI 兼容的模型服务，替代原先只能靠环境变量 GROWTH_AI_* 的做法。
CREATE TABLE IF NOT EXISTS llm_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_url text NOT NULL,
  api_key text NOT NULL,
  protocol text NOT NULL DEFAULT 'openai',
  model text NOT NULL,
  context_window integer,
  max_output_tokens integer,
  supports_vision boolean NOT NULL DEFAULT false,
  temperature numeric(3,2) NOT NULL DEFAULT 0.2,
  timeout_ms integer NOT NULL DEFAULT 60000,
  is_default boolean NOT NULL DEFAULT false,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_providers_protocol_check CHECK (protocol IN ('openai', 'anthropic', 'openai_responses')),
  CONSTRAINT llm_providers_org_name_key UNIQUE (org_id, name)
);

-- 每个组织只能有一个默认模型
CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_provider_default
  ON llm_providers (org_id) WHERE is_default;
