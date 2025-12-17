import { useMutation, useQueryClient } from 'react-query';
import { documentsApi } from '../api/documents.api';
import toast from 'react-hot-toast';

export const useDocuments = () => {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: documentsApi.delete,
    onSuccess: (_, documentId) => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      // Also invalidate any document-specific queries
      queryClient.invalidateQueries({ queryKey: ['documents', documentId] });
      toast.success('Document deleted successfully');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to delete document');
    },
  });

  return {
    delete: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  };
};
