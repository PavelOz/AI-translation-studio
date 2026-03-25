import apiClient from './client';
import type { UserRole } from './auth.api';

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

  updateSettings: async (body: Omit<BillingSettingsDTO, 'updatedAt'>): Promise<BillingSettingsDTO> => {
    const { data } = await apiClient.put<BillingSettingsDTO>('/billing/settings', body);
    return data;
  },
};
