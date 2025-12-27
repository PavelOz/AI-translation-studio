import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { glossaryApi } from '../../api/glossary.api';
import { documentsApi } from '../../api/documents.api';
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
  source: 'global' | 'project' | 'new';
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

  // Fetch document data to get target locale and project ID
  const { data: documentData } = useQuery({
    queryKey: ['documents', documentId],
    queryFn: () => documentsApi.getDocument(documentId!),
    enabled: !!documentId,
  });

  // Update entry mutation
  const updateMutation = useMutation({
    mutationFn: ({ entryId, data }: { entryId: string; data: { status?: 'PREFERRED' | 'DEPRECATED' | 'CANDIDATE'; targetTerm?: string } }) =>
      glossaryApi.updateDocumentGlossaryEntry(documentId, entryId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['document-glossary', documentId] });
      // Toast messages are handled in individual handlers (handleApprove/handleReject)
    },
    onError: (error: any) => {
      toast.error(`Failed to update: ${error.response?.data?.message || error.message || 'Unknown error'}`);
    },
  });

  const handleApprove = async (entry: GlossaryEntry) => {
    updateMutation.mutate(
      {
        entryId: entry.id,
        data: { status: 'PREFERRED' },
      },
      {
        onSuccess: () => {
          toast.success(`Term "${entry.sourceTerm}" approved and added to glossary`);
        },
      }
    );
  };

  const handleReject = async (entry: GlossaryEntry) => {
    updateMutation.mutate(
      {
        entryId: entry.id,
        data: { status: 'DEPRECATED' },
      },
      {
        onSuccess: () => {
          toast.error(`Term "${entry.sourceTerm}" rejected and removed from glossary`);
        },
      }
    );
  };

  const handleResetToCandidate = async (entry: GlossaryEntry) => {
    updateMutation.mutate(
      {
        entryId: entry.id,
        data: { status: 'CANDIDATE' },
      },
      {
        onSuccess: () => {
          toast.success(`Term "${entry.sourceTerm}" reset to candidate status`);
        },
      }
    );
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

  // Translate term mutation
  const translateMutation = useMutation({
    mutationFn: ({ term, lang, sourceLang, projectId }: { term: string; lang?: string; sourceLang?: string; projectId?: string }) =>
      glossaryApi.translateTerm(term, lang, sourceLang, projectId),
    onError: (error: any) => {
      toast.error(`Translation failed: ${error.response?.data?.message || error.message || 'Unknown error'}`);
    },
  });

  const handleTranslate = async (entry: GlossaryEntry) => {
    try {
      const targetLang = documentData?.targetLocale || 'en';
      const sourceLang = documentData?.sourceLocale;
      const projectId = documentData?.projectId;

      const result = await translateMutation.mutateAsync({
        term: entry.sourceTerm,
        lang: targetLang,
        sourceLang,
        projectId,
      });

      // Update the entry with the translation
      updateMutation.mutate({
        entryId: entry.id,
        data: { targetTerm: result.translation },
      }, {
        onSuccess: () => {
          toast.success(`Translated "${entry.sourceTerm}"`);
        },
      });
    } catch (error) {
      // Error is already handled by translateMutation.onError
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
          <span className={`${baseClasses} bg-red-100 text-red-800 border border-red-300`}>
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
                Source Term
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
                  entryStatus === 'APPROVED' 
                    ? 'bg-green-50 border-l-4 border-green-500' 
                    : entryStatus === 'DEPRECATED'
                    ? 'opacity-70 bg-red-50 border-l-4 border-red-400'
                    : ''
                }`}
              >
                <td className="px-6 py-4">
                  <div className="flex flex-col">
                    <div className="text-sm font-medium text-gray-900">{entry.sourceTerm}</div>
                    <div className="text-xs mt-1">
                      {entry.source === 'global' && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-blue-700 bg-blue-100 font-medium">
                          Global
                        </span>
                      )}
                      {entry.source === 'project' && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-purple-700 bg-purple-100 font-medium">
                          Project
                        </span>
                      )}
                      {entry.source === 'new' && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-gray-600 bg-gray-100">
                          New
                        </span>
                      )}
                      {!entry.source && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-gray-400 bg-gray-50 italic">
                          Unknown
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center space-x-2">
                    {editingId === entry.id ? (
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleEditSave(entry.id)}
                        onKeyDown={(e) => handleEditKeyDown(e, entry.id)}
                        className="flex-1 px-2 py-1 text-sm border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                        autoFocus
                      />
                    ) : (
                      <>
                        <div
                          className="flex-1 text-sm text-gray-700 cursor-pointer hover:text-blue-600 hover:underline"
                          onClick={() => handleEditStart(entry)}
                          title="Click to edit"
                        >
                          {entry.targetTerm}
                        </div>
                        <button
                          onClick={() => handleTranslate(entry)}
                          disabled={translateMutation.isPending || updateMutation.isPending}
                          className="p-1.5 rounded-md transition-all text-blue-600 hover:bg-blue-50 hover:text-blue-700 hover:scale-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Translate term with AI"
                        >
                          {translateMutation.isPending ? (
                            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          ) : (
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                            </svg>
                          )}
                        </button>
                      </>
                    )}
                  </div>
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
                      className={`p-1.5 rounded-md transition-all ${
                        entryStatus === 'APPROVED'
                          ? 'text-gray-400 cursor-not-allowed bg-gray-100'
                          : entryStatus === 'DEPRECATED'
                          ? 'text-green-600 hover:bg-green-50 hover:text-green-700 hover:scale-110 active:scale-95'
                          : 'text-green-600 hover:bg-green-50 hover:text-green-700 hover:scale-110 active:scale-95'
                      } disabled:opacity-50`}
                      title={entryStatus === 'DEPRECATED' ? 'Restore term (approve)' : entryStatus === 'APPROVED' ? 'Already approved' : 'Approve term'}
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleReject(entry)}
                      disabled={entryStatus === 'DEPRECATED' || updateMutation.isPending}
                      className={`p-1.5 rounded-md transition-all ${
                        entryStatus === 'DEPRECATED'
                          ? 'text-gray-400 cursor-not-allowed bg-gray-100'
                          : 'text-red-600 hover:bg-red-50 hover:text-red-700 hover:scale-110 active:scale-95'
                      } disabled:opacity-50`}
                      title={entryStatus === 'DEPRECATED' ? 'Already rejected' : 'Reject term (remove from glossary)'}
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                    {entryStatus !== 'CANDIDATE' && (
                      <button
                        onClick={() => handleResetToCandidate(entry)}
                        disabled={updateMutation.isPending}
                        className="p-1.5 rounded-md transition-all text-yellow-600 hover:bg-yellow-50 hover:text-yellow-700 hover:scale-110 active:scale-95 disabled:opacity-50"
                        title="Reset to candidate status"
                      >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                    )}
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

