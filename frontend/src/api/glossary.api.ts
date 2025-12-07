import apiClient from './client';

export type GlossaryStatus = 'PREFERRED' | 'DEPRECATED';

export type ContextRules = {
  useOnlyIn?: string[]; // Only use in these contexts/domains
  excludeFrom?: string[]; // Never use in these contexts/domains
  documentTypes?: string[]; // Only use in these document types
  requires?: string[]; // Only when these conditions are met
};

export type GlossaryEntry = {
  id: string;
  projectId?: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLocale: string;
  targetLocale: string;
  description?: string;
  status: GlossaryStatus;
  forbidden: boolean;
  notes?: string;
  contextRules?: ContextRules;
  createdAt: string;
  updatedAt: string;
};

export type UpsertGlossaryEntryRequest = {
  id?: string;
  projectId?: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLocale: string;
  targetLocale: string;
  description?: string;
  status?: GlossaryStatus;
  forbidden?: boolean;
  notes?: string;
  contextRules?: ContextRules;
};

export const glossaryApi = {
  list: async (projectId?: string, sourceLocale?: string, targetLocale?: string): Promise<GlossaryEntry[]> => {
    const params: Record<string, string> = {};
    if (projectId) params.projectId = projectId;
    if (sourceLocale) params.sourceLocale = sourceLocale;
    if (targetLocale) params.targetLocale = targetLocale;

    const response = await apiClient.get<GlossaryEntry[]>('/glossary', { params });
    return response.data;
  },

  upsert: async (data: UpsertGlossaryEntryRequest): Promise<GlossaryEntry> => {
    const response = await apiClient.post<GlossaryEntry>('/glossary', data);
    return response.data;
  },

  update: async (entryId: string, data: UpsertGlossaryEntryRequest): Promise<GlossaryEntry> => {
    const response = await apiClient.patch<GlossaryEntry>(`/glossary/${entryId}`, data);
    return response.data;
  },

  delete: async (entryId: string): Promise<void> => {
    await apiClient.delete(`/glossary/${entryId}`);
  },

  import: async (
    file: File,
    sourceLocale: string,
    targetLocale: string,
    projectId?: string,
  ): Promise<{ imported: number }> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('sourceLocale', sourceLocale);
    formData.append('targetLocale', targetLocale);
    if (projectId) formData.append('projectId', projectId);

    const response = await apiClient.post<{ imported: number }>('/glossary/import', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  search: async (
    sourceText: string,
    options?: {
      projectId?: string;
      sourceLocale?: string;
      targetLocale?: string;
      minSimilarity?: number;
    },
  ): Promise<Array<{
    id: string;
    sourceTerm: string;
    targetTerm: string;
    isForbidden: boolean;
    similarity: number;
    matchMethod: 'exact' | 'semantic' | 'hybrid';
  }>> => {
    const response = await apiClient.post<Array<{
      id: string;
      sourceTerm: string;
      targetTerm: string;
      isForbidden: boolean;
      similarity: number;
      matchMethod: 'exact' | 'semantic' | 'hybrid';
    }>>('/glossary/search', {
      sourceText,
      ...options,
    });
    return response.data;
  },

  getEmbeddingStats: async (projectId?: string): Promise<{
    total: number;
    withEmbedding: number;
    withoutEmbedding: number;
    coverage: number;
  }> => {
    const params: Record<string, string> = {};
    if (projectId) params.projectId = projectId;
    const response = await apiClient.get<{
      total: number;
      withEmbedding: number;
      withoutEmbedding: number;
      coverage: number;
    }>('/glossary/embedding-stats', { params });
    return response.data;
  },
};



