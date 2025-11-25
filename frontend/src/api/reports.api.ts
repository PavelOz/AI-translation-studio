import apiClient from './client';

export type ProjectReportOverview = {
  id: string;
  name: string;
  clientName?: string;
  domain?: string;
  documents: number;
  metrics: {
    projectId: string;
    totalDocuments: number;
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
};

export type ProjectPerformanceReport = {
  project: {
    id: string;
    name: string;
    clientName?: string;
    domain?: string;
    sourceLang?: string;
    targetLang?: string;
    documents: number;
  };
  totals: {
    words: number;
  };
  metrics: {
    projectId: string;
    totalDocuments: number;
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
};

export type UserPerformanceReport = {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  totals: {
    segments: number;
    words: number;
    avgEditDistance: number;
    avgTimePerSegment: number;
  };
  errorProfile: {
    term: number;
    format: number;
    consistency: number;
  };
};

export type ReportFilters = {
  client?: string;
  domain?: string;
  dateFrom?: string;
  dateTo?: string;
};

export const reportsApi = {
  getProjectsOverview: async (filters?: ReportFilters): Promise<ProjectReportOverview[]> => {
    const params: Record<string, string> = {};
    if (filters?.client) params.client = filters.client;
    if (filters?.domain) params.domain = filters.domain;
    if (filters?.dateFrom) params.date_from = filters.dateFrom;
    if (filters?.dateTo) params.date_to = filters.dateTo;

    const response = await apiClient.get<ProjectReportOverview[]>('/reports/projects', { params });
    return response.data;
  },

  getProjectReport: async (projectId: string): Promise<ProjectPerformanceReport> => {
    const response = await apiClient.get<ProjectPerformanceReport>(`/reports/projects/${projectId}`);
    return response.data;
  },

  getUserReport: async (userId: string): Promise<UserPerformanceReport> => {
    const response = await apiClient.get<UserPerformanceReport>(`/reports/users/${userId}`);
    return response.data;
  },
};



