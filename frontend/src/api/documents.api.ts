import apiClient from './client';
import type { GlossaryMode } from '../types/glossary';

export type DocumentStatus = 'NEW' | 'IN_PROGRESS' | 'COMPLETED';
export type DocumentFileType = 'DOCX' | 'XLIFF' | 'XLSX';

export type Document = {
  id: string;
  name: string;
  filename?: string;
  projectId: string;
  status: DocumentStatus;
  fileType?: DocumentFileType;
  sourceLocale: string;
  targetLocale: string;
  wordCount: number;
  totalSegments: number;
  totalWords: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentListResponse = {
  documents: Document[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type UploadDocumentRequest = {
  projectId: string;
  sourceLocale: string;
  targetLocale: string;
  file: File;
};

export const documentsApi = {
  list: async (projectId?: string): Promise<Document[]> => {
    const params = projectId ? { projectId } : {};
    const response = await apiClient.get<Document[]>('/documents', { params });
    return response.data;
  },

  get: async (documentId: string): Promise<Document> => {
    const response = await apiClient.get<Document>(`/documents/${documentId}`);
    return response.data;
  },

  upload: async (
    data: UploadDocumentRequest,
    onUploadProgress?: (progress: { loaded: number; total: number; percentage: number }) => void,
  ): Promise<{ document: Document; importedSegments: number }> => {
    const formData = new FormData();
    formData.append('file', data.file);
    formData.append('projectId', data.projectId);
    formData.append('sourceLocale', data.sourceLocale);
    formData.append('targetLocale', data.targetLocale);

    const response = await apiClient.post<{ document: Document; importedSegments: number }>(
      '/documents/upload',
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        onUploadProgress: (progressEvent) => {
          if (onUploadProgress && progressEvent.total) {
            const percentage = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            onUploadProgress({
              loaded: progressEvent.loaded,
              total: progressEvent.total,
              percentage,
            });
          }
        },
      },
    );
    return response.data;
  },

  update: async (documentId: string, data: Partial<Document>): Promise<Document> => {
    const response = await apiClient.patch<Document>(`/documents/${documentId}`, data);
    return response.data;
  },

  delete: async (documentId: string): Promise<void> => {
    await apiClient.delete(`/documents/${documentId}`);
  },

  download: async (documentId: string, exportFile = false): Promise<Blob> => {
    const params = exportFile ? { export: 'true' } : {};
    const response = await apiClient.get(`/documents/${documentId}/download`, {
      params,
      responseType: 'blob',
    });
    return response.data;
  },

  pretranslate: async (
    documentId: string,
    options?: {
      applyAiToLowMatches?: boolean;
      applyAiToEmptyOnly?: boolean;
      rewriteConfirmed?: boolean;
      rewriteNonConfirmed?: boolean;
      glossaryMode?: GlossaryMode;
      useCritic?: boolean;
    },
  ): Promise<{
    status: string;
    documentId: string;
  }> => {
    const response = await apiClient.post(`/documents/${documentId}/pretranslate`, options || {});
    return response.data;
  },

  batchTranslate: async (
    documentId: string,
    options?: {
      mode?: 'translate_all' | 'pre_translate';
      applyTm?: boolean;
      minScore?: number;
      mtOnlyEmpty?: boolean;
      glossaryMode?: GlossaryMode;
    },
  ): Promise<{
    documentId: string;
    processed: number;
    results: Array<{ segmentId: string; targetMt: string | null }>;
  }> => {
    const response = await apiClient.post(`/documents/${documentId}/mt-batch`, {
      mode: options?.mode || 'translate_all',
      options: {
        applyTm: options?.applyTm,
        minScore: options?.minScore,
        mtOnlyEmpty: options?.mtOnlyEmpty,
        glossaryMode: options?.glossaryMode,
      },
    });
    return response.data;
  },

  getPretranslateProgress: async (documentId: string): Promise<{
    documentId: string;
    status: 'running' | 'completed' | 'cancelled' | 'error';
    currentSegment: number;
    totalSegments: number;
    tmApplied: number;
    aiApplied: number;
    currentSegmentId?: string;
    currentSegmentText?: string;
    error?: string;
    results: Array<{ segmentId: string; method: 'tm' | 'ai'; targetMt: string | null; fuzzyScore?: number }>;
  }> => {
    const response = await apiClient.get(`/documents/${documentId}/pretranslate/progress`);
    return response.data;
  },

  cancelPretranslate: async (documentId: string): Promise<{ 
    status: string; 
    documentId: string;
    message?: string;
    currentProgress?: any;
  }> => {
    const response = await apiClient.post(`/documents/${documentId}/pretranslate/cancel`);
    return response.data;
  },

  generateGlossary: async (documentId: string): Promise<{ count: number }> => {
    const response = await apiClient.post<{ count: number }>(`/documents/${documentId}/generate-glossary`);
    return response.data;
  },

  listDocumentGlossary: async (documentId: string): Promise<Array<{
    id: string;
    documentId: string;
    sourceTerm: string;
    targetTerm: string;
    createdAt: string;
  }>> => {
    const response = await apiClient.get<Array<{
      id: string;
      documentId: string;
      sourceTerm: string;
      targetTerm: string;
      createdAt: string;
    }>>(`/documents/${documentId}/glossary`);
    return response.data;
  },
};

