// src/moderation/language-evaluation.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AiModerationService,
  ModerationCategory,
} from './ai-moderation.service';
import {
  EvaluationCorpusItem,
  LanguageCategoryMetrics,
  LanguageSummaryMetrics,
  CategorySummaryMetrics,
  DisparityFinding,
  MultilingualEvaluationReport,
  SupportedEvaluationLanguage,
  SUPPORTED_EVALUATION_LANGUAGES,
} from './language-evaluation.types';
import { DEFAULT_MULTILINGUAL_CORPUS } from './multilingual-corpus';

export interface RunEvaluationOptions {
  languages?: SupportedEvaluationLanguage[];
  categories?: ModerationCategory[];
  disparityThreshold?: number;
  customCorpus?: EvaluationCorpusItem[];
}

@Injectable()
export class LanguageEvaluationService {
  private cachedReport: MultilingualEvaluationReport | null = null;

  constructor(private readonly aiModerationService: AiModerationService) {}

  /**
   * Run privacy-safe multilingual evaluation across specified languages and categories.
   */
  async runEvaluation(
    options: RunEvaluationOptions = {},
  ): Promise<MultilingualEvaluationReport> {
    const targetLanguages =
      options.languages && options.languages.length > 0
        ? options.languages
        : [...SUPPORTED_EVALUATION_LANGUAGES];

    for (const lang of targetLanguages) {
      if (!SUPPORTED_EVALUATION_LANGUAGES.includes(lang)) {
        throw new BadRequestException(
          `Unsupported language '${lang}'. Supported languages are: ${SUPPORTED_EVALUATION_LANGUAGES.join(', ')}`,
        );
      }
    }

    const targetCategories =
      options.categories && options.categories.length > 0
        ? options.categories
        : Object.values(ModerationCategory);
    for (const category of targetCategories) {
      if (!Object.values(ModerationCategory).includes(category)) {
        throw new BadRequestException(
          `Unsupported moderation category '${category}'.`,
        );
      }
    }

    const disparityThreshold = options.disparityThreshold ?? 0.15;
    if (
      !Number.isFinite(disparityThreshold) ||
      disparityThreshold < 0 ||
      disparityThreshold > 1
    ) {
      throw new BadRequestException(
        'Disparity threshold must be a number between 0 and 1.',
      );
    }

    const corpus =
      options.customCorpus !== undefined
        ? options.customCorpus
        : DEFAULT_MULTILINGUAL_CORPUS;

    const filteredCorpus = corpus.filter(
      (item) =>
        targetLanguages.includes(item.language) &&
        targetCategories.includes(item.category),
    );

    if (filteredCorpus.length === 0) {
      throw new BadRequestException(
        'Evaluation corpus has zero samples matching the selected languages and categories.',
      );
    }

    // Evaluate each item
    type EvaluatedRecord = {
      item: EvaluationCorpusItem;
      predictedHarmful: boolean;
    };

    const evaluatedRecords: EvaluatedRecord[] = [];

    for (const item of filteredCorpus) {
      const result = await this.aiModerationService.moderateContent(item.text);
      const isHarmful =
        result.flags.includes(item.category) ||
        (result.details[item.category] ?? 0) >= 0.5;

      evaluatedRecords.push({
        item,
        predictedHarmful: isHarmful,
      });
    }

    // Aggregate calculations
    const aggregateCounts = this.calculateConfusionCounts(evaluatedRecords);
    const aggregate = this.computeMetrics(aggregateCounts);

    // Group by language
    const byLanguage: Partial<
      Record<SupportedEvaluationLanguage, LanguageSummaryMetrics>
    > = {};
    for (const lang of targetLanguages) {
      const recordsForLang = evaluatedRecords.filter(
        (r) => r.item.language === lang,
      );
      const counts = this.calculateConfusionCounts(recordsForLang);
      const metrics = this.computeMetrics(counts);
      byLanguage[lang] = {
        language: lang,
        ...metrics,
        disparityFlag: false,
      };
    }

    // Group by category
    const byCategory: Partial<
      Record<ModerationCategory, CategorySummaryMetrics>
    > = {};
    for (const cat of targetCategories) {
      const recordsForCat = evaluatedRecords.filter(
        (r) => r.item.category === cat,
      );
      const counts = this.calculateConfusionCounts(recordsForCat);
      const metrics = this.computeMetrics(counts);
      byCategory[cat] = {
        category: cat,
        ...metrics,
      };
    }

    // Language x Category matrix
    const matrix: Partial<
      Record<
        SupportedEvaluationLanguage,
        Partial<Record<ModerationCategory, LanguageCategoryMetrics>>
      >
    > = {};

    for (const lang of targetLanguages) {
      const languageMatrix: Partial<
        Record<ModerationCategory, LanguageCategoryMetrics>
      > = {};
      matrix[lang] = languageMatrix;
      for (const cat of targetCategories) {
        const records = evaluatedRecords.filter(
          (r) => r.item.language === lang && r.item.category === cat,
        );
        if (records.length > 0) {
          const counts = this.calculateConfusionCounts(records);
          const metrics = this.computeMetrics(counts);
          languageMatrix[cat] = {
            language: lang,
            category: cat,
            ...metrics,
            hasDisparity: false,
          };
        }
      }
    }

    // Disparity detection
    const disparities: DisparityFinding[] = [];

    for (const lang of targetLanguages) {
      const langSummary = byLanguage[lang];
      if (!langSummary) continue;

      // False negative rate disparity
      const fnrDeviation =
        langSummary.falseNegativeRate - aggregate.falseNegativeRate;
      if (fnrDeviation > disparityThreshold) {
        langSummary.disparityFlag = true;
        disparities.push({
          language: lang,
          metric: 'false_negative_rate',
          value: Number(langSummary.falseNegativeRate.toFixed(4)),
          baselineValue: Number(aggregate.falseNegativeRate.toFixed(4)),
          deviation: Number(fnrDeviation.toFixed(4)),
          severity: fnrDeviation > 0.3 ? 'high' : 'medium',
          recommendation: `Elevated false-negative rate detected in ${lang}. Increase sensitivity or augment language training data for ${lang}.`,
        });
      }

      // False positive rate disparity
      const fprDeviation =
        langSummary.falsePositiveRate - aggregate.falsePositiveRate;
      if (fprDeviation > disparityThreshold) {
        langSummary.disparityFlag = true;
        disparities.push({
          language: lang,
          metric: 'false_positive_rate',
          value: Number(langSummary.falsePositiveRate.toFixed(4)),
          baselineValue: Number(aggregate.falsePositiveRate.toFixed(4)),
          deviation: Number(fprDeviation.toFixed(4)),
          severity: fprDeviation > 0.3 ? 'high' : 'medium',
          recommendation: `Elevated false-positive rate detected in ${lang}. Calibrate toxicity keywords and review control vocabulary for ${lang}.`,
        });
      }

      // Matrix-level category disparity
      for (const cat of targetCategories) {
        const catMetric = matrix[lang]?.[cat];
        const catSummary = byCategory[cat];
        if (catMetric && catSummary) {
          const metricComparisons = [
            {
              metric: 'false_negative_rate' as const,
              value: catMetric.falseNegativeRate,
              baseline: catSummary.falseNegativeRate,
            },
            {
              metric: 'false_positive_rate' as const,
              value: catMetric.falsePositiveRate,
              baseline: catSummary.falsePositiveRate,
            },
          ];
          for (const comparison of metricComparisons) {
            const deviation = comparison.value - comparison.baseline;
            if (deviation > disparityThreshold) {
              catMetric.hasDisparity = true;
              disparities.push({
                language: lang,
                category: cat,
                metric: comparison.metric,
                value: Number(comparison.value.toFixed(4)),
                baselineValue: Number(comparison.baseline.toFixed(4)),
                deviation: Number(deviation.toFixed(4)),
                severity: deviation > 0.3 ? 'high' : 'medium',
                recommendation: `Language ${lang} has an elevated ${comparison.metric} rate for ${cat} (deviation: +${(deviation * 100).toFixed(1)}%).`,
              });
            }
          }
        }
      }
    }

    const report: MultilingualEvaluationReport = {
      evaluatedAt: new Date().toISOString(),
      totalSamples: evaluatedRecords.length,
      supportedLanguages: targetLanguages,
      policyCategories: targetCategories,
      aggregate,
      byLanguage,
      byCategory,
      matrix,
      disparities,
    };

    this.cachedReport = report;
    return report;
  }

  /**
   * Get latest multilingual evaluation report, running default evaluation if none cached.
   */
  async getEvaluationReport(): Promise<MultilingualEvaluationReport> {
    if (!this.cachedReport) {
      return this.runEvaluation();
    }
    return this.cachedReport;
  }

  private calculateConfusionCounts(
    records: { item: EvaluationCorpusItem; predictedHarmful: boolean }[],
  ) {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;

    for (const r of records) {
      if (r.predictedHarmful && r.item.expectedHarmful) tp++;
      else if (r.predictedHarmful && !r.item.expectedHarmful) fp++;
      else if (!r.predictedHarmful && !r.item.expectedHarmful) tn++;
      else if (!r.predictedHarmful && r.item.expectedHarmful) fn++;
    }

    return { total: records.length, tp, fp, tn, fn };
  }

  private computeMetrics(counts: {
    total: number;
    tp: number;
    fp: number;
    tn: number;
    fn: number;
  }) {
    const { total, tp, fp, tn, fn } = counts;
    const accuracy = total > 0 ? (tp + tn) / total : 0;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1Score =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;
    const falsePositiveRate = fp + tn > 0 ? fp / (fp + tn) : 0;
    const falseNegativeRate = fn + tp > 0 ? fn / (fn + tp) : 0;

    return {
      totalSamples: total,
      truePositives: tp,
      falsePositives: fp,
      trueNegatives: tn,
      falseNegatives: fn,
      falsePositiveRate: Number(falsePositiveRate.toFixed(4)),
      falseNegativeRate: Number(falseNegativeRate.toFixed(4)),
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1Score: Number(f1Score.toFixed(4)),
      accuracy: Number(accuracy.toFixed(4)),
    };
  }
}
