import Redis from 'ioredis';
import { REDIS_STREAMS } from '../../redis/types';
import { IMetricData } from '../types';

export class EvaluationProducer {
  private static readonly STREAM_MAX_LEN = 50000;
  private static readonly PRODUCER_ID = 'eval-producer-node-1';

  constructor(private readonly redis: Redis) {}

  async publishEvaluations(results: IMetricData[]): Promise<string | null> {
    if (results.length === 0) return null;

    const { evaluation_id, website_id, page_id, evaluation_date } = results[0];
    const streamKey = REDIS_STREAMS.ANALYTICS_EVALUATION_BUFFER;

    const idempotentId = `${evaluation_id}:${website_id}:${page_id}:${evaluation_date}`;

    const streamId = await this.redis.xadd(
      streamKey,
      'MAXLEN',
      '~',
      EvaluationProducer.STREAM_MAX_LEN,
      'IDMP',
      EvaluationProducer.PRODUCER_ID,
      idempotentId,
      '*',
      'data',
      JSON.stringify(results),
    );
    return streamId;
  }
}
