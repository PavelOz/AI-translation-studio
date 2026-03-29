import apiClient from './client';
import type { UserRole } from './auth.api';

export type BillingPricingLine = {
  inputPer1M: number;
  outputPer1M: number;
  tier: 'standard' | 'expensive';
};

export type BillingPricingFile = {
  version: number;
  currency: string;
  defaultPer1M: BillingPricingLine;
  models: Record<string, BillingPricingLine>;
};

export type BillingTodayResponse = {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  dateKey: string;
  enabled: boolean;
  userId: string;
  minRemainingForExpensiveUsd: number;
  powerRoles: string[];
};

export type BillingSettingsDTO = {
  enabled: boolean;
  dailyCapUsd: number;
  proMinRemainingUsd: number;
  warnInputTokens: number;
  maxPromptChars: number;
  powerRoles: UserRole[];
  updatedAt: string;
  pricingJson: unknown | null;
  pricingSource: 'database' | 'file';
};

export type BillingSettingsUpdate = Omit<BillingSettingsDTO, 'updatedAt' | 'pricingSource' | 'pricingJson'> & {
  pricingJson?: BillingPricingFile | null;
};

export type PutBundledPricingResponse = {
  pricing: BillingPricingFile;
  activePricingSource: 'database' | 'file';
  hint?: string;
};

export type TranslationCostEstimateResult = {
  billingEnabled: boolean;
  workflow: 'pretranslate' | 'batch';
  eligibleSegmentCount: number;
  segmentsQueuedForAi: number;
  tmResolvedWithoutAi: number;
  translationUnitCount: number;
  aiApiCallCount: number;
  provider: string;
  model: string;
  useCritic: boolean;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  dailyCapUsd: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  remainingAfterEstimateUsd: number;
  mayExceedCap: boolean;
  disclaimer: string;
};

export type EstimatePretranslateBody = {
  workflow: 'pretranslate';
  documentId: string;
  applyAiToLowMatches?: boolean;
  applyAiToEmptyOnly?: boolean;
  rewriteConfirmed?: boolean;
  rewriteNonConfirmed?: boolean;
  useCritic?: boolean;
  provider?: 'gemini' | 'openai' | 'yandex' | 'deepseek';
  model?: string;
  skipTm?: boolean;
};

export type EstimateBatchBody = {
  workflow: 'batch';
  documentId: string;
  mode: 'translate_all' | 'pre_translate';
  options?: {
    applyTm?: boolean;
    minScore?: number;
    mtOnlyEmpty?: boolean;
    mtOnlyNonEmpty?: boolean;
    rewriteNonConfirmed?: boolean;
    useCritic?: boolean;
    glossaryMode?: 'off' | 'strict_source' | 'strict_semantic';
  };
};

export const billingApi = {
  getToday: async (): Promise<BillingTodayResponse> => {
    const { data } = await apiClient.get<BillingTodayResponse>('/billing/today');
    return data;
  },

  estimateTranslation: async (
    body: EstimatePretranslateBody | EstimateBatchBody,
  ): Promise<TranslationCostEstimateResult> => {
    const { data } = await apiClient.post<TranslationCostEstimateResult>('/billing/estimate-translation', body);
    return data;
  },

  getSettings: async (): Promise<BillingSettingsDTO> => {
    const { data } = await apiClient.get<BillingSettingsDTO>('/billing/settings');
    return data;
  },

  /** Raw contents of backend/config/billing-pricing.v1.json on the server */
  getBundledPricing: async (): Promise<BillingPricingFile> => {
    const { data } = await apiClient.get<BillingPricingFile>('/billing/bundled-pricing');
    return data;
  },

  /** Writes validated JSON to backend/config/billing-pricing.v1.json */
  putBundledPricing: async (body: BillingPricingFile): Promise<PutBundledPricingResponse> => {
    const { data } = await apiClient.put<PutBundledPricingResponse>('/billing/bundled-pricing', body);
    return data;
  },

  updateSettings: async (body: BillingSettingsUpdate): Promise<BillingSettingsDTO> => {
    const { data } = await apiClient.put<BillingSettingsDTO>('/billing/settings', body);
    return data;
  },
};
