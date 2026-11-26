-- Guidance membership grants only the published-results directory, and expires with membership.
CREATE OR REPLACE VIEW effective_capability_grants AS
SELECT org_id,user_id,capability,scope_type,scope_id,valid_from,valid_to,revoked_at FROM capability_grants
UNION ALL
SELECT org_id,user_id,'management.access',scope_type,scope_id,valid_from,valid_to,revoked_at FROM capability_grants WHERE capability='workspace.oversight'
UNION ALL
SELECT org_id,user_id,'result.read_aggregate',scope_type,scope_id,valid_from,valid_to,revoked_at FROM capability_grants WHERE capability='calibration.read_raw'
UNION ALL
SELECT u.org_id,u.id,cap.capability,'ORG'::text,NULL::uuid,'-infinity'::timestamptz,NULL::timestamptz,NULL::timestamptz
FROM users u CROSS JOIN unnest(ARRAY['workspace.oversight','management.access','cycle.manage','assignment.manage','progress.read','reminder.send','calibration.resolve','result.read_published','result.read_aggregate','result.confirm','result.publish','feedback.manage','report.view','org.manage','audit.export','growth.manage']) AS cap(capability)
WHERE u.status='ACTIVE' AND (EXISTS(SELECT 1 FROM business_administrators a WHERE a.org_id=u.org_id AND a.user_id=u.id)
 OR EXISTS(SELECT 1 FROM appointments a WHERE a.org_id=u.org_id AND a.user_id=u.id AND a.role='HEAD' AND a.valid_from<=CURRENT_DATE AND (a.valid_to IS NULL OR a.valid_to>CURRENT_DATE)))
UNION ALL
SELECT m.org_id,m.user_id,'result.read_published'::text,'ORG'::text,NULL::uuid,m.valid_from::timestamptz,m.valid_to::timestamptz,NULL::timestamptz
FROM department_memberships m JOIN departments d ON d.org_id=m.org_id AND d.id=m.department_id
JOIN users u ON u.org_id=m.org_id AND u.id=m.user_id AND u.status='ACTIVE'
WHERE d.code IN ('GUIDE','GUIDANCE');
