import { useState } from 'react';
import { useMutation, useQueryClient } from 'react-query';
import { analysisApi } from '../../api/analysis.api';
import type { UnfixableEntry } from '../../api/documents.api';
import toast from 'react-hot-toast';

type Props = {
  documentId: string;
  unfixable: UnfixableEntry[];
};

export default function QualityErrorsTable({ documentId, unfixable }: Props) {
  const queryClient = useQueryClient();
  const [addingToDna, setAddingToDna] = useState<Set<string>>(new Set());

  const addToDnaMutation = useMutation({
    mutationFn: async ({ entry }: { entry: UnfixableEntry }) => {
      if (entry.errorType !== 'SUSPICIOUS_ABBREV') {
        throw new Error('Only SUSPICIOUS_ABBREV errors can be added to DNA');
      }

      // Extract abbreviation from detail (e.g., "SUSPICIOUS_ABBREV: JSC" -> "JSC")
      const abbrevMatch = entry.detail?.match(/SUSPICIOUS_ABBREV:\s*(.+)/i);
      if (!abbrevMatch) {
        throw new Error('Could not extract abbreviation from error detail');
      }

      const abbreviation = abbrevMatch[1].trim();
      
      // Use abbreviation as both key and shortForm, and generate a simple longForm
      const key = abbreviation;
      const shortForm = abbreviation;
      const longForm = abbreviation; // User can edit this later if needed

      return analysisApi.addAbbreviationToDna(documentId, key, longForm, shortForm);
    },
    onSuccess: (_, { entry }) => {
      toast.success(`Added "${entry.detail?.match(/SUSPICIOUS_ABBREV:\s*(.+)/i)?.[1] || 'abbreviation'}" to DNA`);
      queryClient.invalidateQueries({ queryKey: ['dna-validation', documentId] });
      queryClient.invalidateQueries({ queryKey: ['document-dna', documentId] });
      queryClient.invalidateQueries({ queryKey: ['validator-janitor', documentId] });
      setAddingToDna(prev => {
        const next = new Set(prev);
        next.delete(entry.segmentId);
        return next;
      });
    },
    onError: (err: any, { entry }) => {
      toast.error(err?.response?.data?.error || err?.message || 'Failed to add to DNA');
      setAddingToDna(prev => {
        const next = new Set(prev);
        next.delete(entry.segmentId);
        return next;
      });
    },
  });

  const handleAddToDna = (entry: UnfixableEntry) => {
    if (entry.errorType !== 'SUSPICIOUS_ABBREV') {
      toast.error('Only SUSPICIOUS_ABBREV errors can be added to DNA');
      return;
    }

    setAddingToDna(prev => new Set([...prev, entry.segmentId]));
    addToDnaMutation.mutate({ entry });
  };

  const safeUnfixable = Array.isArray(unfixable) ? unfixable : [];

  if (safeUnfixable.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Quality Errors</h2>
        <p className="text-gray-500 text-sm">No errors found. All segments are clean!</p>
      </div>
    );
  }

  // Group by error type
  const suspiciousAbbrev = safeUnfixable.filter(e => e.errorType === 'SUSPICIOUS_ABBREV');
  const forbiddenScript = safeUnfixable.filter(e => e.errorType === 'FORBIDDEN_SCRIPT');
  const other = safeUnfixable.filter(e => e.errorType !== 'SUSPICIOUS_ABBREV' && e.errorType !== 'FORBIDDEN_SCRIPT');

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h2 className="text-lg font-semibold text-gray-900">Quality Errors</h2>
        <p className="text-sm text-gray-500 mt-1">
          {safeUnfixable.length} total error{safeUnfixable.length !== 1 ? 's' : ''}
          {suspiciousAbbrev.length > 0 && (
            <span className="ml-2">
              ({suspiciousAbbrev.length} suspicious abbreviation{suspiciousAbbrev.length !== 1 ? 's' : ''})
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
            {suspiciousAbbrev.map((entry) => {
              const abbrev = entry.detail?.match(/SUSPICIOUS_ABBREV:\s*(.+)/i)?.[1] || 'Unknown';
              const isAdding = addingToDna.has(entry.segmentId);
              
              return (
                <tr key={entry.segmentId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="text-sm font-mono text-gray-700">
                      {entry.segmentId.slice(0, 8)}…
                    </div>
                    {entry.segmentIndex && (
                      <div className="text-xs text-gray-500">#{entry.segmentIndex}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                      {entry.errorType}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-gray-900">
                      <span className="font-medium">{abbrev}</span>
                    </div>
                    {entry.detail && entry.detail !== `SUSPICIOUS_ABBREV: ${abbrev}` && (
                      <div className="text-xs text-gray-500 mt-1">{entry.detail}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => handleAddToDna(entry)}
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
            
            {forbiddenScript.map((entry) => (
              <tr key={entry.segmentId} className="hover:bg-gray-50">
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="text-sm font-mono text-gray-700">
                    {entry.segmentId.slice(0, 8)}…
                  </div>
                  {entry.segmentIndex && (
                    <div className="text-xs text-gray-500">#{entry.segmentIndex}</div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                    {entry.errorType}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm text-gray-900">{entry.detail || '—'}</div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400">
                  Manual review required
                </td>
              </tr>
            ))}
            
            {other.map((entry) => (
              <tr key={entry.segmentId} className="hover:bg-gray-50">
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="text-sm font-mono text-gray-700">
                    {entry.segmentId.slice(0, 8)}…
                  </div>
                  {entry.segmentIndex && (
                    <div className="text-xs text-gray-500">#{entry.segmentIndex}</div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                    {entry.errorType}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm text-gray-900">{entry.detail || '—'}</div>
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
