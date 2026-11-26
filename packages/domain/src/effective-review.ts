/** Server-owned predicate shared by result aggregation and calibration scanning. */
export function effectiveReviewSql(r:string,v:string):string {
  return `${r}.status='SUBMITTED' AND ${r}.current_revision_id=${v}.id AND ${v}.score_bp IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM calibration_cases vc JOIN calibration_actions va ON va.case_id=vc.id
      WHERE vc.review_revision_id=${v}.id AND va.action='VOID_APPROVE')
    AND ((${r}.kind='SELF' AND ${r}.reviewer_id=${r}.target_id AND ${r}.assignment_id IS NULL)
      OR (${r}.kind='PEER' AND EXISTS (SELECT 1 FROM assignments ea WHERE ea.id=${r}.assignment_id
        AND ea.org_id=${r}.org_id AND ea.cycle_id=${r}.cycle_id AND ea.reviewer_id=${r}.reviewer_id
        AND ea.target_id=${r}.target_id AND ea.status='ACTIVE'))) `;
}
