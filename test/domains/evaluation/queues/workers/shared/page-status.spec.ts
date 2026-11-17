import type { DataSource } from 'typeorm';
import { createPageStatusUpdater } from '@evaluation/queues/workers/shared/page-status';
import { PageStatus } from '@evaluation/domain/evaluation.constants';

function setup(table: 'page_contexts_monitor' | 'page_contexts_ams') {
  const query = jest.fn().mockResolvedValue([]);
  const dataSource = { query } as unknown as DataSource;
  return { query, setPageStatus: createPageStatusUpdater(dataSource, table) };
}

describe('createPageStatusUpdater', () => {
  it.each(['page_contexts_monitor', 'page_contexts_ams'] as const)(
    'runs a parameterised UPDATE on %s',
    async (table) => {
      const { query, setPageStatus } = setup(table);

      await setPageStatus(PageStatus.FAILED, 10);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(
        new RegExp(`UPDATE ${table}\\s+SET page_status = \\$1\\s+WHERE page_id = \\$2`),
      );
      expect(params).toEqual([PageStatus.FAILED, 10]);
    },
  );

  it('never inlines the values into the SQL text', async () => {
    const { query, setPageStatus } = setup('page_contexts_monitor');

    await setPageStatus(PageStatus.FAILED, 777);

    expect(query.mock.calls[0][0]).not.toContain('777');
  });

  it('resolves to undefined', async () => {
    const { setPageStatus } = setup('page_contexts_monitor');

    await expect(setPageStatus(PageStatus.FAILED, 10)).resolves.toBeUndefined();
  });

  it('propagates database errors', async () => {
    const { query, setPageStatus } = setup('page_contexts_monitor');
    const error = new Error('db down');
    query.mockRejectedValue(error);

    await expect(setPageStatus(PageStatus.FAILED, 10)).rejects.toBe(error);
  });
});
