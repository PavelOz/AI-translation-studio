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

export type LogEntry = {
  timestamp: string;
  stage: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: Record<string, any>;
};

export type StageInfo = {
  id: string;
  name: string;
  description: string;
  progressRange: [number, number];
  status?: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  progress?: number;
};

export type StageMonitoringData = {
  documentId: string;
  documentName?: string;
  status: AnalysisStatus;
  currentStage: string | null;
  currentStageInfo: {
    id: string;
    name: string;
    progress: number;
  };
  stages: StageInfo[];
  progress: {
    overall: number;
    currentStage: string | null;
    message: string;
    updatedAt: string;
  };
  glossaryExtracted: boolean;
  glossaryCount: number;
  totalSegments: number;
  sourceLocale: string;
  targetLocale: string;
  logs: LogEntry[];
};

export const analysisApi = {
  triggerAnalysis: async (
    documentId: string, 
    forceReset: boolean = false, 
    glossaryMode: 'fast' | 'deep' = 'fast',
    provider?: string,
    model?: string
  ): Promise<{
    status: string;
    message?: string;
  }> => {
    const response = await apiClient.post<{
      status: string;
      message?: string;
    }>(`/documents/${documentId}/analyze`, { 
      forceReset, 
      glossaryMode,
      provider,
      model,
    });
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

  getStageMonitoring: async (documentId: string): Promise<StageMonitoringData> => {
    const response = await apiClient.get<StageMonitoringData>(`/documents/${documentId}/analysis/monitoring`);
    return response.data;
  },

  // Document DNA (Project Knowledge Base)
  getDocumentDna: async (documentId: string): Promise<DocumentDnaPayload | null> => {
    try {
      const response = await apiClient.get<DocumentDnaPayload>(`/documents/${documentId}/dna`);
      return response.data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  },

  updateDocumentDna: async (documentId: string, payload: DocumentDnaPayload): Promise<DocumentDnaPayload> => {
    const response = await apiClient.put<DocumentDnaPayload>(`/documents/${documentId}/dna`, payload);
    return response.data;
  },

  regenerateDocumentDna: async (documentId: string): Promise<DocumentDnaPayload> => {
    const response = await apiClient.post<DocumentDnaPayload>(`/documents/${documentId}/dna/regenerate`);
    return response.data;
  },

  /** Refine DNA (revision). When preview=true, returns refined payload without saving. */
  refineDocumentDna: async (documentId: string, options?: { preview?: boolean }): Promise<DocumentDnaPayload> => {
    const response = await apiClient.post<DocumentDnaPayload>(`/documents/${documentId}/refine-dna`, options ?? {});
    return response.data;
  },
};

export type DocumentDnaPayload = {
  technicalSchema?: Record<string, unknown> | null;
  namingConventions?: Record<string, unknown> | null;
  abbreviationLogic?: Record<string, unknown> | null;
  entityGroups?: Record<string, unknown> | null;
};


