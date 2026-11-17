import { S3Client, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { EvaluationIdentifier, SafePaths } from '../../types';
import { EvaluationArtifact } from '@evaluation/domain/entities/evaluation-artifacts.entity';
import {
  EvaluationStorage,
  EvaluationStoragePayload,
} from '../../contracts/evaluation-storage.contract';

import { Logger } from '@infrastructure/logger/logger';
import { Repository } from 'typeorm';

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
  conformanceKey: string;
}

export class EvaluationS3StorageStrategy implements EvaluationStorage {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly s3Prefix = 'evaluations/';

  private readonly HTML_FILE_COMPRESSED_SUFFIX = '.html.gz';
  private readonly NODES_FILE_COMPRESSED_SUFFIX = '_nodes.json.gz';
  private readonly CONFORMANCE_FILE_COMPRESSED_SUFFIX = '_conformance.json.gz';

  constructor(
    private readonly logger: Logger,
    private readonly artifactRepository: Repository<EvaluationArtifact>,
  ) {
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
      conformanceKey: `${targetDir}/${baseFileName}${this.CONFORMANCE_FILE_COMPRESSED_SUFFIX}`,
    };
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

  private serializeContent(content: unknown): string | undefined {
    return typeof content === 'string' ? content : JSON.stringify(content);
  }

  async save(payload: EvaluationStoragePayload): Promise<void> {
    const { targetDir, baseFileName } = this.buildSafePaths(payload.evalIdentifier);
    const { htmlKey, nodesKey, conformanceKey } = this.buildFileKeys(targetDir, baseFileName);
    this.logger.log(
      `[S3Storage] Attempting to save evaluation ID: ${payload.evalIdentifier.evaluationId} to S3 bucket: ${this.bucketName}`,
    );

    try {
      const htmlString = this.serializeContent(payload.htmlContent);
      const nodesString = this.serializeContent(payload.nodes);
      const conformanceString = this.serializeContent(payload.conformance);

      if (!htmlString || !nodesString || !conformanceString) {
        throw new Error(
          `Payload inválido para S3: htmlContent, nodes ou conformance estão vazios.`,
        );
      }

      const [htmlGzipped, nodesGzipped, conformanceGzipped] = await Promise.all([
        asyncGzip(Buffer.from(htmlString, 'utf8')),
        asyncGzip(Buffer.from(nodesString, 'utf8')),
        asyncGzip(Buffer.from(conformanceString, 'utf8')),
      ]);
      // 1. Upload paralelo para o S3 (guardamos a resposta para obter o ETag)
      const [htmlRes, nodesRes, conformanceRes] = await Promise.all([
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
        this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: conformanceKey,
            Body: conformanceGzipped,
            ContentType: 'application/json',
            ContentEncoding: 'gzip',
          }),
        ),
      ]);

      if (!htmlRes.ETag || !nodesRes.ETag || !conformanceRes.ETag) {
        throw new Error(`Failed to obtain ETag for uploaded S3 objects.`);
      }
      // 2. Upsert atómico no PostgreSQL incluindo storageKey e ETag
      await this.artifactRepository.upsert(
        [
          {
            evaluationId: payload.evalIdentifier.evaluationId,
            artifactType: 'html',
            storageKey: htmlKey,
            fileSize: htmlGzipped.byteLength,
            mimeType: 'text/html',
            ETag: htmlRes.ETag?.replace(/"/g, ''),
          },
          {
            evaluationId: payload.evalIdentifier.evaluationId,
            artifactType: 'assertions',
            storageKey: nodesKey,
            fileSize: nodesGzipped.byteLength,
            mimeType: 'application/json',
            ETag: nodesRes.ETag?.replace(/"/g, ''),
          },
          {
            evaluationId: payload.evalIdentifier.evaluationId,
            artifactType: 'conformance',
            storageKey: conformanceKey,
            fileSize: conformanceGzipped.byteLength,
            mimeType: 'application/json',
            ETag: conformanceRes.ETag?.replace(/"/g, ''),
          },
        ],
        {
          conflictPaths: ['evaluationId', 'artifactType'],
          skipUpdateIfNoValuesChanged: true,
        },
      );
    } catch (error) {
      await Promise.all([
        this.safeDeleteKey(htmlKey),
        this.safeDeleteKey(nodesKey),
        this.safeDeleteKey(conformanceKey),
      ]);

      this.logger.error(
        `Failed to save evaluation files to S3 for ID: ${payload.evalIdentifier.evaluationId}`,
        error,
      );
      throw error;
    }
  }

  async delete(evaluationIdentifier: EvaluationIdentifier): Promise<void> {
    // Usa as storageKeys registadas na BD, cobrindo todos os artefactos (html, assertions, conformance, ...)
    const artifacts = await this.artifactRepository.find({
      where: { evaluationId: evaluationIdentifier.evaluationId },
    });
    if (artifacts.length === 0) {
      return;
    }

    try {
      const s3Response = await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: {
            Objects: artifacts.map((artifact) => ({ Key: artifact.storageKey })),
            Quiet: true,
          },
        }),
      );
      if (s3Response.Errors && s3Response.Errors.length > 0) {
        throw new Error(`S3 partial delete failure: ${JSON.stringify(s3Response.Errors)}`);
      }
      await this.artifactRepository.delete({
        evaluationId: evaluationIdentifier.evaluationId,
      });
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
