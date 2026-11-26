-- 031 部长工作台可授予（workspace.department）
--
-- 背景：原先「部长工作台」入口只由角色 HEAD 决定，普通成员无法获得。
-- 现在新增独立能力 workspace.department，可在「系统设置 → 角色权限」单点授予：
--   1) 授予 workspace.department → 同时隐含 progress.read（部门进度数据读取）
--   2) 现任部长与业务管理员保持默认可见（隐式能力集合补上该项）
-- 仅调整能力视图，不改任何业务数据。

CREATE OR REPLACE VIEW effective_capability_grants AS
SELECT org_id,user_id,capability,scope_type,scope_id,valid_from,valid_to,revoked_at FROM capability_grants
UNION ALL
SELECT org_id,user_id,'management.access',scope_type,scope_id,valid_from,valid_to,revoked_at FROM capability_grants WHERE capability='workspace.oversight'
UNION ALL
SELECT org_id,user_id,'result.read_aggregate',scope_type,scope_id,valid_from,valid_to,revoked_at FROM capability_grants WHERE capability='calibration.read_raw'
-- 授予部长工作台即包含部门进度读取，避免出现「能进页面但读不到数据」的半残授权
UNION ALL
SELECT org_id,user_id,'progress.read',scope_type,scope_id,valid_from,valid_to,revoked_at FROM capability_grants WHERE capability='workspace.department'
-- 组织管理员与现任部长：默认持有整套组织级能力（含部长工作台入口）
UNION ALL
SELECT u.org_id,u.id,cap.capability,'ORG'::text,NULL::uuid,'-infinity'::timestamptz,NULL::timestamptz,NULL::timestamptz
FROM users u CROSS JOIN unnest(ARRAY['workspace.oversight','workspace.department','management.access','cycle.manage','assignment.manage','progress.read','reminder.send','calibration.resolve','result.read_published','result.read_aggregate','result.confirm','result.publish','feedback.manage','report.view','org.manage','audit.export','growth.manage']) AS cap(capability)
WHERE u.status='ACTIVE' AND (EXISTS(SELECT 1 FROM business_administrators a WHERE a.org_id=u.org_id AND a.user_id=u.id)
 OR EXISTS(SELECT 1 FROM appointments a WHERE a.org_id=u.org_id AND a.user_id=u.id AND a.role='HEAD' AND a.valid_from<=CURRENT_DATE AND (a.valid_to IS NULL OR a.valid_to>CURRENT_DATE)))
UNION ALL
SELECT m.org_id,m.user_id,'result.read_published'::text,'ORG'::text,NULL::uuid,m.valid_from::timestamptz,m.valid_to::timestamptz,NULL::timestamptz
FROM department_memberships m JOIN departments d ON d.org_id=m.org_id AND d.id=m.department_id
JOIN users u ON u.org_id=m.org_id AND u.id=m.user_id AND u.status='ACTIVE'
WHERE d.code IN ('GUIDE','GUIDANCE');
