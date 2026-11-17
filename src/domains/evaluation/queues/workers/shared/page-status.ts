import { DataSource } from 'typeorm';
import { EvaluationJobData } from '@evaluation/types';
import { PageTable } from './worker.types';
import { PageStatus } from '@evaluation/domain/evaluation.constants';

export type PageStatusValue = (typeof PageStatus)[keyof typeof PageStatus];

/** Atualiza o `page_status` na tabela deste worker (monitor vs ams). */
export function createPageStatusUpdater(dataSource: DataSource, table: PageTable) {
  return async function setPageStatus(
    status: PageStatusValue,
    pageId: EvaluationJobData['pageId'],
  ): Promise<void> {
    await dataSource.query(
      `
      UPDATE ${table}
      SET page_status = $1
      WHERE page_id = $2;
      `,
      [status, pageId],
    );
  };
}
