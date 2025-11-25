import apiClient from './client';

export type TranslationMemoryEntry = {
  id: string;
  projectId?: string;
  sourceLocale: string;
  targetLocale: string;
  sourceText: string;
  targetText: string;
  clientName?: string;
  domain?: string;
  matchRate?: number;
  usageCount: number;
  createdAt: string;
};

export type TmSearchResult = TranslationMemoryEntry & {
  fuzzyScore: number;
  scope: 'project' | 'global';
  tmxFileName?: string;
  tmxFileSource?: 'imported' | 'linked';
  searchMethod?: 'fuzzy' | 'vector' | 'hybrid'; // How this result was found
};

export type TmSearchRequest = {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
  limit?: number;
  minScore?: number;
  vectorSimilarity?: number; // Vector search similarity threshold (0-100)
  mode?: 'basic' | 'extended'; // Search mode: 'basic' = strict thresholds, 'extended' = relaxed thresholds
  useVectorSearch?: boolean; // Whether to use semantic (vector) search
};

export type CreateTmEntryRequest = {
  projectId?: string;
  sourceLocale: string;
  targetLocale: string;
  sourceText: string;
  targetText: string;
  clientName?: string;
  domain?: string;
};

export const tmApi = {
  search: async (params: TmSearchRequest, signal?: AbortSignal): Promise<TmSearchResult[]> => {
    const response = await apiClient.post<TmSearchResult[]>('/tm/search', params, {
      signal,
    });
    return response.data;
  },

  list: async (projectId?: string, page = 1, limit = 50, globalOnly = false) => {
    const params: Record<string, string | number | boolean> = { page, limit };
    if (projectId) {
      params.projectId = projectId;
    }
    if (globalOnly) {
      params.globalOnly = true;
    }
    const response = await apiClient.get('/tm/entries', { params });
    return response.data;
  },

  add: async (data: CreateTmEntryRequest): Promise<TranslationMemoryEntry> => {
    const response = await apiClient.post<TranslationMemoryEntry>('/tm/add', data);
    return response.data;
  },

  update: async (entryId: string, data: { sourceText?: string; targetText?: string; matchRate?: number }): Promise<TranslationMemoryEntry> => {
    const response = await apiClient.patch<TranslationMemoryEntry>(`/tm/entries/${entryId}`, data);
    return response.data;
  },

  delete: async (entryId: string): Promise<void> => {
    await apiClient.delete(`/tm/entries/${entryId}`);
  },

  importTmx: async (file: File, projectId?: string, clientName?: string, domain?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (projectId) formData.append('projectId', projectId);
    if (clientName) formData.append('clientName', clientName);
    if (domain) formData.append('domain', domain);

    const response = await apiClient.post('/tm/import-tmx', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  linkTmx: async (file: File, projectId?: string, clientName?: string, domain?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (projectId) formData.append('projectId', projectId);
    if (clientName) formData.append('clientName', clientName);
    if (domain) formData.append('domain', domain);

    const response = await apiClient.post('/tm/link-tmx', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  generateEmbeddings: async (projectId?: string, batchSize?: number, limit?: number) => {
    const response = await apiClient.post<{ progressId: string }>('/tm/generate-embeddings', {
      projectId,
      batchSize,
      limit,
    });
    return response.data;
  },

  getEmbeddingProgress: async (progressId: string) => {
    const response = await apiClient.get(`/tm/embedding-progress/${progressId}`);
    return response.data;
  },

  getEmbeddingStats: async () => {
    const response = await apiClient.get('/tm/embedding-stats');
    return response.data;
  },
};







