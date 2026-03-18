import apiClient from './client';

export type GlossaryStatus = 'CANDIDATE' | 'PREFERRED' | 'DEPRECATED';

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

  /** Delete multiple entries by id. */
  deleteMany: async (ids: string[]): Promise<{ deleted: number }> => {
    const response = await apiClient.post<{ deleted: number }>('/glossary/delete-many', { ids });
    return response.data;
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

  /** Export glossary as CSV (same format as import: term_source, term_target, notes, forbidden). */
  export: async (
    sourceLocale: string,
    targetLocale: string,
    projectId?: string,
  ): Promise<void> => {
    const params = new URLSearchParams({ sourceLocale, targetLocale });
    if (projectId) params.set('projectId', projectId);
    const response = await apiClient.get(`/glossary/export?${params.toString()}`, {
      responseType: 'blob',
    });
    const blob = response.data as Blob;
    const filename = `glossary-${sourceLocale}-${targetLocale}${projectId ? `-${projectId.slice(0, 8)}` : ''}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 200);
  },

  getGlossary: async (documentId: string): Promise<Array<{
    id: string;
    sourceTerm: string;
    targetTerm: string;
    frequency: number;
    status: 'CANDIDATE' | 'APPROVED' | 'DEPRECATED';
    source: 'global' | 'project' | 'new';
  }>> => {
    const response = await apiClient.get(`/documents/${documentId}/glossary`);
    return response.data;
  },

  /** Clear all document glossary entries for this document. */
  clearDocumentGlossary: async (documentId: string): Promise<{ deleted: number }> => {
    const response = await apiClient.delete<{ deleted: number }>(`/documents/${documentId}/glossary`);
    return response.data;
  },

  updateDocumentGlossaryEntry: async (
    documentId: string,
    entryId: string,
    data: { status?: 'PREFERRED' | 'DEPRECATED' | 'CANDIDATE'; targetTerm?: string },
  ): Promise<{
    id: string;
    sourceTerm: string;
    targetTerm: string;
    status: 'CANDIDATE' | 'APPROVED' | 'DEPRECATED';
  }> => {
    const response = await apiClient.patch(`/documents/${documentId}/glossary/${entryId}`, data);
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

  translateTerm: async (
    term: string,
    lang?: string,
    sourceLang?: string,
    projectId?: string,
  ): Promise<{ translation: string }> => {
    const response = await apiClient.post<{ translation: string }>('/documents/translate-term', {
      term,
      lang,
      sourceLang,
      projectId,
    });
    return response.data;
  },
};



