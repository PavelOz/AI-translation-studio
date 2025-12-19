import { useQuery } from 'react-query';
import { glossaryApi } from '../api/glossary.api';

export type DocumentGlossaryEntry = {
  id: string;
  documentId: string;
  sourceTerm: string;
  targetTerm: string;
  createdAt: string;
  frequency?: number;
  status?: 'CANDIDATE' | 'PREFERRED' | 'DEPRECATED';
  source?: 'global' | 'project' | 'new';
};

export const useDocumentGlossary = (documentId: string | undefined) => {
  return useQuery<DocumentGlossaryEntry[]>({
    queryKey: ['glossary', documentId],
    queryFn: async () => {
      if (!documentId) return [];
      try {
        const data = await glossaryApi.getGlossary(documentId);
        // Map the API response to match DocumentGlossaryEntry type
        return data.map(entry => ({
          id: entry.id,
          documentId: documentId,
          sourceTerm: entry.sourceTerm,
          targetTerm: entry.targetTerm,
          createdAt: '', // API doesn't return createdAt, use empty string
          frequency: entry.frequency,
          status: entry.status,
          source: entry.source,
        }));
      } catch (err: any) {
        // Handle 404 gracefully - it just means glossary hasn't been generated yet
        if (err?.response?.status === 404) {
          return []; // Return empty array instead of throwing
        }
        throw err; // Re-throw other errors
      }
    },
    enabled: !!documentId,
    staleTime: 0, // Always refetch when invalidated (no stale time cache)
    retry: (failureCount, error: any) => {
      // Don't retry on 404 errors (glossary just hasn't been generated)
      if (error?.response?.status === 404) {
        return false;
      }
      // Retry other errors up to 3 times
      return failureCount < 3;
    },
  });
};


