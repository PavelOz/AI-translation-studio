import apiClient from './client';

export type AnalysisStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type StyleRule = {
  id: string;
  ruleType: string;
  pattern: string;
  description?: string | null;
  examples?: any;
  priority: number;
  createdAt: string;
};

export type GlossaryEntry = {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  createdAt: string;
};

export type AnalysisResults = {
  status: AnalysisStatus;
  glossaryExtracted: boolean;
  styleRulesExtracted: boolean;
  completedAt: string | null;
  glossaryCount: number;
  approvedCount?: number;
  candidateCount?: number;
  styleRulesCount: number;
  styleRules: StyleRule[];
  glossaryEntries: GlossaryEntry[];
  currentStage: string | null;
  progressPercentage: number;
  currentMessage: string | null;
};

export const analysisApi = {
  triggerAnalysis: async (documentId: string, forceReset: boolean = false): Promise<{
    status: string;
    message?: string;
  }> => {
    const response = await apiClient.post<{
      status: string;
      message?: string;
    }>(`/documents/${documentId}/analyze`, { forceReset });
    return response.data;
  },

  getAnalysis: async (documentId: string): Promise<AnalysisResults> => {
    const response = await apiClient.get<AnalysisResults>(`/documents/${documentId}/analysis`);
    return response.data;
  },

  cancelAnalysis: async (documentId: string): Promise<{ message: string }> => {
    const response = await apiClient.delete<{ message: string }>(`/documents/${documentId}/analysis`);
    return response.data;
  },

  resetAnalysis: async (documentId: string): Promise<{ message: string; status: string }> => {
    const response = await apiClient.post<{ message: string; status: string }>(`/documents/${documentId}/analysis/reset`);
    return response.data;
  },

  cleanupStaleAnalyses: async (): Promise<{ message: string; count: number }> => {
    const response = await apiClient.post<{ message: string; count: number }>('/documents/analysis/cleanup-stale');
    return response.data;
  },
};


