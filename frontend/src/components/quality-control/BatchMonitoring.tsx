import { useQuery } from 'react-query';
import { useState, useEffect } from 'react';

type Props = {
  documentId: string;
};

type EnrichmentProgress = {
  documentId: string;
  status: 'idle' | 'processing' | 'completed' | 'error';
  current: number;
  total: number;
  batchNumber: number;
  totalBatches: number;
  added: number;
  skipped: number;
  conflicts: number;
  errors: Array<{ row: number; ruName: string; error: string }>;
  lastAdded?: {
    ruName: string;
    shortForm: string;
    longForm: string;
  };
  error?: string;
  startedAt: string;
  updatedAt: string;
};

export default function BatchMonitoring({ documentId }: Props) {
  const [recentEntries, setRecentEntries] = useState<Array<{
    ruName: string;
    shortForm: string;
    longForm: string;
    timestamp: Date;
  }>>([]);

  const { data: progress, isLoading } = useQuery({
    queryKey: ['enrichment-progress', documentId],
    queryFn: async () => {
      const response = await fetch(`/api/documents/${documentId}/dna/enrich/progress`);
      if (!response.ok) return null;
      const data = await response.json();
      // Ensure all required fields exist
      if (data && typeof data === 'object') {
        return {
          ...data,
          added: data.added ?? 0,
          skipped: data.skipped ?? 0,
          conflicts: data.conflicts ?? 0,
          errors: data.errors ?? [],
        } as EnrichmentProgress;
      }
      return null;
    },
    enabled: !!documentId,
    refetchInterval: (data) => {
      // Stop polling if completed or error
      if (data?.status === 'completed' || data?.status === 'error') {
        return false;
      }
      return 2000; // Poll every 2 seconds
    },
  });

  useEffect(() => {
    if (progress?.lastAdded) {
      setRecentEntries(prev => {
        const newEntry = {
          ...progress.lastAdded!,
          timestamp: new Date(),
        };
        return [newEntry, ...prev].slice(0, 5);
      });
    }
  }, [progress?.lastAdded]);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
        <p className="text-sm text-gray-500">Loading progress...</p>
      </div>
    );
  }

  if (!progress) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
        <p className="text-sm text-gray-500">No progress data for document {documentId.slice(0, 8)}...</p>
      </div>
    );
  }

  const percentage = progress.total > 0 
    ? Math.round((progress.current / progress.total) * 100) 
    : 0;

  const duration = progress.startedAt 
    ? Math.round((new Date().getTime() - new Date(progress.startedAt).getTime()) / 1000)
    : 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-gray-900">
            Document: {documentId.slice(0, 8)}...
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            Started {duration > 0 ? `${duration}s ago` : 'just now'}
          </p>
        </div>
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
          progress.status === 'completed' 
            ? 'bg-green-100 text-green-800'
            : progress.status === 'error'
            ? 'bg-red-100 text-red-800'
            : 'bg-blue-100 text-blue-800'
        }`}>
          {progress.status.toUpperCase()}
        </span>
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-gray-600">
            Batch {progress.batchNumber} / {progress.totalBatches}
          </span>
          <span className="text-gray-600">
            {progress.current} / {progress.total} rows ({percentage}%)
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2.5">
          <div
            className={`h-2.5 rounded-full transition-all duration-300 ${
              progress.status === 'error' 
                ? 'bg-red-600' 
                : progress.status === 'completed'
                ? 'bg-green-600'
                : 'bg-blue-600'
            }`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-3 text-sm">
        <div>
          <span className="text-gray-500">Added:</span>
          <span className="ml-2 font-medium text-green-600">{progress.added ?? 0}</span>
        </div>
        <div>
          <span className="text-gray-500">Skipped:</span>
          <span className="ml-2 font-medium text-gray-600">{progress.skipped ?? 0}</span>
        </div>
        <div>
          <span className="text-gray-500">Conflicts:</span>
          <span className="ml-2 font-medium text-amber-600">{progress.conflicts ?? 0}</span>
        </div>
      </div>

      {progress.error && (
        <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-800">
          Error: {progress.error}
        </div>
      )}

      {recentEntries.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-200">
          <h4 className="text-xs font-medium text-gray-700 mb-2">Last 5 Added Entries</h4>
          <div className="space-y-2">
            {recentEntries.map((entry, idx) => (
              <div key={idx} className="text-xs bg-gray-50 rounded p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate" title={entry.ruName}>
                      "{entry.ruName}"
                    </p>
                    <p className="text-gray-600 mt-0.5">
                      → <span className="font-medium">{entry.shortForm}</span>
                      {entry.longForm && (
                        <span className="text-gray-500 ml-1">({entry.longForm})</span>
                      )}
                    </p>
                  </div>
                  <span className="text-gray-400 text-xs whitespace-nowrap">
                    {entry.timestamp.toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
