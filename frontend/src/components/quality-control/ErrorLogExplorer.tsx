import { useMutation, useQueryClient } from 'react-query';
import { segmentsApi, type Segment } from '../../api/segments.api';
import type { UnfixableEntry } from '../../api/documents.api';
import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';

type Props = {
  documentId: string;
  unfixable: UnfixableEntry[];
};

export default function ErrorLogExplorer({ documentId, unfixable }: Props) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  // Ensure unfixable is always an array
  const safeUnfixable = Array.isArray(unfixable) ? unfixable : [];

  // Limit queries to prevent performance issues - only load first 50 segments initially
  // Load additional segments on demand when user interacts with them
  const MAX_INITIAL_QUERIES = 50;
  const initialUnfixable = safeUnfixable.slice(0, MAX_INITIAL_QUERIES).filter(e => e?.segmentId);
  const [loadedSegmentIds, setLoadedSegmentIds] = useState<Set<string>>(new Set());

  // Load segments on-demand instead of using useQueries to avoid performance issues
  // Store loaded segments in state and fetch them individually when needed
  const [loadedSegments, setLoadedSegments] = useState<Map<string, Segment>>(new Map());
  const [loadingSegmentIds, setLoadingSegmentIds] = useState<Set<string>>(new Set());
  
  // Load first 50 segments on mount
  useEffect(() => {
    const segmentIdsToLoad = initialUnfixable.slice(0, 50).map(e => e.segmentId).filter(Boolean);
    segmentIdsToLoad.forEach(segmentId => {
      if (!loadedSegments.has(segmentId) && !loadingSegmentIds.has(segmentId)) {
        setLoadingSegmentIds(prev => new Set([...prev, segmentId]));
        segmentsApi.get(segmentId)
          .then(segment => {
            setLoadedSegments(prev => new Map([...prev, [segmentId, segment]]));
            setLoadingSegmentIds(prev => {
              const next = new Set(prev);
              next.delete(segmentId);
              return next;
            });
          })
          .catch(err => {
            console.error(`Failed to load segment ${segmentId}:`, err);
            setLoadingSegmentIds(prev => {
              const next = new Set(prev);
              next.delete(segmentId);
              return next;
            });
          });
      }
    });
  }, []); // Only run on mount

  const segmentsById = loadedSegments;
  const isLoadingSegments = loadingSegmentIds.size > 0;
  const hasErrors = false; // Track errors per segment if needed

  const updateMutation = useMutation({
    mutationFn: ({ segmentId, targetFinal }: { segmentId: string; targetFinal: string }) =>
      segmentsApi.update(segmentId, { targetFinal }),
    onSuccess: (_, { segmentId }) => {
      queryClient.invalidateQueries({ queryKey: ['segment', segmentId] });
      setEditingId(null);
      toast.success('Segment updated');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.message || 'Update failed');
    },
  });

  const startEdit = (entry: UnfixableEntry) => {
    // Load segment if not already loaded
    if (!loadedSegments.has(entry.segmentId) && !loadingSegmentIds.has(entry.segmentId)) {
      setLoadingSegmentIds(prev => new Set([...prev, entry.segmentId]));
      segmentsApi.get(entry.segmentId)
        .then(segment => {
          setLoadedSegments(prev => new Map([...prev, [entry.segmentId, segment]]));
          setLoadingSegmentIds(prev => {
            const next = new Set(prev);
            next.delete(entry.segmentId);
            return next;
          });
          // Set edit text after loading
          setEditText(segment?.targetFinal ?? segment?.targetMt ?? '');
          setEditingId(entry.segmentId);
        })
        .catch(err => {
          console.error(`Failed to load segment ${entry.segmentId}:`, err);
          setLoadingSegmentIds(prev => {
            const next = new Set(prev);
            next.delete(entry.segmentId);
            return next;
          });
          toast.error('Failed to load segment');
        });
    } else {
      // Segment already loaded or loading
      const seg = loadedSegments.get(entry.segmentId);
      setEditText(seg?.targetFinal ?? seg?.targetMt ?? '');
      setEditingId(entry.segmentId);
    }
  };

  const saveEdit = () => {
    if (!editingId) return;
    updateMutation.mutate({ segmentId: editingId, targetFinal: editText });
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  if (safeUnfixable.length === 0) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Error log (unfixable)</h2>
        <p className="text-gray-500 text-sm">No unfixable entries.</p>
      </section>
    );
  }

  if (hasErrors) {
    return (
      <section className="rounded-lg border border-red-200 bg-red-50 p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-red-900 mb-2">Error log (unfixable)</h2>
        <p className="text-red-600 text-sm">Failed to load some segments. Please try refreshing the page.</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">Error log (unfixable)</h2>
        <p className="text-sm text-gray-500">
          {safeUnfixable.length} entries
          {isLoadingSegments && <span className="ml-2 text-xs text-gray-400">(Loading segments...)</span>}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">#</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Segment ID</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Detail</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Target (preview)</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {safeUnfixable.map((entry, entryIndex) => {
              if (!entry?.segmentId) return null;
              
              const segment = loadedSegments.get(entry.segmentId);
              const isEditing = editingId === entry.segmentId;
              const isLoadingSegment = loadingSegmentIds.has(entry.segmentId);
              const hasError = false; // Track per-segment errors if needed
              
              // For entries beyond initial 50, show "Click to load" if not loaded
              const needsLoad = entryIndex >= MAX_INITIAL_QUERIES && !loadedSegments.has(entry.segmentId) && !loadingSegmentIds.has(entry.segmentId);
              return (
                <tr key={entry.segmentId} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-sm text-gray-600">{entry.segmentIndex ?? '—'}</td>
                  <td className="px-4 py-2 text-sm font-mono text-gray-700 truncate max-w-[120px]" title={entry.segmentId}>
                    {entry.segmentId.slice(0, 8)}…
                  </td>
                  <td className="px-4 py-2">
                    <span className="text-xs font-medium px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                      {entry.errorType}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-600 max-w-[200px] truncate" title={entry.detail}>
                    {entry.detail ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-700 max-w-[280px]">
                    {needsLoad ? (
                      <span className="text-gray-400 italic text-xs">Click Edit to load</span>
                    ) : isLoadingSegment ? (
                      <span className="text-gray-400 italic">Loading...</span>
                    ) : hasError ? (
                      <span className="text-red-500 text-xs">Failed to load</span>
                    ) : isEditing ? (
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        className="w-full min-h-[80px] border border-gray-300 rounded px-2 py-1 text-sm"
                        rows={3}
                      />
                    ) : (
                      <span className="line-clamp-2">
                        {(segment?.targetFinal || segment?.targetMt || '—').slice(0, 120)}
                        {((segment?.targetFinal || segment?.targetMt)?.length ?? 0) > 120 ? '…' : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {needsLoad || isLoadingSegment || hasError ? (
                      <span className="text-xs text-gray-400">—</span>
                    ) : isEditing ? (
                      <span className="flex justify-end gap-1">
                        <button
                          onClick={cancelEdit}
                          className="text-sm text-gray-600 hover:text-gray-800"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={saveEdit}
                          disabled={updateMutation.isPending}
                          className="text-sm text-primary-600 hover:text-primary-800 font-medium"
                        >
                          Save
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => startEdit(entry)}
                        className="text-sm text-primary-600 hover:text-primary-800 font-medium"
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
