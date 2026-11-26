/** Allowlist, never spread the formal publication payload into a personal response. */
export function personalPublication(row: Record<string, any>) {
  return {
    id: row.id, cycle_id: row.cycle_id, month: row.month,
    publication_version: row.publication_version, published_at: row.published_at,
    payload_json: { status: 'PUBLISHED' },
    display_metadata: { cycle: { id: row.cycle_id, month: row.month, title: row.title,
      openAt: row.open_at, closeAt: row.close_at } },
  };
}
