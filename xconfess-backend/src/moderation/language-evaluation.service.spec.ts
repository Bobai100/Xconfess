// src/moderation/language-evaluation.service.spec.ts
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AiModerationService,
  ModerationCategory,
  ModerationStatus,
} from './ai-moderation.service';
import { LanguageEvaluationService } from './language-evaluation.service';
import {
  EvaluationCorpusItem,
  SupportedEvaluationLanguage,
  SUPPORTED_EVALUATION_LANGUAGES,
} from './language-evaluation.types';
import { DEFAULT_MULTILINGUAL_CORPUS } from './multilingual-corpus';

describe('LanguageEvaluationService', () => {
  let service: LanguageEvaluationService;
  let aiModerationService: jest.Mocked<AiModerationService>;

  beforeEach(async () => {
    const mockAiService = {
      moderateContent: jest.fn().mockImplementation((content: string) => {
        // Simple deterministic rule for mock tests
        const isHarmful =
          content.includes('kill') ||
          content.includes('despise') ||
          content.includes('suicide') ||
          content.includes('bomb') ||
          content.includes('odiar') ||
          content.includes('suicidar');

        return Promise.resolve({
          score: isHarmful ? 0.9 : 0.1,
          flags: isHarmful ? [ModerationCategory.HATE_SPEECH] : [],
          status: isHarmful
            ? ModerationStatus.REJECTED
            : ModerationStatus.APPROVED,
          details: {},
          requiresReview: false,
        });
      }),
      getConfiguration: jest.fn().mockReturnValue({
        highThreshold: 0.8,
        mediumThreshold: 0.5,
        autoActionEnabled: true,
      }),
      scoreOffline: jest.fn().mockReturnValue(0.6),
      updateThresholds: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LanguageEvaluationService,
        {
          provide: AiModerationService,
          useValue: mockAiService,
        },
      ],
    }).compile();

    service = module.get<LanguageEvaluationService>(LanguageEvaluationService);
    aiModerationService = module.get(AiModerationService);
  });

  describe('policy impact preview and approval', () => {
    it('compares aggregate outcomes locally without calling moderation providers', () => {
      const report = service.previewPolicyImpact({
        highThreshold: 0.9,
        mediumThreshold: 0.7,
      });

      expect(report.fixtureCount).toBe(DEFAULT_MULTILINGUAL_CORPUS.length);
      expect(report.changedCount).toBe(report.fixtureCount);
      expect(report.unchangedCount).toBe(0);
      expect(report.transitions).toEqual({
        [`${ModerationStatus.FLAGGED}->${ModerationStatus.APPROVED}`]:
          report.fixtureCount,
      });
      expect(aiModerationService.scoreOffline).toHaveBeenCalledTimes(
        report.fixtureCount,
      );
      expect(aiModerationService.moderateContent).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain(
        DEFAULT_MULTILINGUAL_CORPUS[0].text,
      );
    });

    it('rejects rollout without explicit approval and leaves thresholds unchanged', () => {
      const preview = service.previewPolicyImpact({
        highThreshold: 0.9,
        mediumThreshold: 0.7,
      });

      expect(() =>
        service.approvePolicyImpact({
          previewId: preview.previewId,
          approved: false,
          proposedThresholds: {
            highThreshold: 0.9,
            mediumThreshold: 0.7,
          },
        }),
      ).toThrow('Policy rollout requires explicit approval.');
      expect(aiModerationService.updateThresholds).not.toHaveBeenCalled();
    });

    it('applies only matching approval once', () => {
      const proposedThresholds = {
        highThreshold: 0.9,
        mediumThreshold: 0.7,
      };
      const preview = service.previewPolicyImpact(proposedThresholds);

      expect(
        service.approvePolicyImpact({
          previewId: preview.previewId,
          approved: true,
          proposedThresholds,
        }),
      ).toEqual(proposedThresholds);
      expect(aiModerationService.updateThresholds).toHaveBeenCalledWith(0.9, 0.7);
      expect(() =>
        service.approvePolicyImpact({
          previewId: preview.previewId,
          approved: true,
          proposedThresholds,
        }),
      ).toThrow('No matching policy impact preview is pending.');
    });

    it('rejects changed proposals and invalid thresholds', () => {
      const preview = service.previewPolicyImpact({
        highThreshold: 0.9,
        mediumThreshold: 0.7,
      });

      expect(() =>
        service.approvePolicyImpact({
          previewId: preview.previewId,
          approved: true,
          proposedThresholds: {
            highThreshold: 0.95,
            mediumThreshold: 0.7,
          },
        }),
      ).toThrow('Approved thresholds do not match the previewed policy.');
      expect(() =>
        service.previewPolicyImpact({
          highThreshold: 0.4,
          mediumThreshold: 0.5,
        }),
      ).toThrow(BadRequestException);
      expect(aiModerationService.updateThresholds).not.toHaveBeenCalled();
    });

    it('rejects approval when the active policy changed after preview', () => {
      const proposedThresholds = {
        highThreshold: 0.9,
        mediumThreshold: 0.7,
      };
      const preview = service.previewPolicyImpact(proposedThresholds);
      aiModerationService.getConfiguration
        .mockReturnValueOnce({
          highThreshold: 0.85,
          mediumThreshold: 0.5,
          autoActionEnabled: true,
        });

      expect(() =>
        service.approvePolicyImpact({
          previewId: preview.previewId,
          approved: true,
          proposedThresholds,
        }),
      ).toThrow('The active policy changed after preview; run a new preview.');
      expect(aiModerationService.updateThresholds).not.toHaveBeenCalled();
    });
  });

  describe('runEvaluation (expected path)', () => {
    it('covers both labels for every supported language and policy category', () => {
      const sampleIds = DEFAULT_MULTILINGUAL_CORPUS.map((item) => item.id);
      expect(new Set(sampleIds).size).toBe(sampleIds.length);

      for (const language of SUPPORTED_EVALUATION_LANGUAGES) {
        for (const category of Object.values(ModerationCategory)) {
          for (const expectedHarmful of [true, false]) {
            expect(
              DEFAULT_MULTILINGUAL_CORPUS.some(
                (item) =>
                  item.language === language &&
                  item.category === category &&
                  item.expectedHarmful === expectedHarmful,
              ),
            ).toBe(true);
          }
        }
      }
    });

    it('evaluates the default multilingual corpus across all supported languages', async () => {
      const report = await service.runEvaluation();

      expect(report).toBeDefined();
      expect(report.evaluatedAt).toBeDefined();
      expect(report.totalSamples).toBeGreaterThan(0);
      expect(report.supportedLanguages).toEqual(
        expect.arrayContaining(['en', 'es', 'fr', 'de', 'ar', 'pt']),
      );
      expect(report.aggregate).toBeDefined();
      expect(report.aggregate.totalSamples).toBe(report.totalSamples);
      expect(report.byLanguage.en).toBeDefined();
      expect(report.byLanguage.es).toBeDefined();
      expect(report.byLanguage.fr).toBeDefined();
      expect(report.byCategory[ModerationCategory.HATE_SPEECH]).toBeDefined();
      expect(report.matrix.en?.[ModerationCategory.HATE_SPEECH]).toBeDefined();
    });

    it('filters evaluation by specified languages and categories', async () => {
      const report = await service.runEvaluation({
        languages: ['en', 'es'],
        categories: [ModerationCategory.HATE_SPEECH],
      });

      expect(report.supportedLanguages).toEqual(['en', 'es']);
      expect(report.policyCategories).toEqual([ModerationCategory.HATE_SPEECH]);
      expect(report.byLanguage.en).toBeDefined();
      expect(report.byLanguage.es).toBeDefined();
      expect(report.byLanguage.fr).toBeUndefined();
    });

    it('computes valid confusion matrix metrics (FPR, FNR, precision, recall, f1Score)', async () => {
      const customCorpus: EvaluationCorpusItem[] = [
        {
          id: 'test-1',
          language: 'en',
          category: ModerationCategory.HATE_SPEECH,
          text: 'I despise that group vermin',
          expectedHarmful: true,
        },
        {
          id: 'test-2',
          language: 'en',
          category: ModerationCategory.HATE_SPEECH,
          text: 'A wonderful cultural exchange',
          expectedHarmful: false,
        },
      ];

      const report = await service.runEvaluation({
        languages: ['en'],
        categories: [ModerationCategory.HATE_SPEECH],
        customCorpus,
      });

      expect(report.aggregate.totalSamples).toBe(2);
      expect(report.aggregate.truePositives).toBe(1);
      expect(report.aggregate.trueNegatives).toBe(1);
      expect(report.aggregate.falsePositives).toBe(0);
      expect(report.aggregate.falseNegatives).toBe(0);
      expect(report.aggregate.falsePositiveRate).toBe(0);
      expect(report.aggregate.falseNegativeRate).toBe(0);
      expect(report.aggregate.accuracy).toBe(1);
      expect(report.aggregate.f1Score).toBe(1);
    });

    it('does not treat a different flagged policy category as a positive prediction', async () => {
      aiModerationService.moderateContent.mockImplementation(
        (content: string) =>
          Promise.resolve({
            score: 0.95,
            flags:
              content === 'benign'
                ? [ModerationCategory.HATE_SPEECH]
                : [ModerationCategory.HARASSMENT],
            status: ModerationStatus.REJECTED,
            details: {},
            requiresReview: true,
          }),
      );
      const customCorpus: EvaluationCorpusItem[] = [
        {
          id: 'wrong-category',
          language: 'en',
          category: ModerationCategory.HATE_SPEECH,
          text: 'harmful',
          expectedHarmful: true,
        },
        {
          id: 'false-positive',
          language: 'en',
          category: ModerationCategory.HATE_SPEECH,
          text: 'benign',
          expectedHarmful: false,
        },
      ];

      const report = await service.runEvaluation({
        languages: ['en'],
        categories: [ModerationCategory.HATE_SPEECH],
        customCorpus,
      });

      expect(report.aggregate.falseNegatives).toBe(1);
      expect(report.aggregate.falsePositives).toBe(1);
      expect(report.aggregate.falseNegativeRate).toBe(1);
      expect(report.aggregate.falsePositiveRate).toBe(1);
      expect(report.matrix.en?.[ModerationCategory.HATE_SPEECH]).toMatchObject({
        falseNegativeRate: 1,
        falsePositiveRate: 1,
      });
    });
  });

  describe('rejection and failure cases', () => {
    it('throws BadRequestException for unsupported languages', async () => {
      await expect(
        service.runEvaluation({
          languages: ['xx' as SupportedEvaluationLanguage],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for unsupported policy categories', async () => {
      await expect(
        service.runEvaluation({
          categories: ['unknown' as ModerationCategory],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no corpus samples match filters', async () => {
      const emptyCustomCorpus: EvaluationCorpusItem[] = [];

      await expect(
        service.runEvaluation({
          languages: ['en'],
          customCorpus: emptyCustomCorpus,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('propagates moderation failures without caching an incomplete report', async () => {
      aiModerationService.moderateContent.mockRejectedValueOnce(
        new Error('Moderation unavailable'),
      );

      await expect(service.runEvaluation()).rejects.toThrow(
        'Moderation unavailable',
      );
      await expect(service.getEvaluationReport()).resolves.toMatchObject({
        totalSamples: DEFAULT_MULTILINGUAL_CORPUS.length,
      });
    });
  });

  describe('disparity detection', () => {
    it('detects and flags false-negative rate disparity when one language under-performs', async () => {
      aiModerationService.moderateContent.mockImplementation(
        (content: string) => {
          // Moderation works for EN but completely misses ES harmful content
          const isEnglishHarmful = content.includes('despise');
          return Promise.resolve({
            score: isEnglishHarmful ? 0.9 : 0.1,
            flags: isEnglishHarmful ? [ModerationCategory.HATE_SPEECH] : [],
            status: isEnglishHarmful
              ? ModerationStatus.REJECTED
              : ModerationStatus.APPROVED,
            details: {},
            requiresReview: false,
          });
        },
      );

      const customCorpus: EvaluationCorpusItem[] = [
        {
          id: 'en-1',
          language: 'en',
          category: ModerationCategory.HATE_SPEECH,
          text: 'I despise group',
          expectedHarmful: true,
        },
        {
          id: 'en-2',
          language: 'en',
          category: ModerationCategory.HATE_SPEECH,
          text: 'Friendly note',
          expectedHarmful: false,
        },
        {
          id: 'es-1',
          language: 'es',
          category: ModerationCategory.HATE_SPEECH,
          text: 'Texto de odio sin detectar',
          expectedHarmful: true,
        },
        {
          id: 'es-2',
          language: 'es',
          category: ModerationCategory.HATE_SPEECH,
          text: 'Nota pacifica',
          expectedHarmful: false,
        },
      ];

      const report = await service.runEvaluation({
        languages: ['en', 'es'],
        categories: [ModerationCategory.HATE_SPEECH],
        customCorpus,
        disparityThreshold: 0.1,
      });

      expect(report.byLanguage.es?.disparityFlag).toBe(true);
      expect(report.disparities.length).toBeGreaterThan(0);
      const esDisparity = report.disparities.find((d) => d.language === 'es');
      expect(esDisparity).toBeDefined();
      expect(esDisparity?.metric).toBe('false_negative_rate');
      expect(esDisparity?.recommendation).toContain('es');
    });
  });

  describe('getEvaluationReport caching', () => {
    it('reuses cached evaluation report on repeated calls', async () => {
      const first = await service.getEvaluationReport();
      const second = await service.getEvaluationReport();

      expect(first.evaluatedAt).toBe(second.evaluatedAt);
    });
  });
});
