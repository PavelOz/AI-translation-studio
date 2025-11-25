import apiClient from './client';
import type { GlossaryMode } from '../types/glossary';

export type SegmentStatus = 'NEW' | 'MT' | 'EDITED' | 'CONFIRMED';

export type Segment = {
  id: string;
  documentId: string;
  segmentIndex: number;
  sourceText: string;
  targetMt?: string;
  targetFinal?: string;
  status: SegmentStatus;
  fuzzyScore?: number;
  bestTmEntryId?: string;
  confirmedById?: string;
  confirmedAt?: string;
  timeSpentSeconds?: number;
  createdAt: string;
  updatedAt: string;
};

export type SegmentListResponse = {
  segments: Segment[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type UpdateSegmentRequest = {
  targetFinal?: string;
  status?: SegmentStatus;
  fuzzyScore?: number;
  bestTmEntryId?: string;
  timeSpentSeconds?: number;
};

export type BulkUpdateSegmentRequest = {
  id: string;
  targetFinal?: string;
  status?: SegmentStatus;
  fuzzyScore?: number;
  bestTmEntryId?: string;
  timeSpentSeconds?: number;
};

export const segmentsApi = {
  list: async (
    documentId: string,
    page = 1,
    pageSize = 200,
    query?: string,
  ): Promise<SegmentListResponse> => {
    const params: Record<string, string | number> = { page, pageSize };
    if (query) {
      params.q = query;
    }
    const response = await apiClient.get<SegmentListResponse>(`/segments/document/${documentId}`, {
      params,
    });
    return response.data;
  },

  get: async (segmentId: string): Promise<Segment> => {
    const response = await apiClient.get<Segment>(`/segments/${segmentId}`);
    return response.data;
  },

  update: async (segmentId: string, data: UpdateSegmentRequest): Promise<Segment> => {
    const response = await apiClient.patch<Segment>(`/segments/${segmentId}`, data);
    return response.data;
  },

  bulkUpdate: async (updates: BulkUpdateSegmentRequest[]): Promise<Segment[]> => {
    const response = await apiClient.post<Segment[]>('/segments/bulk-update', { updates });
    return response.data;
  },

  translate: async (
    segmentId: string, 
    options?: { 
      applyTm?: boolean; 
      minScore?: number; 
      glossaryMode?: GlossaryMode; 
      useCritic?: boolean;
      tmRagSettings?: {
        minScore?: number;
        vectorSimilarity?: number;
        mode?: 'basic' | 'extended';
        useVectorSearch?: boolean;
        limit?: number;
      };
    }
  ): Promise<Segment> => {
    const response = await apiClient.post<Segment>(`/segments/${segmentId}/mt`, options || {});
    return response.data;
  },
};







