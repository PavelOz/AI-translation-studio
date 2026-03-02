import { useState } from 'react';
import { useMutation, useQueryClient } from 'react-query';
import { analysisApi } from '../../api/analysis.api';
import type { SegmentAuditResult } from '../../api/janitor.api';
import toast from 'react-hot-toast';

type Props = {
  documentId: string;
  segmentsRequiringReview: SegmentAuditResult[];
};

export default function QualityErrorsTable({ documentId, segmentsRequiringReview }: Props) {
  const queryClient = useQueryClient();
  const [addingToDna, setAddingToDna] = useState<Set<string>>(new Set());

  const addToDnaMutation = useMutation({
    mutationFn: async ({ term }: { term: string }) => {
      // Use term as both key and shortForm, and generate a simple longForm
      const key = term;
      const shortForm = term;
      const longForm = term; // User can edit this later if needed

      return analysisApi.addAbbreviationToDna(documentId, key, longForm, shortForm);
    },
    onSuccess: (_, { term }) => {
      toast.success(`Added "${term}" to DNA`);
      queryClient.invalidateQueries({ queryKey: ['dna-validation', documentId] });
      queryClient.invalidateQueries({ queryKey: ['document-dna', documentId] });
      queryClient.invalidateQueries({ queryKey: ['janitor-report', documentId] });
      setAddingToDna(prev => {
        const next = new Set(prev);
        next.delete(term);
        return next;
      });
    },
    onError: (err: any, { term }) => {
      toast.error(err?.response?.data?.error || err?.message || 'Failed to add to DNA');
      setAddingToDna(prev => {
        const next = new Set(prev);
        next.delete(term);
        return next;
      });
    },
  });

  const handleAddToDna = (term: string) => {
    setAddingToDna(prev => new Set([...prev, term]));
    addToDnaMutation.mutate({ term });
  };

  const safeSegments = Array.isArray(segmentsRequiringReview) ? segmentsRequiringReview : [];
  
  // Extract all errors from segments
  const allErrors = safeSegments.flatMap(segment => 
    segment.errors.map(error => ({ segment, error }))
  );

  if (allErrors.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Quality Errors</h2>
        <p className="text-gray-500 text-sm">No errors found. All segments are clean!</p>
      </div>
    );
  }

  // Group by error type
  const missedTerms = allErrors.filter(({ error }) => error.type === 'MISSED_TERM' && error.term);
  const wrongTerms = allErrors.filter(({ error }) => error.type === 'WRONG_TERM' && error.term);
  const scriptMixing = allErrors.filter(({ error }) => error.type === 'SCRIPT_MIXING');
  const other = allErrors.filter(({ error }) => 
    !['MISSED_TERM', 'WRONG_TERM', 'SCRIPT_MIXING'].includes(error.type) || 
    (error.type === 'MISSED_TERM' && !error.term) ||
    (error.type === 'WRONG_TERM' && !error.term)
  );

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h2 className="text-lg font-semibold text-gray-900">Quality Errors</h2>
        <p className="text-sm text-gray-500 mt-1">
          {allErrors.length} total error{allErrors.length !== 1 ? 's' : ''} in {safeSegments.length} segment{safeSegments.length !== 1 ? 's' : ''}
          {missedTerms.length > 0 && (
            <span className="ml-2">
              ({missedTerms.length} missed term{missedTerms.length !== 1 ? 's' : ''})
            </span>
          )}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                ID
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Type
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Detail
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {missedTerms.map(({ segment, error }) => {
              const term = error.term || 'Unknown';
              const isAdding = addingToDna.has(term);
              
              return (
                <tr key={`${segment.segmentId}-${error.type}-${term}`} className="hover:bg-gray-50">
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="text-sm font-mono text-gray-700">
                      {segment.segmentId.slice(0, 8)}…
                    </div>
                    <div className="text-xs text-gray-500">#{segment.segmentIndex}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                      {error.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-gray-900">
                      <span className="font-medium">Missing: {term}</span>
                    </div>
                    {error.message && (
                      <div className="text-xs text-gray-500 mt-1">{error.message}</div>
                    )}
                    {segment.janitorComment && (
                      <div className="text-xs text-blue-600 mt-1 italic">{segment.janitorComment}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => handleAddToDna(term)}
                      disabled={isAdding || addToDnaMutation.isPending}
                      className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isAdding ? (
                        <>
                          <svg className="animate-spin -ml-1 mr-2 h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Adding...
                        </>
                      ) : (
                        'Add to DNA'
                      )}
                    </button>
                  </td>
                </tr>
              );
            })}
            
            {wrongTerms.map(({ segment, error }) => (
              <tr key={`${segment.segmentId}-${error.type}-${error.term}`} className="hover:bg-gray-50">
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="text-sm font-mono text-gray-700">
                    {segment.segmentId.slice(0, 8)}…
                  </div>
                  <div className="text-xs text-gray-500">#{segment.segmentIndex}</div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                    {error.type}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm text-gray-900">
                    <span className="font-medium">Term: {error.term}</span>
                    {error.expected && error.found && (
                      <div className="text-xs text-gray-500 mt-1">
                        Expected: {error.expected}, Found: {error.found}
                      </div>
                    )}
                  </div>
                  {error.message && (
                    <div className="text-xs text-gray-500 mt-1">{error.message}</div>
                  )}
                  {segment.janitorComment && (
                    <div className="text-xs text-blue-600 mt-1 italic">{segment.janitorComment}</div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400">
                  Manual review required
                </td>
              </tr>
            ))}
            
            {scriptMixing.map(({ segment, error }) => (
              <tr key={`${segment.segmentId}-${error.type}`} className="hover:bg-gray-50">
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="text-sm font-mono text-gray-700">
                    {segment.segmentId.slice(0, 8)}…
                  </div>
                  <div className="text-xs text-gray-500">#{segment.segmentIndex}</div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                    {error.type}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm text-gray-900">{error.message || '—'}</div>
                  {segment.janitorComment && (
                    <div className="text-xs text-blue-600 mt-1 italic">{segment.janitorComment}</div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400">
                  Manual review required
                </td>
              </tr>
            ))}
            
            {other.map(({ segment, error }) => (
              <tr key={`${segment.segmentId}-${error.type}-${error.message}`} className="hover:bg-gray-50">
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="text-sm font-mono text-gray-700">
                    {segment.segmentId.slice(0, 8)}…
                  </div>
                  <div className="text-xs text-gray-500">#{segment.segmentIndex}</div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                    {error.type}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm text-gray-900">{error.message || '—'}</div>
                  {segment.janitorComment && (
                    <div className="text-xs text-blue-600 mt-1 italic">{segment.janitorComment}</div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400">
                  —
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
