import { useState } from 'react';
import { useQuery } from 'react-query';
import { segmentsApi } from '../../api/segments.api';

interface AnalysisInspectorProps {
  segmentId: string | null;
}

export default function AnalysisInspector({ segmentId }: AnalysisInspectorProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);

  const { data: segment, isLoading, error } = useQuery(
    ['segment', segmentId],
    () => (segmentId ? segmentsApi.get(segmentId) : null),
    {
      enabled: !!segmentId,
      staleTime: 10000,
    },
  );

  if (!segmentId) {
    return null;
  }

  const hasAnalysis = segment?.mtAnalysis != null && segment.mtAnalysis.trim() !== '';
  const hasPrompt = segment?.mtFullPrompt != null && segment.mtFullPrompt.trim() !== '';

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="font-semibold text-gray-900">AI Analysis</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Stored from last MT run for this segment
        </p>
      </div>

      <div className="p-4 space-y-4">
        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-800">
              Failed to load segment: {(error as Error)?.message || 'Unknown error'}
            </p>
          </div>
        )}

        {segment && !isLoading && (
          <>
            {/* AI Reasoning */}
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-1.5">AI Reasoning</h4>
              {hasAnalysis ? (
                <p className="text-sm italic text-indigo-700 bg-indigo-50/60 border border-indigo-100 rounded-md px-3 py-2">
                  {segment.mtAnalysis}
                </p>
              ) : (
                <p className="text-sm text-gray-400 italic">No analysis stored for this segment.</p>
              )}
            </div>

            {/* View Final Prompt */}
            <div>
              <button
                type="button"
                onClick={() => setPromptExpanded((e) => !e)}
                className="flex items-center justify-between w-full text-left py-1.5 px-2 rounded hover:bg-gray-50 transition-colors"
              >
                <h4 className="text-sm font-medium text-gray-700">View Final Prompt</h4>
                <svg
                  className={`w-4 h-4 text-gray-500 transition-transform ${promptExpanded ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {promptExpanded && (
                <div className="mt-2 border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
                  {hasPrompt ? (
                    <>
                      <pre
                        className="block w-full p-4 text-xs font-mono text-slate-900 bg-white overflow-x-auto overflow-y-auto max-h-[420px] resize-none border-0 read-only border-b border-slate-200"
                        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                        aria-readonly
                      >
                        {segment.mtFullPrompt}
                      </pre>
                      <p className="text-xs text-slate-500 px-4 py-2 bg-slate-50 border-t border-slate-200">
                        Read-only · {segment.mtFullPrompt!.length} characters
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-gray-500 italic p-4">No prompt stored for this segment.</p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
