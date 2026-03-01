import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { segmentsApi } from '../../api/segments.api';
import toast from 'react-hot-toast';

type Props = {
  documentId: string;
  spotCheckSegmentIds: string[];
};

export default function SpotCheckWizard({ documentId, spotCheckSegmentIds }: Props) {
  const [index, setIndex] = useState(0);
  const queryClient = useQueryClient();
  
  // Ensure spotCheckSegmentIds is always an array
  const safeSpotCheckSegmentIds = Array.isArray(spotCheckSegmentIds) ? spotCheckSegmentIds : [];
  const segmentId = safeSpotCheckSegmentIds[index] ?? null;

  const { data: segment, isLoading, error: segmentError } = useQuery({
    queryKey: ['segment', segmentId],
    queryFn: () => segmentsApi.get(segmentId!),
    enabled: !!segmentId,
    retry: 1,
  });

  const updateMutation = useMutation({
    mutationFn: ({ segmentId: id, targetFinal }: { segmentId: string; targetFinal: string }) =>
      segmentsApi.update(id, { targetFinal }),
    onSuccess: (_, { segmentId: id }) => {
      queryClient.invalidateQueries({ queryKey: ['segment', id] });
      toast.success('Segment updated');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.message || 'Update failed');
    },
  });

  const total = safeSpotCheckSegmentIds.length;
  const hasPrev = index > 0;
  const hasNext = index < total - 1 && total > 0;

  const goPrev = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => setIndex((i) => Math.min(total - 1, i + 1));

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && index > 0) {
        setIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight' && index < total - 1 && total > 0) {
        setIndex((i) => Math.min(total - 1, i + 1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [index, total]);

  if (total === 0) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Spot-check wizard</h2>
        <p className="text-gray-500 text-sm">No spot-check segments in this report.</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
        <h2 className="text-lg font-semibold text-gray-900">Spot-check wizard</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={goPrev}
            disabled={!hasPrev}
            className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50 disabled:pointer-events-none"
          >
            Previous
          </button>
          <span className="text-sm text-gray-600">
            {index + 1} / {total}
          </span>
          <button
            onClick={goNext}
            disabled={!hasNext}
            className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50 disabled:pointer-events-none"
          >
            Next
          </button>
        </div>
      </div>
      <div className="p-4 space-y-4">
        {isLoading && (
          <div className="text-center py-8">
            <p className="text-gray-500">Loading segment…</p>
          </div>
        )}
        {segmentError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">Error loading segment</p>
            <p className="text-sm text-red-600 mt-1">
              {(segmentError as any)?.response?.data?.message || (segmentError as any)?.message || 'Failed to load segment'}
            </p>
          </div>
        )}
        {segment && !segmentError && (
          <>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase mb-1">Source</p>
              <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-900 whitespace-pre-wrap">
                {segment.sourceText}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase mb-1">Target (verify or edit)</p>
              <textarea
                key={segment.id}
                defaultValue={segment.targetFinal || segment.targetMt || ''}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (segment.targetFinal || segment.targetMt || '')) {
                    updateMutation.mutate({ segmentId: segment.id, targetFinal: v });
                  }
                }}
                className="w-full min-h-[100px] rounded border border-gray-300 bg-white p-3 text-sm text-gray-900"
                placeholder="Translation"
              />
            </div>
            <p className="text-xs text-gray-400">
              Segment index: {segment.segmentIndex} · ID: {segment.id.slice(0, 8)}…
            </p>
          </>
        )}
      </div>
    </section>
  );
}
