import apiClient from './client';

export type QAIssue = {
  segmentId: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  category: 'terminology' | 'format' | 'consistency' | 'tags' | 'general';
};

export type QualityMetric = {
  id: string;
  segmentId: string;
  mtWordCount: number;
  finalWordCount: number;
  editDistanceChars: number;
  termErrors: number;
  formatErrors: number;
  consistencyErrors: number;
  timeSpentSeconds: number;
  editDistancePercent: number;
};

export type QualityCheckResult = {
  metrics: QualityMetric;
  issues: QAIssue[];
};

export type DocumentMetricsSummary = {
  documentId: string;
  totalSegments: number;
  mtCoverage: number;
  avgEditDistancePercent: number;
  termAccuracyPercent: number;
  qaErrors: {
    term: number;
    format: number;
    consistency: number;
  };
  avgTimePerSegment: number;
  totals: {
    mtWords: number;
    finalWords: number;
  };
};

export const qualityApi = {
  runSegmentCheck: async (segmentId: string): Promise<QualityCheckResult> => {
    const response = await apiClient.post<QualityCheckResult>(`/segments/${segmentId}/qa`);
    return response.data;
  },

  runDocumentCheck: async (documentId: string): Promise<{ documentId: string; processed: number; issues: QAIssue[] }> => {
    const response = await apiClient.post(`/documents/${documentId}/qa`);
    return response.data;
  },

  getSegmentMetrics: async (segmentId: string): Promise<QualityMetric> => {
    const response = await apiClient.get<QualityMetric>(`/segments/${segmentId}/metrics`);
    return response.data;
  },

  getDocumentMetrics: async (documentId: string): Promise<DocumentMetricsSummary> => {
    const response = await apiClient.get<DocumentMetricsSummary>(`/documents/${documentId}/metrics-summary`);
    return response.data;
  },
};



