import { createHash } from 'crypto';

import { EvaluationParserService } from './evaluation-parser.service';

import { getRuleMetadata, processEvaluation } from '@a12e/accessmonitor-rulesets';

jest.mock('@a12e/accessmonitor-rulesets', () => ({
  getRuleMetadata: jest.fn(),

  processEvaluation: jest.fn(),
}));

const mockedGetRuleMetadata = getRuleMetadata as jest.Mock;

const mockedProcessEvaluation = processEvaluation as jest.Mock;

function createLoggerMock() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function createRawQualwebReport(): any {
  return {
    type: 'evaluation',

    system: {
      page: {
        dom: { title: 'Home"Page', html: '<html></html>', elementCount: 42 },
      },
    },

    metadata: { some: 'metadata' },

    modules: { 'act-rules': {} },
  };
}

function createProcessedEvaluation() {
  return {
    metadata: {
      metadata: {
        title: 'Home"Page',
        url: 'https://example.com',
        evaluatedAt: '2026-01-01T00:00:00.000Z',
      },

      telemetry: { totalHtmlTags: 42, tagCounter: {}, roles: {} },
    },

    html: { html: '<html></html>', pageSize: 10 },

    elementCounters: {},

    conformanceResults: {},

    assertionEvidence: {},

    rulesOccurrences: { 'rule-a': 2 },

    scoreDetails: { totalTests: 10, conform: '1@2@3', score: '8.5' },
  };
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

describe('EvaluationParserService', () => {
  let parser: EvaluationParserService;

  beforeEach(() => {
    parser = new EvaluationParserService(createLoggerMock());

    mockedGetRuleMetadata.mockReset();

    mockedProcessEvaluation.mockReset();
  });

  describe('parseEvaluation', () => {
    it('normalizes a raw QualWeb report into the internal evaluation entity', () => {
      mockedProcessEvaluation.mockReturnValue(createProcessedEvaluation());

      const { evaluationReport, evaluationData } = parser.parseEvaluation(createRawQualwebReport());

      expect(evaluationReport.scoring.conform).toBe('1@2@3');

      expect(evaluationData).toEqual({
        title: 'HomePage',

        score: '8.5',

        A: 1,

        AA: 2,

        AAA: 3,

        createdAt: '2026-01-01T00:00:00.000Z',

        tagCount: 42,
      });
    });

    it('passes the raw report to processEvaluation', () => {
      // The service clears the raw report after processing, so snapshot the

      // argument at call time instead of relying on the mutated reference.

      let received: unknown;

      mockedProcessEvaluation.mockImplementation((report: unknown) => {
        received = structuredClone(report);

        return createProcessedEvaluation();
      });

      parser.parseEvaluation(createRawQualwebReport());

      expect(mockedProcessEvaluation).toHaveBeenCalledTimes(1);

      expect(received).toEqual(createRawQualwebReport());
    });

    it('clears the raw report after processing to free memory', () => {
      mockedProcessEvaluation.mockReturnValue(createProcessedEvaluation());

      const rawReport = createRawQualwebReport();

      parser.parseEvaluation(rawReport);

      expect(rawReport.system).toBeNull();

      expect(rawReport.metadata).toBeNull();

      expect(rawReport.modules).toBeNull();
    });

    it('builds the audit report from the processed evaluation', () => {
      const processed = createProcessedEvaluation();

      mockedProcessEvaluation.mockReturnValue(processed);

      const { evaluationReport } = parser.parseEvaluation(createRawQualwebReport());

      expect(evaluationReport).toEqual({
        metadata: processed.metadata.metadata,

        snapshot: {
          html: '<html></html>',

          sizeInBytes: 10,

          hash: md5('2026-01-01T00:00:00.000Z'),
        },

        telemetry: {
          elementCounters: {},

          roles: {},

          tagCounter: {},

          totalHtmlTags: 42,
        },

        scoring: {
          conform: '1@2@3',

          totalTests: 10,

          score: '8.5',

          rulesOccurrences: { 'rule-a': 2 },

          assertionEvidence: {},

          conformanceResults: {},
        },
      });
    });

    it('wraps processing failures and preserves the original error as cause', () => {
      const original = new Error('boom');

      mockedProcessEvaluation.mockImplementation(() => {
        throw original;
      });

      let thrown: any;

      try {
        parser.parseEvaluation(createRawQualwebReport());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);

      expect(thrown.message).toBe('Failed to parse evaluation entity: boom');

      expect(thrown.cause).toBe(original);
    });

    it('wraps non-Error failures using their string representation', () => {
      mockedProcessEvaluation.mockImplementation(() => {
        throw 'plain failure';
      });

      expect(() => parser.parseEvaluation(createRawQualwebReport())).toThrow(
        'Failed to parse evaluation entity: plain failure',
      );
    });

    it('throws for a null or non-object payload', () => {
      const message = 'Invalid evaluation: evaluation payload must be a non-null object.';

      expect(() => parser.parseEvaluation(null)).toThrow(message);

      expect(() => parser.parseEvaluation('not-an-object')).toThrow(message);

      expect(mockedProcessEvaluation).not.toHaveBeenCalled();
    });

    it('throws when the raw payload is missing system.page.dom', () => {
      expect(() => parser.parseEvaluation({ type: 'evaluation' })).toThrow(
        /missing 'system.page.dom'/,
      );

      expect(() => parser.parseEvaluation({ type: 'evaluation', system: {} })).toThrow(
        /missing 'system.page.dom'/,
      );

      expect(() => parser.parseEvaluation({ type: 'evaluation', system: { page: {} } })).toThrow(
        /missing 'system.page.dom'/,
      );
    });

    it('includes the raw payload type in the structure error', () => {
      expect(() => parser.parseEvaluation({ type: 'evaluation' })).toThrow(
        /Raw payload type: evaluation/,
      );

      expect(() => parser.parseEvaluation({})).toThrow(/Raw payload type: unknown/);
    });

    it('does not wrap validation errors or call processEvaluation for invalid payloads', () => {
      expect(() => parser.parseEvaluation({ type: 'evaluation' })).not.toThrow(
        /Failed to parse evaluation entity/,
      );

      expect(mockedProcessEvaluation).not.toHaveBeenCalled();
    });
  });

  describe('parseIngestionMetrics', () => {
    it('maps each metric entry using rule metadata', () => {
      mockedGetRuleMetadata.mockImplementation((key: string) => ({
        rule_id: `${key}-id`,

        rule_result: 'failed',
      }));

      const result = parser.parseIngestionMetrics(
        1,

        [10],

        20,

        30,

        40,

        '8.5',

        '2026-01-01T00:00:00.000Z',

        { 'rule-a': 3 },
      );

      expect(result).toEqual([
        {
          evaluation_id: 1,

          directories_ids: [10],

          institution_id: 20,

          website_id: 30,

          page_id: 40,

          evaluation_date: '2026-01-01T00:00:00.000Z',

          score: 8.5,

          rule_id: 'rule-a-id',

          count: 3,

          rule_result: 'failed',
        },
      ]);
    });

    it('returns an empty list when there are no metrics', () => {
      const result = parser.parseIngestionMetrics(
        1,

        [10],

        20,

        30,

        40,

        '8.5',

        '2026-01-01T00:00:00.000Z',

        {},
      );

      expect(result).toEqual([]);

      expect(mockedGetRuleMetadata).not.toHaveBeenCalled();
    });

    it('skips metrics whose rule metadata lookup fails', () => {
      mockedGetRuleMetadata.mockImplementation(() => {
        throw new Error('unknown rule');
      });

      const logger = createLoggerMock();

      parser = new EvaluationParserService(logger);

      const result = parser.parseIngestionMetrics(
        1,

        [10],

        20,

        30,

        40,

        '8.5',

        '2026-01-01T00:00:00.000Z',

        { 'rule-a': 3 },
      );

      expect(result).toEqual([]);

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse metric for rule rule-a: unknown rule',
      );
    });

    it('keeps valid metrics and skips only the ones that fail', () => {
      mockedGetRuleMetadata.mockImplementation((key: string) => {
        if (key === 'bad-rule') {
          throw new Error('unknown rule');
        }

        return { rule_id: `${key}-id`, rule_result: 'passed' };
      });

      const logger = createLoggerMock();

      parser = new EvaluationParserService(logger);

      const result = parser.parseIngestionMetrics(
        1,

        [10],

        20,

        30,

        40,

        '8.5',

        '2026-01-01T00:00:00.000Z',

        { 'good-rule': 1, 'bad-rule': 2 },
      );

      expect(result).toHaveLength(1);

      expect(result[0]).toMatchObject({ rule_id: 'good-rule-id', count: 1, rule_result: 'passed' });

      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });
});
