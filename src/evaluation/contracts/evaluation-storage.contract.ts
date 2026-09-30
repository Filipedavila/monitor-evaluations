import { EvaluationFileType, EvaluationIdentifier } from "../types";
import { ReadStream } from "node:fs";

export interface EvaluationStoragePayload {
    evalIdentifier: EvaluationIdentifier;
    htmlContent: string;
    nodes: any;
}


export interface EvaluationStorage {
  save(payload:EvaluationStoragePayload): Promise<any>;
  getStream(evaluationId:EvaluationIdentifier,fileType: EvaluationFileType):Promise<ReadStream>;
  exists(evaluationId:EvaluationIdentifier):Promise<boolean>;
  delete(evaluationId:EvaluationIdentifier):Promise<void>;
}