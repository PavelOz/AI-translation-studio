import Layout from '../components/Layout';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { documentsApi } from '../api/documents.api';
import { segmentsApi } from '../api/segments.api';
import { getLanguageName } from '../utils/languages';
import { stripFormattingMarkers } from '../utils/formatting';
import toast from 'react-hot-toast';

export default function DocumentViewPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: document } = useQuery({
    queryKey: ['documents', documentId],
    queryFn: () => documentsApi.get(documentId!),
    enabled: !!documentId,
  });

  const { data: segmentsData } = useQuery({
    queryKey: ['segments', documentId],
    queryFn: () => segmentsApi.list(documentId!, 1, 200),
    enabled: !!documentId,
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: documentsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast.success('Document deleted successfully');
      // Navigate back to projects page
      navigate('/projects');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to delete document');
    },
  });

  const handleDeleteDocument = () => {
    if (window.confirm(`Are you sure you want to delete document "${document?.name}"? This action cannot be undone.`)) {
      deleteDocumentMutation.mutate(documentId!);
    }
  };

  if (!document) {
    return (
      <Layout>
        <div className="text-center">Loading...</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{document.name}</h1>
            <p className="text-gray-600 mt-2">
              {getLanguageName(document.sourceLocale)} → {getLanguageName(document.targetLocale)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={`/documents/${documentId}/editor`}
              className="btn btn-primary"
            >
              Open Editor
            </Link>
            <button
              onClick={handleDeleteDocument}
              disabled={deleteDocumentMutation.isPending}
              className="btn btn-danger"
            >
              {deleteDocumentMutation.isPending ? 'Deleting...' : 'Delete Document'}
            </button>
          </div>
        </div>

        <div className="card">
          <h2 className="text-xl font-semibold mb-4">Segments</h2>
          {segmentsData && segmentsData.segments.length > 0 ? (
            <div className="space-y-4">
              {segmentsData.segments.map((segment) => (
                <div key={segment.id} className="border-b border-gray-200 pb-4">
                  <div className="mb-2">
                    <p className="text-sm text-gray-600">Source:</p>
                    <p className="text-gray-900">{stripFormattingMarkers(segment.sourceText)}</p>
                  </div>
                  {segment.targetFinal && (
                    <div>
                      <p className="text-sm text-gray-600">Target:</p>
                      <p className="text-gray-900">{segment.targetFinal}</p>
                    </div>
                  )}
                  <span className="text-xs text-gray-500 mt-2 inline-block">
                    Status: {segment.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">No segments found</p>
          )}
        </div>
      </div>
    </Layout>
  );
}

