import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { createPool, loadEnvFile, verifyTestPool } from './env.js';

/** 固定命名空间（随机选定后冻结，勿改，否则所有种子 UUID 漂移） */
const NAMESPACE = '7a495a84-72d7-4db9-a260-75f2c32254c7';

function uuidV5(name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  hash[6] = ((hash[6] & 0x0f) | 0x50); // version 5
  hash[8] = ((hash[8] & 0x3f) | 0x80); // RFC 4122 variant
  const h = hash.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const id = (kind: string, key: string) => uuidV5(`360-review:${kind}:${key}`);

interface DeptSeed {
  code: string;
  name: string;
  head?: string;
  members: string[];
}

/** 五个基础部门；只有明确标注“负责人”的人员设置为 HEAD。 */
export const DEPARTMENTS: DeptSeed[] = [
  {
    code: 'TECH',
    name: '科技部',
    head: '示例成员01',
    members: ['示例成员02', '示例成员03', '示例成员04', '示例成员05', '示例成员06', '示例成员07', '示例成员08', '示例成员09'],
  },
  {
    code: 'RD',
    name: '研发部',
    head: '示例成员10',
    members: ['示例成员11', '示例成员12', '示例成员13', '示例成员14', '示例成员15', '示例成员16', '示例成员17'],
  },
  {
    code: 'PD',
    name: '产品部',
    head: '示例成员18',
    members: ['示例成员19', '示例成员20', '示例运营成员', '示例成员22', '示例成员23', '示例成员24'],
  },
  {
    code: 'ECO',
    name: '生态部',
    head: '示例成员25',
    members: ['示例成员26', '示例成员27', '示例成员28', '示例成员29', '示例成员30', '示例成员31', '示例成员32', '示例成员33'],
  },
  {
    code: 'NET',
    name: '网监部',
    head: '示例成员34',
    members: ['示例成员35', '示例成员36', '示例成员37', '示例成员38', '示例成员39', '示例成员40', '示例成员41', '示例成员42'],
  },
];

const ADDITIONAL_GROUPS: DeptSeed[] = [
  { code: 'TC', name: '教学事务委员会', head: '示例成员43', members: [] },
  { code: 'GUIDE', name: '指导老师组', members: ['示例成员44', '示例成员45', '示例成员46', '示例成员47'] },
];

/** Keep historical references on the existing account IDs while correcting roster display names. */
const USER_IDENTITY_KEYS: Record<string, string> = {
  '示例成员11': '示例成员48',
  '示例成员17': '示例成员49',
  '示例成员46': '示例成员50',
  '示例成员37': '示例成员51',
  '示例成员41': '示例成员52',
};
const userId = (name: string) => id('user', USER_IDENTITY_KEYS[name] ?? name);

async function main(): Promise<void> {
  loadEnvFile();
  const pool = createPool();
  await verifyTestPool(pool);
  const client = await pool.connect();
  try {
    const test = process.env.APP_ENV === 'test';
    const orgId = id('org', 'demo');
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO organizations (id, name, timezone) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [orgId, test ? '示例组织' : process.env.INITIAL_ORG_NAME || '我的组织', process.env.ORG_TIMEZONE || 'Asia/Shanghai'],
    );

    if (test) {
      const groups = [...ADDITIONAL_GROUPS.slice(0, 1), ...DEPARTMENTS, ...ADDITIONAL_GROUPS.slice(1)];
      const roster = new Map<string, string>();
      for (const group of groups) {
        const deptId = id('dept', group.code);
        for (const name of [...(group.head ? [group.head] : []), ...group.members]) roster.set(userId(name), deptId);
      }

      // Keep non-roster accounts and their historical references, but remove them from the active organization.
      await client.query(
        `UPDATE department_memberships SET valid_to = current_date
         WHERE org_id = $1 AND valid_to IS NULL AND user_id <> ALL($2::uuid[])`,
        [orgId, [...roster.keys()]],
      );
      await client.query(
        `UPDATE users SET status = 'SUSPENDED', row_version = row_version + 1, updated_at = now()
         WHERE org_id = $1 AND status = 'ACTIVE' AND id <> ALL($2::uuid[])`,
        [orgId, [...roster.keys()]],
      );

      let heads = 0;
      for (let i = 0; i < groups.length; i++) {
        const dept = groups[i];
        const deptId = id('dept', dept.code);
        await client.query(
          `INSERT INTO departments (id, org_id, code, name, sort_order) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order`,
          [deptId, orgId, dept.code, dept.name, i],
        );

        const allNames = [...(dept.head ? [dept.head] : []), ...dept.members];
        for (const name of allNames) {
          await client.query(
            `INSERT INTO users (id, org_id, display_name, status) VALUES ($1, $2, $3, 'ACTIVE')
             ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name,
               status = 'ACTIVE', row_version = users.row_version + 1, updated_at = now()`,
            [userId(name), orgId, name],
          );
          await client.query(
            `UPDATE department_memberships SET valid_to = current_date
             WHERE org_id = $1 AND user_id = $2 AND valid_to IS NULL AND department_id <> $3`,
            [orgId, userId(name), deptId],
          );
          await client.query(
            `INSERT INTO department_memberships (org_id, user_id, department_id, valid_from)
             SELECT $1, $2, $3, current_date
             WHERE NOT EXISTS (
               SELECT 1 FROM department_memberships
               WHERE org_id = $1 AND user_id = $2 AND valid_from <= current_date
                 AND (valid_to IS NULL OR valid_to > current_date)
             )`,
            [orgId, userId(name), deptId],
          );
        }

        if (dept.head) {
          await client.query(
            `UPDATE appointments SET valid_to = current_date
             WHERE org_id = $1 AND role = 'HEAD' AND scope_dept_id = $2
               AND user_id <> $3 AND valid_to IS NULL`,
            [orgId, deptId, userId(dept.head)],
          );
          await client.query(
            `INSERT INTO appointments (id, org_id, user_id, role, scope_dept_id, valid_from, valid_to)
             VALUES ($1, $2, $3, 'HEAD', $4, DATE '2020-01-01', NULL)
             ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, valid_to = NULL`,
            [id('appointment', `HEAD:${dept.code}`), orgId, userId(dept.head), deptId],
          );
          heads++;
        }
      }

      const total = roster.size;
      if (total !== 47 || heads !== 6 || groups.length !== 7) {
        throw new Error(`名单校验失败：期望 47 人、7 个组织节点、6 位部长，实际 ${total} 人、${groups.length} 个节点、${heads} 位部长`);
      }

      // 指导老师组成员示例成员46沿用原监管账号 ID；该历史业务任命及系统授权不在此处改动。
      const supervisorId = userId('示例成员46');
      await client.query(
        `INSERT INTO appointments (id, org_id, user_id, role, scope_dept_id, valid_from, valid_to)
         VALUES ($1, $2, $3, 'SUPERVISOR', NULL, DATE '2020-01-01', NULL)
         ON CONFLICT (id) DO NOTHING`,
        [id('appointment', 'SUPERVISOR:org'), orgId, supervisorId],
      );

      // 演示引导管理员：开发/验收环境使用，正式上线前必须收回（docs/decisions.md D-M1-1）
      const bootstrapAdmin = '示例成员18';
      await client.query(
        `INSERT INTO capability_grants (id, org_id, user_id, capability, scope_type, reason)
         VALUES ($1, $2, $3, 'org.manage', 'ORG', $4)
         ON CONFLICT (id) DO NOTHING`,
        [id('grant', 'bootstrap:org.manage'), orgId, userId(bootstrapAdmin),
         '演示环境引导管理员（正式上线前必须重新指定）'],
      );
      // 引导管理员同时具备周期与分配管理能力（M2 演示流程需要；正式环境收回后由管理员显式授权）
      for (const cap of ['cycle.manage', 'assignment.manage']) {
        await client.query(
          `INSERT INTO capability_grants (id, org_id, user_id, capability, scope_type, reason)
           VALUES ($1, $2, $3, $4, 'ORG', $5)
           ON CONFLICT (id) DO NOTHING`,
          [id('grant', `bootstrap:${cap}`), orgId, userId(bootstrapAdmin), cap,
           '演示环境引导管理员（正式上线前必须重新指定）'],
        );
      }

      // 示例运营成员保留产品部普通成员身份，但承担组织运营职责：
      // 通过显式能力授权开放部门管理、监管及组织管理端，不新增 HEAD 任命。
      const exampleOperator = userId('示例运营成员');
      const huangCapabilities = [
        'progress.read', 'cycle.manage', 'assignment.manage',
        'calibration.read_raw', 'calibration.resolve', 'result.confirm',
        'result.publish', 'award.manage', 'feedback.manage', 'report.view',
        'org.manage', 'audit.export',
      ];
      for (const cap of huangCapabilities) {
        await client.query(
          `INSERT INTO capability_grants (id, org_id, user_id, capability, scope_type, reason)
           VALUES ($1, $2, $3, $4, 'ORG', $5)
           ON CONFLICT (id) DO NOTHING`,
          [id('grant', `example-operator:${cap}`), orgId, exampleOperator, cap,
           '示例运营成员：保留产品部普通成员身份，授权部门管理、组织监管及组织管理'],
        );
      }


      // 监管独立复核人能力：原始评分读取 + 核验处置（全校范围）
      await client.query(
        `INSERT INTO capability_grants (id, org_id, user_id, capability, scope_type, reason)
         VALUES ($1, $2, $3, 'calibration.read_raw', 'ORG', $4)
         ON CONFLICT (id) DO NOTHING`,
        [id('grant', 'calibration.read_raw:ORG'), orgId, supervisorId, '监管独立复核人：原始评分读取'],
      );
      await client.query(
        `INSERT INTO capability_grants (id, org_id, user_id, capability, scope_type, reason)
         VALUES ($1, $2, $3, 'calibration.resolve', 'ORG', $4)
         ON CONFLICT (id) DO NOTHING`,
        [id('grant', 'calibration.resolve:ORG'), orgId, supervisorId, '监管独立复核人：核验处置'],
      );

    } else {
      const adminId = id('user', 'bootstrap');
      await client.query(`INSERT INTO users(id,org_id,display_name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,
        [adminId, orgId, process.env.INITIAL_ADMIN_NAME || '系统管理员']);
      await client.query(`INSERT INTO business_administrators(org_id,user_id,reason) VALUES($1,$2,'首次部署') ON CONFLICT DO NOTHING`, [orgId, adminId]);
      await client.query(`INSERT INTO installation_setup(org_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [orgId, adminId]);
    }

    // 默认规则集 v1（技术文档 5.2：规则 JSON 字段；阈值用基点整数）
    const rulesetId = id('ruleset', 'default-v1');
    const rulesetConfig = {
      schema_version: 1,
      score: { high_bp: 9000, excellent_bp: 9500, low_bp: 6000 },
      reasons: { item_min_chars: 30, overall_min_chars: 50 },
      ratio: { threshold_pct: 50, min_reviews: 4 },
      result_formula: 'equal_weight_peer_avg_self_separate',
      rotation_window: 3,
      schedule_template: {
        open_day: 25, open_time: '00:00',
        close_day: 27, close_time: '18:00',
        calibration_hours: 4,
        publish_day: 27, publish_time: '22:00',
      },
    };
    const configJson = JSON.stringify(rulesetConfig);
    const checksum = createHash('sha256').update(configJson).digest('hex');
    await client.query(
      `INSERT INTO rulesets (id, org_id, version, status, config_json, checksum)
       VALUES ($1, $2, 1, 'FROZEN', $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [rulesetId, orgId, configJson, checksum],
    );

    // 默认评分模板：按被评价人角色 4 类，每类 4 项指标、权重合计 100
    const templates: Array<{ role: string; name: string; items: Array<[string, string, number]> }> = [
      {
        role: 'HEAD',
        name: '部长评价模板',
        items: [
          ['goal_delivery', '目标达成', 30],
          ['team_mgmt', '团队管理', 25],
          ['cross_dept', '跨部门协作', 20],
          ['decision', '决策质量', 25],
        ],
      },
      {
        role: 'MEMBER',
        name: '成员评价模板',
        items: [
          ['delivery', '任务交付', 35],
          ['collaboration', '协作支持', 25],
          ['growth', '学习成长', 20],
          ['innovation', '创新改善', 20],
        ],
      },
      {
        role: 'SUPERVISOR',
        name: '监管复核模板',
        items: [
          ['review_quality', '复核质量', 40],
          ['independence', '独立性', 30],
          ['timeliness', '及时性', 30],
        ],
      },
      {
        role: 'UPWARD',
        name: '下评上模板（成员→部长）',
        items: [
          ['leadership', '领导力', 30],
          ['decision', '决策质量', 30],
          ['support', '对下支持', 20],
          ['vision', '战略视野', 20],
        ],
      },
      {
        role: 'SELF',
        name: '自评模板',
        items: [
          ['self_awareness', '自我认知', 30],
          ['reflection', '本季反思', 25],
          ['next_focus', '下季重点', 25],
          ['support_needed', '需上级支持', 20],
        ],
      },
    ];
    for (const t of templates) {
      const templateId = id('template', `default:${t.role}`);
      await client.query(
        `INSERT INTO template_versions (id, org_id, ruleset_id, role_code, name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [templateId, orgId, rulesetId, t.role, t.name],
      );
      for (let i = 0; i < t.items.length; i++) {
        const [code, label, weight] = t.items[i];
        await client.query(
          `INSERT INTO template_items (id, org_id, template_id, code, label, weight, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [id('item', `default:${t.role}:${code}`), orgId, templateId, code, label, weight, i],
        );
      }
    }

    await client.query('COMMIT');
    console.log('组织初始化完成');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
