import { useState, useEffect } from 'react';
import { useQuery } from 'react-query';
import { segmentsApi } from '../../api/segments.api';

interface DebugInspectorPanelProps {
  segmentId: string | null;
}

export default function DebugInspectorPanel({ segmentId }: DebugInspectorPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { data: debugInfo, isLoading, error } = useQuery(
    ['segment-debug', segmentId],
    () => (segmentId ? segmentsApi.getDebugInfo(segmentId) : null),
    {
      enabled: !!segmentId && isExpanded,
      staleTime: 30000,
    },
  );

  if (!segmentId) {
    return null;
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center space-x-2">
          <svg
            className={`w-5 h-5 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <h3 className="font-semibold text-gray-900">Debug/Inspector</h3>
        </div>
        {isExpanded && (
          <span className="text-xs text-gray-500">
            {isLoading ? 'Loading...' : debugInfo ? 'Ready' : 'Click to load'}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-gray-200 p-4 space-y-4 max-h-[600px] overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">
                Failed to load debug information: {(error as any)?.message || 'Unknown error'}
              </p>
            </div>
          )}

          {debugInfo && (
            <>
              {/* TM Matches */}
              <div>
                <h4 className="font-semibold text-gray-900 mb-2 flex items-center">
                  <span className="text-blue-600 mr-2">📝</span>
                  TM Matches ({debugInfo.tmMatches.length})
                </h4>
                {debugInfo.tmMatches.length > 0 ? (
                  <div className="space-y-2">
                    {debugInfo.tmMatches.map((match, index) => (
                      <div
                        key={match.id}
                        className={`p-3 rounded-lg border ${
                          index === 0 && match.fuzzyScore >= 70
                            ? 'bg-blue-50 border-blue-200'
                            : 'bg-gray-50 border-gray-200'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-gray-700">
                            Match #{index + 1}
                            {index === 0 && match.fuzzyScore >= 70 && (
                              <span className="ml-2 text-xs text-blue-600">(Used)</span>
                            )}
                          </span>
                          <div className="flex items-center space-x-2">
                            <span
                              className={`px-2 py-0.5 rounded text-xs font-medium ${
                                match.searchMethod === 'vector' || match.searchMethod === 'hybrid'
                                  ? 'bg-blue-100 text-blue-800 border border-blue-300'
                                  : 'bg-green-100 text-green-800 border border-green-300'
                              }`}
                            >
                              {match.searchMethod === 'vector' 
                                ? '[MEANING MATCH]' 
                                : match.searchMethod === 'hybrid'
                                ? '[MEANING MATCH]' 
                                : '[TEXT MATCH]'}
                            </span>
                            <span 
                              className={`text-sm font-semibold ${
                                match.searchMethod === 'vector' || match.searchMethod === 'hybrid'
                                  ? 'text-blue-600'
                                  : 'text-green-600'
                              }`}
                            >
                              {match.fuzzyScore}%
                            </span>
                            <span className="text-xs text-gray-500">({match.scope})</span>
                          </div>
                        </div>
                        <div className="text-sm text-gray-600 space-y-1">
                          <div>
                            <span className="font-medium">Source:</span>{' '}
                            <span className="bg-white px-1 rounded">{match.sourceText}</span>
                          </div>
                          <div>
                            <span className="font-medium">Target:</span>{' '}
                            <span className="bg-white px-1 rounded">{match.targetText}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 italic">No TM matches found</p>
                )}
              </div>

              {/* Glossary Terms */}
              <div>
                <h4 className="font-semibold text-gray-900 mb-2 flex items-center">
                  <span className="text-green-600 mr-2">📚</span>
                  Glossary Terms ({debugInfo.glossaryTerms.length})
                </h4>
                {debugInfo.glossaryTerms.length > 0 ? (
                  <div className="space-y-2">
                    {debugInfo.glossaryTerms.map((term, index) => (
                      <div
                        key={index}
                        className={`p-3 rounded-lg border ${
                          term.isForbidden
                            ? 'bg-red-50 border-red-200'
                            : 'bg-green-50 border-green-200'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-gray-700">
                            {term.sourceTerm}
                          </span>
                          {term.isForbidden && (
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                              FORBIDDEN
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-600">
                          <span className="font-medium">→</span> {term.targetTerm}
                        </div>
                        {term.notes && (
                          <div className="text-xs text-gray-500 mt-1 italic">{term.notes}</div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 italic">No glossary terms found in this segment</p>
                )}
              </div>

              {/* Context */}
              <div>
                <h4 className="font-semibold text-gray-900 mb-2 flex items-center">
                  <span className="text-purple-600 mr-2">🔗</span>
                  Context (Previous/Next Segments)
                </h4>
                <div className="space-y-3">
                  {debugInfo.context.previous ? (
                    <div className="p-3 rounded-lg border bg-purple-50 border-purple-200">
                      <div className="text-xs font-medium text-purple-700 mb-1">
                        Previous Segment #{debugInfo.context.previous.segmentIndex + 1}
                      </div>
                      <div className="text-sm text-gray-700 space-y-1">
                        <div>
                          <span className="font-medium">Source:</span>{' '}
                          <span className="bg-white px-1 rounded">
                            {debugInfo.context.previous.sourceText}
                          </span>
                        </div>
                        {debugInfo.context.previous.targetText && (
                          <div>
                            <span className="font-medium">Target:</span>{' '}
                            <span className="bg-white px-1 rounded">
                              {debugInfo.context.previous.targetText}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 italic">No previous segment</p>
                  )}

                  {debugInfo.context.next ? (
                    <div className="p-3 rounded-lg border bg-purple-50 border-purple-200">
                      <div className="text-xs font-medium text-purple-700 mb-1">
                        Next Segment #{debugInfo.context.next.segmentIndex + 1}
                      </div>
                      <div className="text-sm text-gray-700 space-y-1">
                        <div>
                          <span className="font-medium">Source:</span>{' '}
                          <span className="bg-white px-1 rounded">
                            {debugInfo.context.next.sourceText}
                          </span>
                        </div>
                        {debugInfo.context.next.targetText && (
                          <div>
                            <span className="font-medium">Target:</span>{' '}
                            <span className="bg-white px-1 rounded">
                              {debugInfo.context.next.targetText}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 italic">No next segment</p>
                  )}
                </div>
              </div>

              {/* Final Prompt */}
              <div>
                <h4 className="font-semibold text-gray-900 mb-2 flex items-center">
                  <span className="text-orange-600 mr-2">💬</span>
                  Final Prompt Sent to AI
                </h4>
                <div className="relative">
                  <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-xs font-mono max-h-[400px] overflow-y-auto">
                    {debugInfo.prompt}
                  </pre>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(debugInfo.prompt);
                    }}
                    className="absolute top-2 right-2 px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded transition-colors"
                    title="Copy prompt to clipboard"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Length: {debugInfo.prompt.length} characters
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

