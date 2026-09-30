import { EventEmitter } from 'node:events';
import { EvaluationJobData } from '../evaluation/types';

export interface EvaluationEventMap {
  'evaluation.active': EvaluationJobData;
  'evaluation.completed': EvaluationJobData;
  'evaluation.failed': { jobData: EvaluationJobData; error: string };
}

export class EvaluationEventBus {
  private readonly emitter = new EventEmitter();

  emit<K extends keyof EvaluationEventMap>(event: K, payload: EvaluationEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof EvaluationEventMap>(
    event: K,
    listener: (payload: EvaluationEventMap[K]) => void,
  ): void {
    this.emitter.on(event, listener);
  }
}
