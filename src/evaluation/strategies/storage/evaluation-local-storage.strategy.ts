import * as fs from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { createReadStream, ReadStream } from 'node:fs';
import { EvaluationIdentifier, SafePaths, EvaluationFileType } from '../../types';
import {
  EvaluationStorage,
  EvaluationStoragePayload,
} from '../../contracts/evaluation-storage.contract';

import { saveAsGzip } from '../../../common/utils/utils';
import { computeHash } from '../../../common/utils/crypto';
import { Logger } from '../../../logger/logger';

export class EvaluationFileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationFileNotFoundError';
  }
}

interface EvaluationFilePaths {
  htmlPath: string;
  nodesPath: string;
  hashPath: string;
  htmlHashPath: string;
}

export class EvaluationLocalStorageStrategy implements EvaluationStorage {
  private readonly BASE_PATH = normalize(join(process.cwd(), 'storage/evaluations'));

  private readonly HTML_FILE_COMPRESSED_SUFFIX = '.html.gz';
  private readonly NODES_FILE_COMPRESSED_SUFFIX = '_nodes.json.gz';
  private readonly HTML_FILE_HASH_SUFFIX = '.html.sha256';
  private readonly HASH_FILE_SUFFIX = '_nodes.json.sha256';

  constructor(private readonly logger: Logger) {}

  async init(): Promise<void> {
    await fs.mkdir(this.BASE_PATH, { recursive: true });
  }

  private buildSafePaths(evalIdentifier: EvaluationIdentifier): SafePaths {
    const safeDate = new Date(evalIdentifier.evaluationDate).toISOString().slice(0, 10);
    const targetDir = join(this.BASE_PATH, safeDate, `${evalIdentifier.websiteId}`);
    const baseFileName = `${evalIdentifier.pageId}_${evalIdentifier.evaluationId}`;

    return { targetDir, baseFileName };
  }

  private buildFilePaths(targetDir: string, baseFileName: string): EvaluationFilePaths {
    return {
      htmlPath: join(targetDir, `${baseFileName}${this.HTML_FILE_COMPRESSED_SUFFIX}`),
      nodesPath: join(targetDir, `${baseFileName}${this.NODES_FILE_COMPRESSED_SUFFIX}`),
      hashPath: join(targetDir, `${baseFileName}${this.HASH_FILE_SUFFIX}`),
      htmlHashPath: join(targetDir, `${baseFileName}${this.HTML_FILE_HASH_SUFFIX}`),
    };
  }

  private getFilePathForType(
    targetDir: string,
    baseFileName: string,
    fileType: EvaluationFileType,
  ): string {
    const fileName =
      fileType === 'html'
        ? `${baseFileName}${this.HTML_FILE_COMPRESSED_SUFFIX}`
        : `${baseFileName}${this.NODES_FILE_COMPRESSED_SUFFIX}`;
    return join(targetDir, fileName);
  }

  private validateFileType(fileType: EvaluationFileType): void {
    if (fileType !== 'html' && fileType !== 'nodes') {
      throw new EvaluationFileNotFoundError(
        `Invalid file type requested: ${fileType}. Must be 'html' or 'nodes'.`,
      );
    }
  }

  private generateFileHash(data: string, evalIdentifier: EvaluationIdentifier): string {
    return computeHash(
      data + evalIdentifier.evaluationDate + evalIdentifier.websiteId + evalIdentifier.pageId,
    );
  }

  private isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
  }

  /**
   * Remove ficheiros de forma idempotente, tratando ENOENT como no-op.
   */
  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error: unknown) {
      if (this.isNodeError(error) && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  async save(payload: EvaluationStoragePayload): Promise<void> {
    const { targetDir, baseFileName } = this.buildSafePaths(payload.evalIdentifier);
    const { htmlPath, nodesPath, hashPath, htmlHashPath } = this.buildFilePaths(
      targetDir,
      baseFileName,
    );

    const htmlHash = this.generateFileHash(payload.htmlContent, payload.evalIdentifier);
    const nodesHash = this.generateFileHash(JSON.stringify(payload.nodes), payload.evalIdentifier);

    try {
      await fs.mkdir(targetDir, { recursive: true });

      await Promise.allSettled([
        saveAsGzip(payload.htmlContent, htmlPath),
        saveAsGzip(payload.nodes, nodesPath),
        fs.writeFile(hashPath, nodesHash, 'utf8'),
        fs.writeFile(htmlHashPath, htmlHash, 'utf8'),
      ]);
    } catch (error) {
      await Promise.all([
        this.safeUnlink(htmlPath),
        this.safeUnlink(nodesPath),
        this.safeUnlink(hashPath),
        this.safeUnlink(htmlHashPath),
      ]);

      this.logger.error(
        `Failed to save evaluation files for ID: ${payload.evalIdentifier.evaluationId}`,
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
    const fullPath = this.getFilePathForType(targetDir, baseFileName, fileType);

    try {
      await fs.access(fullPath, fs.constants.R_OK);
    } catch {
      throw new EvaluationFileNotFoundError(
        `File not found for Evaluation ID: ${evaluationIdentifier.evaluationId}`,
      );
    }

    return createReadStream(fullPath);
  }

  public async exists(evaluationIdentifier: EvaluationIdentifier): Promise<boolean> {
    const { targetDir, baseFileName } = this.buildSafePaths(evaluationIdentifier);
    const { htmlPath, nodesPath } = this.buildFilePaths(targetDir, baseFileName);

    try {
      await Promise.all([
        fs.access(htmlPath, fs.constants.F_OK),
        fs.access(nodesPath, fs.constants.F_OK),
      ]);
      return true;
    } catch (error: unknown) {
      if (this.isNodeError(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async delete(evaluationIdentifier: EvaluationIdentifier): Promise<void> {
    const { targetDir, baseFileName } = this.buildSafePaths(evaluationIdentifier);
    const { htmlPath, nodesPath, hashPath, htmlHashPath } = this.buildFilePaths(
      targetDir,
      baseFileName,
    );

    try {
      await Promise.all([
        this.safeUnlink(htmlPath),
        this.safeUnlink(nodesPath),
        this.safeUnlink(hashPath),
        this.safeUnlink(htmlHashPath),
      ]);

      this.logger.log(
        `Evaluation files successfully deleted for ID: ${evaluationIdentifier.evaluationId}`,
      );
    } catch (error) {
      this.logger.error(
        `Unexpected error deleting evaluation files for ID: ${evaluationIdentifier.evaluationId}`,
        error,
      );
      throw error;
    }
  }
}
