import Redis from 'ioredis';
import { REDIS_STREAMS } from '../../redis/types';
import { IMetricData } from '../types';

export class EvaluationProducer {
  constructor(private readonly redis: Redis) {}

  // TODO: define type for result
  async publishEvaluation(result: any) {
    const resultId = await this.redis.xadd(
      REDIS_STREAMS.ANALYTICS_EVALUATION_BUFFER,
      // TODO: define unique id strategy for idempotency
      '*',
      'url', result.url,
      'score', String(result.score),
      'timestamp', new Date().toISOString(),
    );
    if (!resultId) {
      throw new Error('Failed to publish evaluation result');
    }
    return resultId;
  }

  async publishEvaluations(results: IMetricData[]) {
    const resultIds: string[] = [];
    for (const result of results) {
      const resultId = await this.redis.xadd(
        REDIS_STREAMS.ANALYTICS_EVALUATION_BUFFER,
        // TODO: define unique id strategy for idempotency
        '*',
        'data', JSON.stringify(result)
      );
      if (!resultId) {
        throw new Error('Failed to publish evaluation result');
      }
      resultIds.push(resultId);
    }
    return resultIds;
  }
}
