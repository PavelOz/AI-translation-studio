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

  updateDocumentDna: async (documentId: string, payload: DocumentDnaPayload): Promise<UpdateDocumentDnaResponse> => {
    const response = await apiClient.put<UpdateDocumentDnaResponse>(`/documents/${documentId}/dna`, payload);
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

  /** Validate Document DNA (includes contract validation). */
  validateDocumentDna: async (documentId: string): Promise<DnaContractValidationResult> => {
    const response = await apiClient.get(`/documents/${documentId}/dna/validate`);
    return response.data;
  },

  enrichDocumentDnaFromCSV: async (
    documentId: string,
    csvFile: File,
    options?: { useLLM?: boolean; llmProvider?: 'gemini' | 'openai' | 'yandex' | 'deepseek' },
  ): Promise<{
    success: boolean;
    abbreviationLogic: Record<string, { longForm: string; shortForm: string }>;
    statistics: {
      totalBefore: number;
      totalAfter: number;
      added: number;
      skipped: number;
      conflicts: number;
    };
  }> => {
    const formData = new FormData();
    formData.append('csvFile', csvFile);
    if (options?.useLLM !== undefined) {
      formData.append('useLLM', String(options.useLLM));
    }
    if (options?.llmProvider) {
      formData.append('llmProvider', options.llmProvider);
    }

    const response = await apiClient.post(`/documents/${documentId}/dna/enrich`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  /** Add a single abbreviation entry to DNA. */
  addAbbreviationToDna: async (
    documentId: string,
    key: string,
    longForm: string,
    shortForm: string,
  ): Promise<DocumentDnaPayload> => {
    // Get current DNA
    const currentDna = await analysisApi.getDocumentDna(documentId);
    if (!currentDna) {
      throw new Error('Document has no DNA. Please create DNA first.');
    }

    // Add new entry to abbreviationLogic
    const currentLogic = (currentDna.abbreviationLogic || {}) as Record<string, { longForm: string; shortForm: string }>;
    const updatedLogic = {
      ...currentLogic,
      [key]: { longForm, shortForm },
    };

    // Update DNA
    const updated = await analysisApi.updateDocumentDna(documentId, {
      ...currentDna,
      abbreviationLogic: updatedLogic,
    });

    return updated;
  },
};

export type EnrichmentProgress = {
  status: 'idle' | 'processing' | 'completed' | 'error';
  current: number;
  total: number;
  batchNumber?: number;
  error?: string;
  lastAdded?: {
    ruName: string;
    shortForm: string;
    longForm: string;
  };
};

export type DocumentDnaPayload = {
  technicalSchema?: Record<string, unknown> | null;
  namingConventions?: Record<string, unknown> | null;
  abbreviationLogic?: Record<string, unknown> | null;
  entityGroups?: Record<string, unknown> | null;
};

export type DnaContractValidationResult = {
  valid: boolean;
  errors: string[];
  abbreviationCount: number;
  contractValidation?: {
    status: 'OK' | 'WARNING' | 'ERROR';
    issues: Array<{
      type: 'error' | 'warning';
      message: string;
      suggestion?: string;
    }>;
    suggestions: string[];
    report: string;
  } | null;
};

/** Response from PUT /documents/:id/dna (includes affected segments for smart retranslation). */
export type UpdateDocumentDnaResponse = DocumentDnaPayload & {
  affectedSegmentIds?: string[];
  affectedCount?: number;
  delta?: { addedKeys: string[]; changedKeys: string[]; removedKeys: string[] };
};


