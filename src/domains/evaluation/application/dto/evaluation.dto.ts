export interface EvaluationDTO {
  id: number;
  pageId: number;
  pageTitle: string | null;
  score: string | null;
  A: number | null;
  AA: number | null;
  AAA: number | null;
  tagCount: number | null;
  evaluationDate: Date | null;
  frozenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: number | null;
  updatedById: number | null;
}
