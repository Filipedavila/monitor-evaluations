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

function createRawQualwebReport() {
  return {
    type: 'evaluation',
    system: {
      page: {
        dom: { title: 'Home"Page', html: '<html></html>', elementCount: 42 },
      },
    },
  };
}

function createProcessedEvaluation() {
  return {
    metadata: {
      metadata: { title: 'Home"Page', url: 'https://example.com', evaluatedAt: '2026-01-01T00:00:00.000Z' },
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

      const { evaluationReport, evaluationData } = parser.parseEvaluation(
        createRawQualwebReport(),
      );

      expect(mockedProcessEvaluation).toHaveBeenCalledWith(createRawQualwebReport());
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

    it('throws for a null or non-object payload', () => {
      expect(() => parser.parseEvaluation(null)).toThrow(
        'Invalid evaluation: evaluation payload must be a non-null object.',
      );
    });

    it('throws when the raw payload is missing system.page.dom', () => {
      expect(() => parser.parseEvaluation({ type: 'evaluation' })).toThrow(
        /missing 'system.page.dom'/,
      );
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
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
