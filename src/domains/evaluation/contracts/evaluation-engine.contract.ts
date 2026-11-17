export interface EvaluationEngine {
  evaluate(url: string): Promise<any>;
}