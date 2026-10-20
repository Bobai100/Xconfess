// src/moderation/language-evaluation.types.ts
import { ModerationCategory } from './ai-moderation.service';

export type SupportedEvaluationLanguage =
  'en' | 'es' | 'fr' | 'de' | 'ar' | 'pt';

export const SUPPORTED_EVALUATION_LANGUAGES: SupportedEvaluationLanguage[] = [
  'en',
  'es',
  'fr',
  'de',
  'ar',
  'pt',
];

export interface EvaluationCorpusItem {
  id: string;
  language: SupportedEvaluationLanguage;
  category: ModerationCategory;
  text: string;
  expectedHarmful: boolean;
  notes?: string;
}

export interface LanguageCategoryMetrics {
  language: SupportedEvaluationLanguage;
  category: ModerationCategory;
  totalSamples: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  precision: number;
  recall: number;
  f1Score: number;
  accuracy: number;
  hasDisparity: boolean;
}

export interface LanguageSummaryMetrics {
  language: SupportedEvaluationLanguage;
  totalSamples: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  precision: number;
  recall: number;
  f1Score: number;
  accuracy: number;
  disparityFlag: boolean;
}

export interface CategorySummaryMetrics {
  category: ModerationCategory;
  totalSamples: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  precision: number;
  recall: number;
  f1Score: number;
  accuracy: number;
}

export interface DisparityFinding {
  language: SupportedEvaluationLanguage;
  category?: ModerationCategory;
  metric: 'false_positive_rate' | 'false_negative_rate';
  value: number;
  baselineValue: number;
  deviation: number;
  severity: 'high' | 'medium';
  recommendation: string;
}

export interface MultilingualEvaluationReport {
  evaluatedAt: string;
  totalSamples: number;
  supportedLanguages: SupportedEvaluationLanguage[];
  policyCategories: ModerationCategory[];
  aggregate: {
    totalSamples: number;
    truePositives: number;
    falsePositives: number;
    trueNegatives: number;
    falseNegatives: number;
    falsePositiveRate: number;
    falseNegativeRate: number;
    precision: number;
    recall: number;
    f1Score: number;
    accuracy: number;
  };
  byLanguage: Partial<
    Record<SupportedEvaluationLanguage, LanguageSummaryMetrics>
  >;
  byCategory: Partial<Record<ModerationCategory, CategorySummaryMetrics>>;
  matrix: Partial<
    Record<
      SupportedEvaluationLanguage,
      Partial<Record<ModerationCategory, LanguageCategoryMetrics>>
    >
  >;
  disparities: DisparityFinding[];
}
