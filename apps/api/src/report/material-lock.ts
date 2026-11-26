import type { PoolClient } from 'pg';

/** All material writers and evaluation submissions serialize on the same member/package. */
export async function lockMaterialPackage(client: PoolClient, orgId: string, cycleId: string, userId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [orgId + ':' + cycleId + ':' + userId]);
}

export async function freezeReviewMaterials(client: PoolClient, orgId: string, cycleId: string, userId: string) {
  await lockMaterialPackage(client, orgId, cycleId, userId);
  const pkg = await client.query(`SELECT id,active_version_id FROM monthly_reports
    WHERE org_id=$1 AND cycle_id=$2 AND user_id=$3 FOR UPDATE`, [orgId,cycleId,userId]);
  if (!pkg.rowCount) return null;
  const report = pkg.rows[0];
  const versions = await client.query(`
    SELECT m.id AS "materialId",v.id AS "versionId",m.material_type AS type,v.version
    FROM monthly_materials m JOIN report_versions v ON v.report_id=m.report_id
    WHERE m.report_id=$1 AND m.material_type='MONTHLY_REPORT' AND v.id=$2
    UNION ALL
    SELECT m.id,v.id,m.material_type,v.version FROM monthly_materials m
    JOIN LATERAL (SELECT id,version FROM monthly_material_versions WHERE material_id=m.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE m.report_id=$1 AND m.material_type<>'MONTHLY_REPORT'`, [report.id,report.active_version_id]);
  await client.query('UPDATE monthly_reports SET locked_at=coalesce(locked_at,now()),updated_at=now() WHERE id=$1', [report.id]);
  return { reportId: report.id, primaryVersionId: report.active_version_id as string | null, versions: versions.rows };
}
