export interface FeedbackHandling {
  stage: 'FIRST' | 'REREVIEW'; decision: string | null; note: string | null;
  handledAt: string; handlerId: string | null; handlerName: string | null;
}
export interface FeedbackRecord {
  id: string; cycleId: string; targetId: string; reason: string; status: string; createdAt: string;
  publicationId: string; publicationVersion: number; applicantName: string; departmentName: string | null;
  cycleTitle: string; cycleMonth: string; cycleOpenAt: string | null; cycleCloseAt: string | null;
  rereviewReason: string | null; rereviewOpenedAt: string | null;
  handlerNote: string | null; handlingRecords: FeedbackHandling[];
}
export interface FeedbackContext {
  resultUnavailableReason: string | null;
  result: null | {
    publicationId: string; publicationVersion: number; publishedAt: string; finalScore: number | null;
    simulationNotice: string | null; notice: string;
    dimensions: Array<{ key: string; label: string; weight: number | null; selfScore: number | null; peerScore: number | null }>;
  };
}
export type FeedbackFilter = 'all' | 'pending' | 'rereview' | 'closed';
