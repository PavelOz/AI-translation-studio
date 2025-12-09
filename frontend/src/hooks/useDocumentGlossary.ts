import { useQuery } from 'react-query';
import { documentsApi } from '../api/documents.api';

export type DocumentGlossaryEntry = {
  id: string;
  documentId: string;
  sourceTerm: string;
  targetTerm: string;
  createdAt: string;
};

export const useDocumentGlossary = (documentId: string | undefined) => {
  return useQuery<DocumentGlossaryEntry[]>({
    queryKey: ['glossary', documentId],
    queryFn: () => documentsApi.listDocumentGlossary(documentId!),
    enabled: !!documentId,
    staleTime: 30000, // Cache for 30 seconds
  });
};

