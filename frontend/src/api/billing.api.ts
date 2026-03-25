import apiClient from './client';
import type { UserRole } from './auth.api';

export type BillingPricingFile = {
  version: number;
  currency: string;
  defaultPer1M: {
    inputPer1M: number;
    outputPer1M: number;
    tier: 'standard' | 'expensive';
  };
  models: Record<
    string,
    {
      inputPer1M: number;
      outputPer1M: number;
      tier: 'standard' | 'expensive';
    }
  >;
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

export const billingApi = {
  getToday: async (): Promise<BillingTodayResponse> => {
    const { data } = await apiClient.get<BillingTodayResponse>('/billing/today');
    return data;
  },

  getSettings: async (): Promise<BillingSettingsDTO> => {
    const { data } = await apiClient.get<BillingSettingsDTO>('/billing/settings');
    return data;
  },

  getPricingTemplate: async (): Promise<BillingPricingFile> => {
    const { data } = await apiClient.get<BillingPricingFile>('/billing/pricing-template');
    return data;
  },

  updateSettings: async (body: BillingSettingsUpdate): Promise<BillingSettingsDTO> => {
    const { data } = await apiClient.put<BillingSettingsDTO>('/billing/settings', body);
    return data;
  },
};
