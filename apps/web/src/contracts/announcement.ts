/** 月评公告接口结构（前端与弹窗共用）。 */
export interface AnncTimeline {
  key: 'OPEN' | 'SELF' | 'PEER' | 'PUBLISH';
  label: string;
  at: string | null;
  state: 'done' | 'active' | 'upcoming' | 'missing';
  note: string;
}

export interface AnncData {
  canEdit: boolean;
  cycle: {
    id: string;
    month: string;
    title: string;
    status: string;
    openAt: string | null;
    selfCloseAt: string | null;
    closeAt: string | null;
    publishAt: string | null;
  } | null;
  phaseLabel: string;
  timeline: AnncTimeline[];
  announcement: {
    id: string | null;
    title: string;
    body: string;
    isPublished: boolean;
    updatedAt: string | null;
    customized: boolean;
  };
  autoBody: string;
  version: string;
}
