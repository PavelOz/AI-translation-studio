import { useState, useEffect } from 'react';
import type { EnrichmentProgress } from '../../api/analysis.api';

// Note: EnrichmentProgress type is defined in analysis.api.ts

type Props = {
  progress: EnrichmentProgress | null;
};

export default function BatchProgress({ progress }: Props) {
  const [recentEntries, setRecentEntries] = useState<Array<{
    ruName: string;
    shortForm: string;
    longForm: string;
    timestamp: Date;
  }>>([]);

  useEffect(() => {
    if (progress?.lastAdded) {
      setRecentEntries(prev => {
        const newEntry = {
          ...progress.lastAdded,
          timestamp: new Date(),
        };
        return [newEntry, ...prev].slice(0, 5);
      });
    }
  }, [progress?.lastAdded]);

  if (!progress || progress.status === 'idle') {
    return null;
  }

  const percentage = progress.total > 0 
    ? Math.round((progress.current / progress.total) * 100) 
    : 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-900">Enrichment Progress</h3>
        <span className="text-xs text-gray-500">
          {progress.current} / {progress.total} rows
        </span>
      </div>
      
      <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
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

      <div className="flex items-center gap-2 text-xs text-gray-600">
        {progress.status === 'processing' && (
          <>
            <svg className="animate-spin h-4 w-4 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>Processing batch {progress.batchNumber}...</span>
          </>
        )}
        {progress.status === 'completed' && (
          <>
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-green-600 font-medium">Completed</span>
          </>
        )}
        {progress.status === 'error' && (
          <>
            <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-red-600 font-medium">Error: {progress.error || 'Unknown error'}</span>
          </>
        )}
      </div>

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
