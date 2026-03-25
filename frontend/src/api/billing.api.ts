import apiClient from './client';

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

export const billingApi = {
  getToday: async (): Promise<BillingTodayResponse> => {
    const { data } = await apiClient.get<BillingTodayResponse>('/billing/today');
    return data;
  },
};
