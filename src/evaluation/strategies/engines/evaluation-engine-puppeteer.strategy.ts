import { QualWeb, QualwebOptions } from '@qualweb/core';
import { ACTRules } from '@qualweb/act-rules';
import { WCAGTechniques } from '@qualweb/wcag-techniques';
import { BestPractices } from '@qualweb/best-practices';
import { Counter } from '@qualweb/counter';
import { z } from 'zod';
import { EvaluationEngine } from '../../contracts/evaluation-engine.contract';
import { createLogger } from '../../../logger/logger';

const QUALWEB_START_TIMEOUT = 30_000;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const LANGUAGE = 'pt-pt,pt';

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--disable-blink-features=AutomationControlled',
  '--disable-extensions',
  '--no-zygote',
  '--js-flags=--max-old-space-size=512', 
  `--user-agent=${USER_AGENT}`,
  `--lang=${LANGUAGE}`,
];

const UrlSchema = z
  .string()
  .url()
  .refine(
    (val) => {
      try {
        const parsed = new URL(val);
        const host = parsed.hostname.toLowerCase();
        return !['localhost', '127.0.0.1', '169.254.169.254', '0.0.0.0'].includes(host);
      } catch {
        return false;
      }
    },
    { message: 'URL resolve para um endereço restrito ou inválido (SSRF Protection).' },
  );

export class QualWebPuppeteerEngine implements EvaluationEngine {
  private readonly logger = createLogger(QualWebPuppeteerEngine.name);

  private createModules(): any[] {
    return [
      new ACTRules({ exclude: [] }),
      new WCAGTechniques(),
      new BestPractices(),
      new Counter(),
    ];
  }

  private createEvaluationOptions(url: string): QualwebOptions {
    return {
      modules: this.createModules(),
      waitUntil: ['load', 'networkidle2'],
      log: { file: false },
      url,
    };
  }

  private validateReports(reports: any | null | undefined, url: string): void {
    if (!reports || typeof reports !== 'object') {
      throw new Error('Invalid report: QualWeb returned null or invalid data.');
    }

    if (Object.keys(reports).length === 0) {
      throw new Error(`Invalid resource: QualWeb returned an empty report for URL: ${url}`);
    }
  }

  public async evaluate(url: string): Promise<any> {
    const parseResult = UrlSchema.safeParse(url);
    if (!parseResult.success) {
      throw new Error(
        `Invalid evaluation parameter: URL must be a valid format. Details: ${parseResult.error.message}`,
      );
    }

    const targetUrl = parseResult.data;

    const qualweb = new QualWeb({
      adBlock: true,
      stealth: true,
    });

    try {
      await qualweb.start(
        {
          maxConcurrency: 1,
          timeout: QUALWEB_START_TIMEOUT,
        },
        {
          headless: true,
          args: BROWSER_ARGS,
        },
      );

      const options = this.createEvaluationOptions(targetUrl);
      const reports = await qualweb.evaluate(options);

      this.validateReports(reports, targetUrl);

      const reportKey =
        Object.keys(reports).find(
          (key) => key.replace(/\/$/, '') === targetUrl.replace(/\/$/, ''),
        ) || Object.keys(reports)[0];

      const evaluationReport = reports[reportKey];

      if (!evaluationReport) {
        throw new Error(`QualWeb evaluation output missing report payload for URL: ${targetUrl}`);
      }

      return evaluationReport;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`QualWeb evaluation failed for URL ${targetUrl}: ${errorMsg}`);
      throw new Error(`QualWeb evaluation failed: ${errorMsg}`, { cause: error });
    } finally {
      await qualweb.stop().catch((cleanupError) => {
        const cleanupMsg =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        this.logger.warn(`Failed to cleanly stop QualWeb for URL ${targetUrl}: ${cleanupMsg}`);
      });
    }
  }
}
