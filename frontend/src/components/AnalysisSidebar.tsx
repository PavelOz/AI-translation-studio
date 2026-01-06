import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { Link } from 'react-router-dom';
import { analysisApi, type AnalysisResults, type AnalysisStatus } from '../api/analysis.api';
import toast from 'react-hot-toast';

interface AnalysisSidebarProps {
  documentId: string;
}

export default function AnalysisSidebar({ documentId }: AnalysisSidebarProps) {
  const queryClient = useQueryClient();
  
  // Glossary mode selection state
  const [glossaryMode, setGlossaryMode] = useState<'fast' | 'deep'>('fast');
  
  // Glossary engine selection state
  const [glossaryEngine, setGlossaryEngine] = useState<'standard' | 'deepseek'>('standard');

  // Track previous status to detect status changes
  const previousStatusRef = useRef<AnalysisStatus | undefined>(undefined);

  // Track if we've seen a completion to ensure we refetch final counts
  const hasSeenCompletionRef = useRef(false);
  
  // Track failed poll count for FAILED status polling
  const failedPollCountRef = useRef(0);
  
  // Fetch analysis status and results
  const { data: analysis, isLoading, error, refetch } = useQuery({
    queryKey: ['analysis', documentId],
    queryFn: async () => {
      try {
        return await analysisApi.getAnalysis(documentId);
      } catch (err: any) {
        // Handle 404 gracefully - it just means analysis hasn't been run yet
        // Return a default PENDING state instead of throwing
        if (err?.response?.status === 404) {
          return {
            status: 'PENDING' as AnalysisStatus,
            glossaryExtracted: false,
            styleRulesExtracted: false,
            completedAt: null,
            glossaryCount: 0,
            styleRulesCount: 0,
            styleRules: [],
            glossaryEntries: [],
            currentStage: null,
            progressPercentage: 0,
            currentMessage: null,
          } as AnalysisResults;
        }
        throw err; // Re-throw other errors
      }
    },
    enabled: !!documentId,
    retry: (failureCount, error: any) => {
      // Don't retry on 404 errors (analysis just hasn't been run)
      if (error?.response?.status === 404) {
        return false;
      }
      // Retry other errors up to 3 times
      return failureCount < 3;
    },
    useErrorBoundary: false, // Don't use error boundary - handle errors manually
    refetchInterval: (data) => {
      try {
        const currentStatus = data?.status;
        
        // Poll every 2 seconds if analysis is running
        // Also poll if data is not yet loaded (might be starting)
        if (currentStatus === 'RUNNING' || !data) {
          hasSeenCompletionRef.current = false;
          failedPollCountRef.current = 0;
          console.log('Polling: RUNNING or no data, will poll in 2s', { currentStatus, hasData: !!data });
          return 2000;
        }
        
        // CRITICAL: Continue polling even if status is FAILED
        // Analysis might continue in background and complete successfully
        // This handles the case where an error occurs mid-process but analysis continues
        if (currentStatus === 'FAILED') {
          failedPollCountRef.current += 1;
          // Continue polling for up to 60 seconds (30 polls) in case analysis recovers
          // This gives enough time for background processing to complete
          if (failedPollCountRef.current > 30) {
            // Stop polling after 60 seconds of FAILED status
            return false;
          }
          return 2000;
        }
        
        // Reset failed poll count when status is not FAILED
        if (currentStatus !== 'FAILED') {
          failedPollCountRef.current = 0;
        }
        
        // If just completed, poll a few more times to get final counts
        if (currentStatus === 'COMPLETED' && !hasSeenCompletionRef.current) {
          hasSeenCompletionRef.current = true;
          failedPollCountRef.current = 0;
          // Poll 3 more times (6 seconds total) to ensure we get final counts
          return 2000;
        }
        // If completed but counts are still 0, keep polling briefly
        if (currentStatus === 'COMPLETED' && hasSeenCompletionRef.current && 
            (data?.glossaryCount === 0 && data?.styleRulesCount === 0)) {
          // Poll a few more times to catch delayed updates
          return 2000;
        }
        // Stop polling otherwise
        return false;
      } catch (error) {
        // If there's an error in refetchInterval, stop polling to prevent infinite loops
        console.error('Error in refetchInterval:', error);
        return false;
      }
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

    // Reset failed poll count when status changes from FAILED to something else
    // Do this BEFORE updating previousStatusRef
    if (previousStatusRef.current === 'FAILED' && currentStatus !== 'FAILED') {
      // Status changed from FAILED to something else - reset counter
      failedPollCountRef.current = 0;
    }
    
    // Update ref for next render
    previousStatusRef.current = currentStatus;
  }, [analysis?.status, analysis?.glossaryCount, analysis?.styleRulesCount, documentId, queryClient, refetch]);

  // Trigger analysis mutation
  const triggerAnalysisMutation = useMutation({
    mutationFn: () => {
      const provider = glossaryEngine === 'deepseek' ? 'deepseek' : undefined;
      const model = glossaryEngine === 'deepseek' ? 'deepseek-reasoner' : undefined;
      return analysisApi.triggerAnalysis(documentId, false, glossaryMode, provider, model);
    },
    onSuccess: () => {
      toast.success('Analysis started! This may take a moment...');
      console.log('Analysis started, invalidating queries and starting polling');
      // Immediately invalidate glossary queries (data is being flushed on backend)
      queryClient.invalidateQueries({ queryKey: ['document-glossary', documentId] }); // GlossaryReviewTable
      queryClient.invalidateQueries({ queryKey: ['glossary', documentId] }); // DocumentGlossary component
      // Immediately invalidate analysis query and start polling
      queryClient.invalidateQueries({ queryKey: ['analysis', documentId] });
      // Start refetching immediately and continue polling
      // Refetch multiple times to ensure we catch the RUNNING status
      setTimeout(() => {
        console.log('First refetch after analysis start');
        void refetch().then((result) => {
          console.log('First refetch result:', { status: result.data?.status, progress: result.data?.progressPercentage });
        });
        // Refetch again after a short delay to ensure status is updated
        setTimeout(() => {
          console.log('Second refetch after analysis start');
          void refetch().then((result) => {
            console.log('Second refetch result:', { status: result.data?.status, progress: result.data?.progressPercentage });
          });
        }, 1000);
      }, 300); // Smaller delay to catch status faster
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
    mutationFn: () => {
      const provider = glossaryEngine === 'deepseek' ? 'deepseek' : undefined;
      const model = glossaryEngine === 'deepseek' ? 'deepseek-reasoner' : undefined;
      return analysisApi.triggerAnalysis(documentId, true, glossaryMode, provider, model);
    },
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

  // Safely get status with fallback
  const status = (analysis?.status || 'PENDING') as AnalysisStatus;
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
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log('Analysis data is null/undefined', { isLoading, error, timestamp: new Date().toISOString() });
    }
  }, [analysis, isLoading, error]);

  // Show error UI for non-404 errors (after all hooks are called to prevent hook ordering issues)
  if (error && !isLoading && (error as any)?.response?.status !== 404) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Document Analysis</h3>
        <div className="text-sm text-red-600">
          Failed to load analysis: {(error as Error).message}
        </div>
        <button
          onClick={() => refetch()}
          className="mt-2 btn btn-secondary text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

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
          <Link
            to={`/documents/${documentId}/monitoring`}
            className="text-xs text-blue-600 hover:text-blue-800 underline font-medium"
            title="Open detailed stage monitoring dashboard"
          >
            📊 Monitor
          </Link>
        </div>
      </div>

      {/* Start View */}
      {!analysis || status === 'PENDING' ? (
        <div className="text-center py-6">
          <p className="text-sm text-gray-600 mb-4">
            Run full document analysis to extract glossary terms and style rules automatically.
          </p>
          
          {/* Glossary Mode Selection */}
          <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <label className="block text-xs font-medium text-gray-700 mb-2">
              Glossary Extraction Mode:
            </label>
            <div className="flex gap-4 justify-center">
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="glossaryMode"
                  value="fast"
                  checked={glossaryMode === 'fast'}
                  onChange={(e) => setGlossaryMode(e.target.value as 'fast' | 'deep')}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">
                  Fast
                  <span className="block text-xs text-gray-500 mt-0.5">Quick extraction</span>
                </span>
              </label>
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="glossaryMode"
                  value="deep"
                  checked={glossaryMode === 'deep'}
                  onChange={(e) => setGlossaryMode(e.target.value as 'fast' | 'deep')}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">
                  Deep
                  <span className="block text-xs text-gray-500 mt-0.5">Thorough analysis</span>
                </span>
              </label>
            </div>
          </div>

          {/* Glossary Engine Selection */}
          <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <label htmlFor="glossary-engine" className="block text-xs font-medium text-gray-700 mb-2">
              Glossary Extraction Engine:
            </label>
            <select
              id="glossary-engine"
              value={glossaryEngine}
              onChange={(e) => setGlossaryEngine(e.target.value as 'standard' | 'deepseek')}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              disabled={isRunning || triggerAnalysisMutation.isPending || forceResetMutation.isPending}
            >
              <option value="standard">⚡ Standard (Gemini/GPT)</option>
              <option value="deepseek">🧠 DeepSeek R1 (Deep Analysis)</option>
            </select>
            {glossaryEngine === 'deepseek' && (
              <p className="text-xs text-gray-500 mt-2 italic">
                Takes longer (1-2 mins) but produces higher precision terms.
              </p>
            )}
          </div>
          
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
                
                // Define stage groups for parallel execution
                // Glossary stages: fetching, frequency_analysis, ai_glossary, parsing_glossary, lookup_glossary, saving_glossary
                // Style stages: fetching (shared), ai_style, saving_style
                const glossaryStages = ['fetching', 'frequency_analysis', 'ai_glossary', 'parsing_glossary', 'lookup_glossary', 'saving_glossary'];
                const styleStages = ['ai_style', 'saving_style'];
                
                // Determine if stage is completed
                // Use glossaryExtracted and styleRulesExtracted flags for accurate completion detection
                let isCompleted = false;
                if (status === 'COMPLETED') {
                  // All stages are completed
                  isCompleted = true;
                } else if (stage === 'completed') {
                  isCompleted = status === 'COMPLETED';
                } else {
                  // Check completion based on stage group and extraction flags
                  if (glossaryStages.includes(stage)) {
                    // Glossary stages are completed if glossaryExtracted is true
                    // OR if we've moved past this stage in the glossary pipeline
                    const stageIndex = glossaryStages.indexOf(stage);
                    const currentIndex = currentStage ? glossaryStages.indexOf(currentStage) : -1;
                    const isInStyleStages = currentStage && styleStages.includes(currentStage);
                    isCompleted = analysis?.glossaryExtracted || 
                      (currentIndex > stageIndex && currentIndex !== -1) || 
                      isInStyleStages;
                  } else if (styleStages.includes(stage)) {
                    // Style stages are completed if styleRulesExtracted is true
                    // OR if we've moved past this stage in the style pipeline
                    const stageIndex = styleStages.indexOf(stage);
                    const currentIndex = currentStage ? styleStages.indexOf(currentStage) : -1;
                    const isInGlossaryStages = currentStage && glossaryStages.includes(currentStage);
                    isCompleted = analysis?.styleRulesExtracted || 
                      (currentIndex > stageIndex && currentIndex !== -1) || 
                      isInGlossaryStages;
                  } else if (stage === 'fetching') {
                    // Fetching is shared - completed if either extraction has started
                    isCompleted = analysis?.glossaryExtracted || analysis?.styleRulesExtracted ||
                      (currentStage && currentStage !== 'fetching' && currentStage !== 'initializing');
                  }
                }
                
                // Check if we're waiting for AI API (indicated by "Waiting for" or "Calling" in message)
                const isWaitingForAI = isActive && 
                  (currentMessage?.toLowerCase().includes('waiting for') || 
                   currentMessage?.toLowerCase().includes('calling') ||
                   currentMessage?.toLowerCase().includes('elapsed') ||
                   (currentMessage?.toLowerCase().includes('this may take') && (stage === 'ai_glossary' || stage === 'ai_style')));
                
                return (
                  <span
                    key={stage}
                    className={`px-2 py-1 rounded text-xs ${
                      isActive
                        ? isWaitingForAI
                          ? 'bg-yellow-100 text-yellow-800 font-medium border-2 border-yellow-400'
                          : 'bg-primary-100 text-primary-800 font-medium'
                        : isCompleted
                        ? 'bg-green-100 text-green-800 line-through'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {isWaitingForAI && (
                      <span className="inline-block animate-pulse mr-1">⏳</span>
                    )}
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
          
          {/* Glossary Mode Selection */}
          <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <label className="block text-xs font-medium text-gray-700 mb-2">
              Glossary Extraction Mode:
            </label>
            <div className="flex gap-4 justify-center">
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="glossaryMode"
                  value="fast"
                  checked={glossaryMode === 'fast'}
                  onChange={(e) => setGlossaryMode(e.target.value as 'fast' | 'deep')}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">
                  Fast
                  <span className="block text-xs text-gray-500 mt-0.5">Quick extraction</span>
                </span>
              </label>
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="glossaryMode"
                  value="deep"
                  checked={glossaryMode === 'deep'}
                  onChange={(e) => setGlossaryMode(e.target.value as 'fast' | 'deep')}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">
                  Deep
                  <span className="block text-xs text-gray-500 mt-0.5">Thorough analysis</span>
                </span>
              </label>
            </div>
          </div>
          
          <button
            onClick={handleStartAnalysis}
            disabled={triggerAnalysisMutation.isPending}
            className="btn btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Start New Analysis
          </button>
        </div>
      ) : status === 'FAILED' ? (
        /* Failed View - but continue checking in case analysis recovers */
        <div className="text-center py-6">
          <div className="text-red-600 mb-4">
            <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm text-gray-700 mb-2">Analysis encountered an error.</p>
          {analysis?.currentMessage && (
            <p className="text-xs text-gray-500 mb-4">{analysis.currentMessage}</p>
          )}
          <p className="text-xs text-gray-500 mb-4">
            Checking if analysis continues in background...
          </p>
          <div className="flex items-center justify-center gap-2 mb-4">
            <div className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-primary-300 border-t-primary-600"></div>
            <span className="text-xs text-gray-500">Monitoring...</span>
          </div>
          
          {/* Glossary Mode Selection */}
          <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <label className="block text-xs font-medium text-gray-700 mb-2">
              Glossary Extraction Mode:
            </label>
            <div className="flex gap-4 justify-center">
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="glossaryMode"
                  value="fast"
                  checked={glossaryMode === 'fast'}
                  onChange={(e) => setGlossaryMode(e.target.value as 'fast' | 'deep')}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">
                  Fast
                  <span className="block text-xs text-gray-500 mt-0.5">Quick extraction</span>
                </span>
              </label>
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="glossaryMode"
                  value="deep"
                  checked={glossaryMode === 'deep'}
                  onChange={(e) => setGlossaryMode(e.target.value as 'fast' | 'deep')}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">
                  Deep
                  <span className="block text-xs text-gray-500 mt-0.5">Thorough analysis</span>
                </span>
              </label>
            </div>
          </div>
          
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
              <div className="text-2xl font-bold text-blue-900">{analysis?.glossaryCount ?? 0}</div>
              {(analysis?.approvedCount !== undefined || analysis?.candidateCount !== undefined) && (
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
              <div className="text-2xl font-bold text-purple-900">{analysis?.styleRulesCount ?? 0}</div>
            </div>
          </div>

          {/* Style Rules Section */}
          {analysis.styleRulesCount > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-2">Style Rules</h4>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {analysis.styleRules.map((rule, index) => (
                  <div
                    key={rule?.id || `rule-${index}`}
                    className="border border-gray-200 rounded-lg p-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-1">
                      <div className="flex-1">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                          {rule?.ruleType ? rule.ruleType.replace(/_/g, ' ') : 'Unknown'}
                        </div>
                        <div className="text-sm font-semibold text-gray-900 mt-1">
                          {rule?.pattern || 'N/A'}
                        </div>
                      </div>
                      {rule?.priority && rule.priority > 50 && (
                        <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">
                          High Priority
                        </span>
                      )}
                    </div>
                    {rule?.description && (
                      <p className="text-xs text-gray-600 mt-2">{rule.description}</p>
                    )}
                    {rule?.examples && Array.isArray(rule.examples) && rule.examples.length > 0 && (
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
          {analysis && (analysis.styleRulesCount ?? 0) === 0 && analysis.styleRulesExtracted && (
            <div className="text-center py-4 text-sm text-gray-500">
              No style rules detected in this document.
            </div>
          )}

          {/* Glossary Mode Selection */}
          <div className="pt-2 border-t border-gray-200">
            <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <label className="block text-xs font-medium text-gray-700 mb-2">
                Glossary Extraction Mode:
              </label>
              <div className="flex gap-4 justify-center">
                <label className="flex items-center cursor-pointer">
                  <input
                    type="radio"
                    name="glossaryMode"
                    value="fast"
                    checked={glossaryMode === 'fast'}
                    onChange={(e) => setGlossaryMode(e.target.value as 'fast' | 'deep')}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700">
                    Fast
                    <span className="block text-xs text-gray-500 mt-0.5">Quick extraction</span>
                  </span>
                </label>
                <label className="flex items-center cursor-pointer">
                  <input
                    type="radio"
                    name="glossaryMode"
                    value="deep"
                    checked={glossaryMode === 'deep'}
                    onChange={(e) => setGlossaryMode(e.target.value as 'fast' | 'deep')}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700">
                    Deep
                    <span className="block text-xs text-gray-500 mt-0.5">Thorough analysis</span>
                  </span>
                </label>
              </div>
            </div>
          </div>

          {/* Glossary Engine Selection */}
          <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <label htmlFor="glossary-engine-completed" className="block text-xs font-medium text-gray-700 mb-2">
              Glossary Extraction Engine:
            </label>
            <select
              id="glossary-engine-completed"
              value={glossaryEngine}
              onChange={(e) => setGlossaryEngine(e.target.value as 'standard' | 'deepseek')}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              disabled={isRunning || triggerAnalysisMutation.isPending || forceResetMutation.isPending}
            >
              <option value="standard">⚡ Standard (Gemini/GPT)</option>
              <option value="deepseek">🧠 DeepSeek R1 (Deep Analysis)</option>
            </select>
            {glossaryEngine === 'deepseek' && (
              <p className="text-xs text-gray-500 mt-2 italic">
                Takes longer (1-2 mins) but produces higher precision terms.
              </p>
            )}
          </div>

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

