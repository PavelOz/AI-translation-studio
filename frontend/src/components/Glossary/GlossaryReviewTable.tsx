import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { glossaryApi } from '../../api/glossary.api';
import toast from 'react-hot-toast';

interface GlossaryReviewTableProps {
  documentId: string;
}

type GlossaryEntry = {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  frequency: number;
  status: 'CANDIDATE' | 'APPROVED' | 'DEPRECATED';
};

export default function GlossaryReviewTable({ documentId }: GlossaryReviewTableProps) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');

  const { data: glossaryEntries = [], isLoading, error } = useQuery({
    queryKey: ['document-glossary', documentId],
    queryFn: () => glossaryApi.getGlossary(documentId),
    enabled: !!documentId,
  });

  // Update entry mutation
  const updateMutation = useMutation({
    mutationFn: ({ entryId, data }: { entryId: string; data: { status?: 'PREFERRED' | 'DEPRECATED' | 'CANDIDATE'; targetTerm?: string } }) =>
      glossaryApi.updateDocumentGlossaryEntry(documentId, entryId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['document-glossary', documentId] });
      toast.success('Glossary entry updated');
    },
    onError: (error: any) => {
      toast.error(`Failed to update: ${error.response?.data?.message || error.message || 'Unknown error'}`);
    },
  });

  const handleApprove = async (entry: GlossaryEntry) => {
    updateMutation.mutate({
      entryId: entry.id,
      data: { status: 'PREFERRED' },
    });
  };

  const handleReject = async (entry: GlossaryEntry) => {
    updateMutation.mutate({
      entryId: entry.id,
      data: { status: 'DEPRECATED' },
    });
  };

  const handleEditStart = (entry: GlossaryEntry) => {
    setEditingId(entry.id);
    setEditValue(entry.targetTerm);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditValue('');
  };

  const handleEditSave = (entryId: string) => {
    if (editValue.trim() && editValue !== glossaryEntries.find(e => e.id === entryId)?.targetTerm) {
      updateMutation.mutate({
        entryId,
        data: { targetTerm: editValue.trim() },
      });
    }
    setEditingId(null);
    setEditValue('');
  };

  const handleEditKeyDown = (e: React.KeyboardEvent, entryId: string) => {
    if (e.key === 'Enter') {
      handleEditSave(entryId);
    } else if (e.key === 'Escape') {
      handleEditCancel();
    }
  };

  const getStatusBadge = (status: 'CANDIDATE' | 'APPROVED' | 'DEPRECATED') => {
    const baseClasses = 'px-2 py-1 text-xs font-medium rounded-full';
    switch (status) {
      case 'APPROVED':
        return (
          <span className={`${baseClasses} bg-green-100 text-green-800`}>
            Approved
          </span>
        );
      case 'CANDIDATE':
        return (
          <span className={`${baseClasses} bg-yellow-100 text-yellow-800`}>
            Candidate
          </span>
        );
      case 'DEPRECATED':
        return (
          <span className={`${baseClasses} bg-gray-100 text-gray-800`}>
            Deprecated
          </span>
        );
      default:
        return null;
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Glossary Review</h2>
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Glossary Review</h2>
        <div className="text-sm text-red-600">
          Failed to load glossary: {(error as Error).message}
        </div>
      </div>
    );
  }

  if (glossaryEntries.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Glossary Review</h2>
        <div className="text-sm text-gray-500 py-8 text-center">
          No glossary terms found. Run document analysis to extract terms.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow flex flex-col" style={{ maxHeight: '400px' }}>
      <div className="px-6 py-4 border-b border-gray-200 flex-shrink-0">
        <h2 className="text-xl font-semibold text-gray-900">Glossary Review</h2>
        <p className="text-sm text-gray-500 mt-1">
          Review and approve extracted glossary terms ({glossaryEntries.length} terms)
        </p>
      </div>
      <div className="overflow-x-auto overflow-y-auto flex-1 min-h-0">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Term (Source)
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Translation (Target)
              </th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                Freq
              </th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {glossaryEntries.map((entry) => {
              // Ensure status is always defined (default to CANDIDATE)
              const entryStatus = entry.status || 'CANDIDATE';
              const entryFrequency = typeof entry.frequency === 'number' && entry.frequency > 0 
                ? entry.frequency 
                : 1;
              
              return (
              <tr
                key={entry.id}
                className={`hover:bg-gray-50 transition-all ${
                  entryStatus === 'APPROVED' ? 'bg-green-50' : ''
                } ${entryStatus === 'DEPRECATED' ? 'opacity-50' : ''}`}
              >
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900">{entry.sourceTerm}</div>
                </td>
                <td className="px-6 py-4">
                  {editingId === entry.id ? (
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleEditSave(entry.id)}
                      onKeyDown={(e) => handleEditKeyDown(e, entry.id)}
                      className="w-full px-2 py-1 text-sm border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      autoFocus
                    />
                  ) : (
                    <div
                      className="text-sm text-gray-700 cursor-pointer hover:text-blue-600 hover:underline"
                      onClick={() => handleEditStart(entry)}
                      title="Click to edit"
                    >
                      {entry.targetTerm}
                    </div>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center">
                  <span className="text-sm text-gray-500">
                    {entryFrequency}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center">
                  {getStatusBadge(entryStatus)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center">
                  <div className="flex items-center justify-center space-x-2">
                    <button
                      onClick={() => handleApprove(entry)}
                      disabled={entryStatus === 'APPROVED' || updateMutation.isPending}
                      className={`p-1.5 rounded-md ${
                        entryStatus === 'APPROVED'
                          ? 'text-gray-400 cursor-not-allowed'
                          : 'text-green-600 hover:bg-green-50 hover:text-green-700'
                      } transition-colors disabled:opacity-50`}
                      title="Approve term"
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleReject(entry)}
                      disabled={entryStatus === 'DEPRECATED' || updateMutation.isPending}
                      className={`p-1.5 rounded-md ${
                        entryStatus === 'DEPRECATED'
                          ? 'text-gray-400 cursor-not-allowed'
                          : 'text-red-600 hover:bg-red-50 hover:text-red-700'
                      } transition-colors disabled:opacity-50`}
                      title="Reject term"
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

