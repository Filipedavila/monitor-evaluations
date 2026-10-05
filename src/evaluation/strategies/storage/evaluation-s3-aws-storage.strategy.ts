import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { ReadStream } from 'node:fs';
import { EvaluationIdentifier, SafePaths, EvaluationFileType } from '../../types';
import {
  EvaluationStorage,
  EvaluationStoragePayload,
} from '../../contracts/evaluation-storage.contract';

import { Logger } from '../../../logger/logger';

const asyncGzip = promisify(gzip);

export class EvaluationFileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationFileNotFoundError';
  }
}

interface EvaluationFileKeys {
  htmlKey: string;
  nodesKey: string;
}

export class EvaluationS3StorageStrategy implements EvaluationStorage {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly s3Prefix = 'evaluations/';

  private readonly HTML_FILE_COMPRESSED_SUFFIX = '.html.gz';
  private readonly NODES_FILE_COMPRESSED_SUFFIX = '_nodes.json.gz';

  constructor(private readonly logger: Logger) {
    this.bucketName = process.env.AWS_S3_BUCKET_NAME || '';
    if (!this.bucketName) {
      this.logger.warn('AWS_S3_BUCKET_NAME is not defined in environment variables.');
    }

    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || 'eu-west-3',
    });
  }

  /**
   * No S3 não é necessário criar diretórios fisicamente. Mantido para cumprir o contrato.
   */
  async init(): Promise<void> {
    this.logger.log('EvaluationS3StorageStrategy initialized.');
  }

  private buildSafePaths(evalIdentifier: EvaluationIdentifier): SafePaths {
    const safeDate = new Date(evalIdentifier.evaluationDate).toISOString().slice(0, 10);
    const targetDir = `${this.s3Prefix}${safeDate}/${evalIdentifier.websiteId}`;
    const baseFileName = `${evalIdentifier.pageId}_${evalIdentifier.evaluationId}`;

    return { targetDir, baseFileName };
  }

  private buildFileKeys(targetDir: string, baseFileName: string): EvaluationFileKeys {
    return {
      htmlKey: `${targetDir}/${baseFileName}${this.HTML_FILE_COMPRESSED_SUFFIX}`,
      nodesKey: `${targetDir}/${baseFileName}${this.NODES_FILE_COMPRESSED_SUFFIX}`,
    };
  }

  private getFileKeyForType(
    targetDir: string,
    baseFileName: string,
    fileType: EvaluationFileType,
  ): string {
    const fileName =
      fileType === 'html'
        ? `${baseFileName}${this.HTML_FILE_COMPRESSED_SUFFIX}`
        : `${baseFileName}${this.NODES_FILE_COMPRESSED_SUFFIX}`;
    return `${targetDir}/${fileName}`;
  }

  private validateFileType(fileType: EvaluationFileType): void {
    if (fileType !== 'html' && fileType !== 'nodes') {
      throw new EvaluationFileNotFoundError(
        `Invalid file type requested: ${fileType}. Must be 'html' or 'nodes'.`,
      );
    }
  }

  /**
   * Remove uma chave do S3 de forma idempotente, ignorando se não existir.
   */
  private async safeDeleteKey(key: string): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: { Objects: [{ Key: key }] },
        }),
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to safely delete S3 key: ${key}. Reason: ${errorMessage}`);
    }
  }

  async save(payload: EvaluationStoragePayload): Promise<void> {
    const { targetDir, baseFileName } = this.buildSafePaths(payload.evalIdentifier);
    const { htmlKey, nodesKey } = this.buildFileKeys(targetDir, baseFileName);
    this.logger.log(
      `[S3Storage] Attempting to save evaluation ID: ${payload.evalIdentifier.evaluationId} to S3 bucket: ${this.bucketName}`,
    );

    try {
      const [htmlGzipped, nodesGzipped] = await Promise.all([
        asyncGzip(Buffer.from(payload.htmlContent, 'utf8')),
        asyncGzip(Buffer.from(payload.nodes, 'utf8')),
      ]);

      await Promise.all([
        this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: htmlKey,
            Body: htmlGzipped,
            ContentType: 'text/html',
            ContentEncoding: 'gzip',
          }),
        ),
        this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: nodesKey,
            Body: nodesGzipped,
            ContentType: 'application/json',
            ContentEncoding: 'gzip',
          }),
        ),
      ]);
    } catch (error) {
      await Promise.all([this.safeDeleteKey(htmlKey), this.safeDeleteKey(nodesKey)]);

      this.logger.error(
        `Failed to save evaluation files to S3 for ID: ${payload.evalIdentifier.evaluationId}`,
        error,
      );
      throw error;
    }
  }

  public async getStream(
    evaluationIdentifier: EvaluationIdentifier,
    fileType: EvaluationFileType,
  ): Promise<ReadStream> {
    const { targetDir, baseFileName } = this.buildSafePaths(evaluationIdentifier);
    this.validateFileType(fileType);
    const fullKey = this.getFileKeyForType(targetDir, baseFileName, fileType);

    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: fullKey,
        }),
      );

      if (!response.Body) {
        throw new EvaluationFileNotFoundError(
          `File body is empty for Evaluation ID: ${evaluationIdentifier.evaluationId}`,
        );
      }

      return response.Body as unknown as ReadStream;
    } catch (error: any) {
      if (
        error.name === 'NoSuchKey' ||
        error.name === 'NotFound' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        throw new EvaluationFileNotFoundError(
          `File not found in S3 for Evaluation ID: ${evaluationIdentifier.evaluationId}`,
        );
      }
      throw error;
    }
  }

  public async exists(evaluationIdentifier: EvaluationIdentifier): Promise<boolean> {
    const { targetDir, baseFileName } = this.buildSafePaths(evaluationIdentifier);
    const { htmlKey, nodesKey } = this.buildFileKeys(targetDir, baseFileName);

    try {
      await Promise.all([
        this.s3Client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: htmlKey })),
        this.s3Client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: nodesKey })),
      ]);
      return true;
    } catch (error: any) {
      if (
        error.name === 'NoSuchKey' ||
        error.name === 'NotFound' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw error;
    }
  }

  async delete(evaluationIdentifier: EvaluationIdentifier): Promise<void> {
    const { targetDir, baseFileName } = this.buildSafePaths(evaluationIdentifier);
    const { htmlKey, nodesKey } = this.buildFileKeys(targetDir, baseFileName);

    try {
      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: {
            Objects: [{ Key: htmlKey }, { Key: nodesKey }],
            Quiet: true,
          },
        }),
      );

      this.logger.log(
        `Evaluation files successfully deleted from S3 for ID: ${evaluationIdentifier.evaluationId}`,
      );
    } catch (error) {
      this.logger.error(
        `Unexpected error deleting evaluation files from S3 for ID: ${evaluationIdentifier.evaluationId}`,
        error,
      );
      throw error;
    }
  }
}
