-- 取消 HRBP 专项环评：原相关人员归入产品部，新周期按普通成员参与。
DO $$
DECLARE
  product_dept UUID;
  person RECORD;
BEGIN
  FOR person IN
    SELECT DISTINCT u.id AS user_id, u.org_id
      FROM users u
      JOIN appointments a ON a.user_id = u.id AND a.org_id = u.org_id
     WHERE a.role = 'HRPB' AND a.valid_to IS NULL
  LOOP
    SELECT id INTO product_dept FROM departments
     WHERE org_id = person.org_id AND code = 'PD' LIMIT 1;
    IF product_dept IS NULL THEN RAISE EXCEPTION '产品部(PD)不存在'; END IF;

    UPDATE department_memberships SET valid_to = CURRENT_DATE
     WHERE user_id = person.user_id AND org_id = person.org_id
       AND valid_to IS NULL AND department_id <> product_dept;
    IF NOT EXISTS (
      SELECT 1 FROM department_memberships
       WHERE user_id = person.user_id AND org_id = person.org_id
         AND department_id = product_dept AND valid_to IS NULL
    ) THEN
      INSERT INTO department_memberships (org_id, user_id, department_id, valid_from)
      VALUES (person.org_id, person.user_id, product_dept, CURRENT_DATE);
    END IF;
  END LOOP;

  UPDATE appointments SET valid_to = CURRENT_DATE WHERE role = 'HRPB' AND valid_to IS NULL;
  UPDATE capability_grants SET revoked_at = now()
   WHERE scope_type = 'STATION' AND revoked_at IS NULL;
END $$;
