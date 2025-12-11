import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { analysisApi, type AnalysisResults, type AnalysisStatus } from '../api/analysis.api';
import toast from 'react-hot-toast';

interface AnalysisSidebarProps {
  documentId: string;
}

export default function AnalysisSidebar({ documentId }: AnalysisSidebarProps) {
  const queryClient = useQueryClient();

  // Track previous status to detect status changes
  const previousStatusRef = useRef<AnalysisStatus | undefined>(undefined);

  // Track if we've seen a completion to ensure we refetch final counts
  const hasSeenCompletionRef = useRef(false);
  
  // Fetch analysis status and results
  const { data: analysis, isLoading, error, refetch } = useQuery({
    queryKey: ['analysis', documentId],
    queryFn: () => analysisApi.getAnalysis(documentId),
    enabled: !!documentId,
    refetchInterval: (data) => {
      // Poll every 2 seconds if analysis is running
      if (data?.status === 'RUNNING') {
        hasSeenCompletionRef.current = false;
        return 2000;
      }
      // If just completed, poll a few more times to get final counts
      if (data?.status === 'COMPLETED' && !hasSeenCompletionRef.current) {
        hasSeenCompletionRef.current = true;
        // Poll 3 more times (6 seconds total) to ensure we get final counts
        return 2000;
      }
      // If completed but counts are still 0, keep polling briefly
      if (data?.status === 'COMPLETED' && hasSeenCompletionRef.current && 
          (data?.glossaryCount === 0 && data?.styleRulesCount === 0)) {
        // Poll a few more times to catch delayed updates
        return 2000;
      }
      // Stop polling otherwise
      return false;
    },
    // Refetch on window focus to ensure data is fresh
    refetchOnWindowFocus: true,
    // Refetch on mount to ensure we have latest data
    refetchOnMount: true,
    // Use staleTime of 0 to always fetch fresh data
    staleTime: 0,
  });

  // Invalidate glossary query when analysis status changes
  useEffect(() => {
    const currentStatus = analysis?.status;
    const previousStatus = previousStatusRef.current;

    // If status changed to RUNNING, invalidate glossary immediately (data is being flushed)
    if (previousStatus !== 'RUNNING' && currentStatus === 'RUNNING') {
      queryClient.invalidateQueries({ queryKey: ['document-glossary', documentId] }); // GlossaryReviewTable
      queryClient.invalidateQueries({ queryKey: ['glossary', documentId] }); // DocumentGlossary component
      queryClient.invalidateQueries({ queryKey: ['analysis', documentId] });
    }

    // If status changed from RUNNING to COMPLETED, invalidate all related queries (new data is ready)
    if (previousStatus === 'RUNNING' && currentStatus === 'COMPLETED') {
      // Force a refresh of all glossary-related data
      void queryClient.invalidateQueries({ queryKey: ['document-glossary', documentId] }); // GlossaryReviewTable
      void queryClient.invalidateQueries({ queryKey: ['glossary', documentId] }); // DocumentGlossary component
      void queryClient.invalidateQueries({ queryKey: ['documents', documentId] }); // Document metadata
      void queryClient.invalidateQueries({ queryKey: ['analysis', documentId] }); // Refresh self to get final counts
      
      // Immediately refetch analysis to get final counts
      void refetch();
      
      // Also trigger refetches for related queries with a small delay to ensure backend has finalized
      setTimeout(() => {
        void queryClient.refetchQueries({ queryKey: ['document-glossary', documentId] });
        void queryClient.refetchQueries({ queryKey: ['glossary', documentId] });
        void queryClient.refetchQueries({ queryKey: ['analysis', documentId] });
        // Refetch again after a bit more time to catch any delayed updates
        setTimeout(() => {
          void refetch();
        }, 1000);
      }, 500);
    }
    
    // If status is COMPLETED but counts are still 0, keep refetching periodically
    if (currentStatus === 'COMPLETED' && analysis && (analysis.glossaryCount === 0 && analysis.styleRulesCount === 0)) {
      // This might be a stale completion - refetch to get actual counts
      setTimeout(() => {
        void refetch();
      }, 2000);
    }

    // Update ref for next render
    previousStatusRef.current = currentStatus;
  }, [analysis?.status, analysis?.glossaryCount, analysis?.styleRulesCount, documentId, queryClient, refetch]);

  // Trigger analysis mutation
  const triggerAnalysisMutation = useMutation({
    mutationFn: () => analysisApi.triggerAnalysis(documentId),
    onSuccess: () => {
      toast.success('Analysis started! This may take a moment...');
      // Immediately invalidate glossary queries (data is being flushed on backend)
      queryClient.invalidateQueries({ queryKey: ['document-glossary', documentId] }); // GlossaryReviewTable
      queryClient.invalidateQueries({ queryKey: ['glossary', documentId] }); // DocumentGlossary component
      // Immediately invalidate analysis query and start polling
      queryClient.invalidateQueries({ queryKey: ['analysis', documentId] });
      // Start refetching immediately and continue polling
      setTimeout(() => refetch(), 500); // Small delay to let backend set status
    },
    onError: (error: any) => {
      toast.error(`Failed to start analysis: ${error.response?.data?.message || error.message || 'Unknown error'}`);
    },
  });

  const handleStartAnalysis = () => {
    triggerAnalysisMutation.mutate();
  };

  // Force reset mutation (wipes all data and re-runs analysis)
  const forceResetMutation = useMutation({
    mutationFn: () => analysisApi.triggerAnalysis(documentId, true),
    onSuccess: () => {
      toast.success('Force reset analysis started! All existing data will be cleared...');
      // Immediately invalidate glossary queries (data is being flushed on backend)
      queryClient.invalidateQueries({ queryKey: ['document-glossary', documentId] });
      queryClient.invalidateQueries({ queryKey: ['glossary', documentId] });
      // Immediately invalidate analysis query and start polling
      queryClient.invalidateQueries({ queryKey: ['analysis', documentId] });
      // Start refetching immediately and continue polling
      setTimeout(() => {
        void refetch();
        // Keep refetching every 2 seconds while running
        const pollInterval = setInterval(() => {
          refetch().then((result) => {
            // Stop polling if status is no longer RUNNING
            if (result.data?.status !== 'RUNNING') {
              clearInterval(pollInterval);
              // One final refetch after completion to get final counts
              if (result.data?.status === 'COMPLETED') {
                setTimeout(() => {
                  void refetch();
                }, 1000);
              }
            }
          });
        }, 2000);
      }, 500);
    },
    onError: (error: any) => {
      toast.error(`Failed to start force reset analysis: ${error.response?.data?.message || error.message || 'Unknown error'}`);
    },
  });

  const handleForceReset = () => {
    if (window.confirm('⚠️ WARNING: This will delete ALL current glossary terms and style rules for this document.\n\nAre you sure you want to proceed with a complete reset?')) {
      forceResetMutation.mutate();
    }
  };

  // Cancel analysis mutation
  const cancelAnalysisMutation = useMutation({
    mutationFn: () => analysisApi.cancelAnalysis(documentId),
    onSuccess: () => {
      toast.success('Analysis cancellation requested');
      // Immediately invalidate to refresh status
      queryClient.invalidateQueries({ queryKey: ['analysis', documentId] });
    },
    onError: (error: any) => {
      toast.error(`Failed to cancel analysis: ${error.response?.data?.message || error.message || 'Unknown error'}`);
    },
  });

  const handleCancelAnalysis = () => {
    cancelAnalysisMutation.mutate();
  };

  // Reset analysis mutation (for manual fixes)
  const resetAnalysisMutation = useMutation({
    mutationFn: () => analysisApi.resetAnalysis(documentId),
    onSuccess: () => {
      toast.success('Analysis status reset successfully');
      queryClient.invalidateQueries({ queryKey: ['analysis', documentId] });
    },
    onError: (error: any) => {
      toast.error(`Failed to reset analysis: ${error.response?.data?.message || error.message || 'Unknown error'}`);
    },
  });

  const handleResetAnalysis = () => {
    if (confirm('Are you sure you want to reset the analysis status? This will clear the current state.')) {
      resetAnalysisMutation.mutate();
    }
  };

  const getStatusColor = (status: AnalysisStatus) => {
    switch (status) {
      case 'COMPLETED':
        return 'text-green-600 bg-green-50';
      case 'RUNNING':
        return 'text-blue-600 bg-blue-50';
      case 'FAILED':
        return 'text-red-600 bg-red-50';
      case 'CANCELLED':
        return 'text-orange-600 bg-orange-50';
      case 'PENDING':
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  const getStatusIcon = (status: AnalysisStatus) => {
    switch (status) {
      case 'COMPLETED':
        return '✓';
      case 'RUNNING':
        return (
          <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent"></span>
        );
      case 'FAILED':
        return '✗';
      case 'CANCELLED':
        return '⊘';
      case 'PENDING':
      default:
        return '○';
    }
  };

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Document Analysis</h3>
        <div className="text-sm text-red-600">
          Failed to load analysis: {(error as Error).message}
        </div>
      </div>
    );
  }

  const status = analysis?.status || 'PENDING';
  // Show running state if: status is RUNNING, or mutation is pending (button just clicked)
  const isRunning = status === 'RUNNING' || triggerAnalysisMutation.isPending || forceResetMutation.isPending;
  // Get progress values from analysis data, with fallbacks
  // CRITICAL: Never show 0% when running - always show at least 1% to indicate activity
  const progressPercentage = isRunning 
    ? Math.max(1, analysis?.progressPercentage ?? 1) // At least 1% when running
    : (status === 'COMPLETED' ? 100 : (analysis?.progressPercentage ?? 0));
  const currentMessage = analysis?.currentMessage || (isRunning ? 'Initializing analysis...' : (status === 'COMPLETED' ? 'Analysis completed' : 'Analyzing document...'));
  const currentStage = analysis?.currentStage;
  
  // Debug: Log when analysis data changes to help diagnose update issues
  useEffect(() => {
    if (analysis) {
      console.log('Analysis data updated:', {
        status: analysis.status,
        progressPercentage: analysis.progressPercentage,
        glossaryCount: analysis.glossaryCount,
        styleRulesCount: analysis.styleRulesCount,
        currentMessage: analysis.currentMessage,
        currentStage: analysis.currentStage,
      });
    }
  }, [analysis]);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Document Analysis</h3>
        <div className="flex items-center gap-2">
          {analysis && status !== 'PENDING' && (
            <span className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 ${getStatusColor(status)}`}>
              {getStatusIcon(status)}
              {status}
            </span>
          )}
          {analysis && (status === 'RUNNING' || status === 'FAILED' || status === 'CANCELLED') && (
            <button
              onClick={handleResetAnalysis}
              disabled={resetAnalysisMutation.isPending}
              className="text-xs text-gray-600 hover:text-gray-800 underline disabled:opacity-50 disabled:cursor-not-allowed"
              title="Reset analysis status (useful if stuck)"
            >
              {resetAnalysisMutation.isPending ? 'Resetting...' : 'Reset'}
            </button>
          )}
        </div>
      </div>

      {/* Start View */}
      {!analysis || status === 'PENDING' ? (
        <div className="text-center py-6">
          <p className="text-sm text-gray-600 mb-4">
            Run full document analysis to extract glossary terms and style rules automatically.
          </p>
          <button
            onClick={handleStartAnalysis}
            disabled={isRunning || forceResetMutation.isPending}
            className="btn btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? (
              <>
                <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2"></span>
                Starting...
              </>
            ) : (
              'Start Full Analysis'
            )}
          </button>
          <div className="mt-3">
            <button
              onClick={handleForceReset}
              disabled={isRunning || forceResetMutation.isPending}
              className="text-xs text-gray-500 hover:text-red-600 underline disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Delete all existing terms and style rules, then re-analyze from scratch"
            >
              {forceResetMutation.isPending ? 'Resetting...' : 'Reset & Re-analyze'}
            </button>
          </div>
        </div>
      ) : isRunning ? (
        /* Loading View with Progress Bar */
        <div className="py-6">
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">
                {currentMessage}
              </span>
              <span className="text-sm text-gray-500 font-semibold">
                {progressPercentage}%
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden shadow-inner">
              <div
                className="bg-gradient-to-r from-primary-500 to-primary-600 h-3 rounded-full transition-all duration-500 ease-out flex items-center justify-end pr-2"
                style={{ 
                  width: `${Math.max(progressPercentage, 2)}%`,
                  minWidth: progressPercentage > 0 ? '2%' : '0%',
                }}
              >
                {progressPercentage >= 1 && (
                  <span className="text-xs text-white font-semibold drop-shadow-sm">{progressPercentage}%</span>
                )}
              </div>
            </div>
          </div>
          
          {/* Stage Indicators */}
          <div className="mt-4 space-y-2">
            <div className="text-xs font-medium text-gray-600 mb-2">
              {currentStage ? 'Current Stage:' : 'Stages:'}
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                { stage: 'fetching', label: 'Fetching Data' },
                { stage: 'frequency_analysis', label: 'Frequency Analysis' },
                { stage: 'ai_glossary', label: 'AI Glossary Extraction' },
                { stage: 'parsing_glossary', label: 'Parsing Glossary' },
                { stage: 'lookup_glossary', label: 'Looking Up Terms' },
                { stage: 'saving_glossary', label: 'Saving Glossary' },
                { stage: 'ai_style', label: 'AI Style Extraction' },
                { stage: 'saving_style', label: 'Saving Style Rules' },
                { stage: 'completed', label: 'Completed' },
              ].map(({ stage, label }) => {
                const isActive = currentStage === stage;
                const isCompleted = progressPercentage === 100 || 
                  (stage === 'completed' && status === 'COMPLETED');
                return (
                  <span
                    key={stage}
                    className={`px-2 py-1 rounded text-xs ${
                      isActive
                        ? 'bg-primary-100 text-primary-800 font-medium'
                        : isCompleted
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {label}
                  </span>
                );
              })}
            </div>
          </div>
          
          <div className="mt-4 text-center">
            <div className="inline-block animate-spin rounded-full h-6 w-6 border-2 border-primary-300 border-t-primary-600"></div>
            <p className="text-xs text-gray-500 mt-2">Processing in background...</p>
            <button
              onClick={handleCancelAnalysis}
              disabled={cancelAnalysisMutation.isPending}
              className="mt-4 btn btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cancelAnalysisMutation.isPending ? 'Cancelling...' : 'Cancel Analysis'}
            </button>
          </div>
        </div>
      ) : status === 'CANCELLED' ? (
        /* Cancelled View */
        <div className="text-center py-6">
          <div className="text-orange-600 mb-4">
            <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <p className="text-sm text-gray-700 mb-4">Analysis was cancelled.</p>
          <button
            onClick={handleStartAnalysis}
            disabled={triggerAnalysisMutation.isPending}
            className="btn btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Start New Analysis
          </button>
        </div>
      ) : status === 'FAILED' ? (
        /* Failed View */
        <div className="text-center py-6">
          <div className="text-red-600 mb-4">
            <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm text-gray-700 mb-4">Analysis failed. Please try again.</p>
          <button
            onClick={handleStartAnalysis}
            disabled={isRunning}
            className="btn btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Retry Analysis
          </button>
        </div>
      ) : (
        /* Results View */
        <div className="space-y-4">
          {/* Summary Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-blue-50 rounded-lg p-3">
              <div className="text-xs text-blue-600 font-medium mb-1">Glossary Terms</div>
              <div className="text-2xl font-bold text-blue-900">{analysis.glossaryCount}</div>
              {(analysis.approvedCount !== undefined || analysis.candidateCount !== undefined) && (
                <div className="text-xs text-blue-600 mt-1 space-y-0.5">
                  <div className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500"></span>
                    <span>{analysis.approvedCount ?? 0} approved</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-yellow-500"></span>
                    <span>{analysis.candidateCount ?? 0} candidate</span>
                  </div>
                </div>
              )}
            </div>
            <div className="bg-purple-50 rounded-lg p-3">
              <div className="text-xs text-purple-600 font-medium mb-1">Style Rules</div>
              <div className="text-2xl font-bold text-purple-900">{analysis.styleRulesCount}</div>
            </div>
          </div>

          {/* Style Rules Section */}
          {analysis.styleRulesCount > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-2">Style Rules</h4>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {analysis.styleRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="border border-gray-200 rounded-lg p-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-1">
                      <div className="flex-1">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                          {rule.ruleType.replace(/_/g, ' ')}
                        </div>
                        <div className="text-sm font-semibold text-gray-900 mt-1">
                          {rule.pattern}
                        </div>
                      </div>
                      {rule.priority > 50 && (
                        <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">
                          High Priority
                        </span>
                      )}
                    </div>
                    {rule.description && (
                      <p className="text-xs text-gray-600 mt-2">{rule.description}</p>
                    )}
                    {rule.examples && Array.isArray(rule.examples) && rule.examples.length > 0 && (
                      <div className="mt-2">
                        <div className="text-xs font-medium text-gray-500 mb-1">Examples:</div>
                        <div className="flex flex-wrap gap-1">
                          {rule.examples.map((example: string, idx: number) => (
                            <span
                              key={idx}
                              className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded"
                            >
                              {example}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty State for Style Rules */}
          {analysis.styleRulesCount === 0 && analysis.styleRulesExtracted && (
            <div className="text-center py-4 text-sm text-gray-500">
              No style rules detected in this document.
            </div>
          )}

          {/* Action Button */}
          <div className="pt-2 border-t border-gray-200">
            <button
              onClick={handleStartAnalysis}
              disabled={isRunning}
              className="btn btn-secondary w-full text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRunning ? (
                <>
                  <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2"></span>
                  Running...
                </>
              ) : (
                'Re-run Analysis'
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

