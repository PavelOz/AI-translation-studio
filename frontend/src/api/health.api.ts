import apiClient from './client';

export type HealthStatus = {
  status: 'ok' | 'error';
  database: 'connected' | 'disconnected';
  timestamp: string;
  error?: string;
};

export const healthApi = {
  check: async (): Promise<HealthStatus> => {
    const response = await apiClient.get<HealthStatus>('/health');
    return response.data;
  },
};

