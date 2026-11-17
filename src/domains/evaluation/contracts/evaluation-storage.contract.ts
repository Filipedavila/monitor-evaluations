import { EvaluationIdentifier } from '../types';

export interface EvaluationStoragePayload {
  evalIdentifier: EvaluationIdentifier;
  htmlContent: string;
  nodes: any;
  conformance: any;
}

export interface EvaluationStorage {
  save(payload: EvaluationStoragePayload): Promise<any>;
  delete(evaluationIdentifier: EvaluationIdentifier): Promise<void>;
}
