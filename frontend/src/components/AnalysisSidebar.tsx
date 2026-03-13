import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { Link } from 'react-router-dom';
import { analysisApi, type AnalysisResults, type AnalysisStatus, type DocumentDnaPayload, type UpdateDocumentDnaResponse } from '../api/analysis.api';
import { documentsApi } from '../api/documents.api';
import { glossaryApi } from '../api/glossary.api';
import { aiApi } from '../api/ai.api';
import apiClient from '../api/client';
import toast from 'react-hot-toast';
import { DocumentDnaEditor } from './DocumentDnaEditor';
import DnaValidationPanel from './DnaValidationPanel';

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

  const handleExportTmx = async () => {
    try {
      const { blob, filename } = await documentsApi.downloadTmx(documentId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename ?? 'translation-memory.tmx';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success('TMX file downloaded');
    } catch (error: any) {
      toast.error(error.response?.data?.message || error.message || 'Failed to export TMX');
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
          <button
            type="button"
            onClick={handleExportTmx}
            className="text-xs text-blue-600 hover:text-blue-800 underline font-medium"
            title="Export translation memory (TMX) for Trados"
          >
            Export TMX
          </button>
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

      {/* Document DNA (Project Knowledge Base) */}
      <DocumentDnaBlock documentId={documentId} />
    </div>
  );
}

type DiffKind = 'unchanged' | 'filled' | 'changed';

function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isNullish(a) && isNullish(b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function getDiffKind(draft: unknown, refined: unknown): DiffKind {
  if (valueEqual(draft, refined)) return 'unchanged';
  if (isNullish(draft) && !isNullish(refined)) return 'filled';
  if (!isNullish(draft) && !isNullish(refined)) return 'changed';
  return 'unchanged';
}

function DnaJsonWithDiff({
  draft,
  refined,
  label,
}: {
  draft: Record<string, unknown> | null | undefined;
  refined: Record<string, unknown> | null | undefined;
  label: string;
}) {
  const draftObj = draft ?? {};
  const refinedObj = refined ?? {};
  const keys = new Set([...Object.keys(draftObj), ...Object.keys(refinedObj)]);
  if (keys.size === 0) return null;
  return (
    <details className="border border-gray-200 rounded p-2">
      <summary className="text-xs font-medium cursor-pointer">{label}</summary>
      <div className="grid grid-cols-2 gap-2 mt-1 text-xs font-mono">
        <div className="overflow-auto max-h-40">
          <div className="text-gray-500 mb-1">Draft DNA</div>
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(draftObj || null, null, 2)}</pre>
        </div>
        <div className="overflow-auto max-h-40">
          <div className="text-gray-500 mb-1">Refined DNA</div>
          <pre className="whitespace-pre-wrap break-all">
            {Array.from(keys).map((k) => {
              const v = refinedObj[k];
              const d = draftObj[k];
              const kind = getDiffKind(d, v);
              const cls =
                kind === 'filled'
                  ? 'bg-green-100 text-green-900 rounded px-0.5'
                  : kind === 'changed'
                    ? 'bg-blue-100 text-blue-900 rounded px-0.5'
                    : '';
              const str = typeof v === 'object' && v !== null ? JSON.stringify(v, null, 2) : JSON.stringify(v);
              return (
                <span key={k} className={cls ? `block ${cls}` : undefined}>
                  {`"${k}": `}
                  {typeof v === 'object' && v !== null ? '\n' : ''}
                  {str}
                  {'\n'}
                </span>
              );
            })}
          </pre>
        </div>
      </div>
    </details>
  );
}

function DnaDiffView({
  draft,
  refined,
}: {
  draft: DocumentDnaPayload;
  refined: DocumentDnaPayload;
}) {
  const sections = [
    { key: 'technicalSchema' as const, label: 'Technical schema' },
    { key: 'namingConventions' as const, label: 'Naming conventions' },
    { key: 'abbreviationLogic' as const, label: 'Abbreviations' },
    { key: 'entityGroups' as const, label: 'Entity groups' },
  ];
  return (
    <div className="space-y-2">
      {sections.map(({ key, label }) => (
        <DnaJsonWithDiff
          key={key}
          label={label}
          draft={(draft[key] as Record<string, unknown>) ?? undefined}
          refined={(refined[key] as Record<string, unknown>) ?? undefined}
        />
      ))}
      <p className="text-xs text-gray-500 mt-1">
        <span className="inline-block w-3 h-3 rounded bg-green-100 align-middle mr-1" /> New (was null)
        {' · '}
        <span className="inline-block w-3 h-3 rounded bg-blue-100 align-middle mr-1" /> Refined term
      </p>
    </div>
  );
}

function DocumentDnaBlock({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient();
  const [editingMode, setEditingMode] = useState<null | 'json' | 'form'>(null);
  const [dnaDraft, setDnaDraft] = useState<DocumentDnaPayload | null>(null);
  const [editJson, setEditJson] = useState('');
  const [comparisonMode, setComparisonMode] = useState(false);
  const [draftDna, setDraftDna] = useState<DocumentDnaPayload | null>(null);
  const [refinedDna, setRefinedDna] = useState<DocumentDnaPayload | null>(null);
  const [lastSaveAffected, setLastSaveAffected] = useState<{ affectedCount: number; affectedSegmentIds: string[] } | null>(null);
  const [patchProgress, setPatchProgress] = useState<{
    status: 'running' | 'completed' | 'cancelled' | 'error';
    currentSegment: number;
    totalSegments: number;
    aiApplied: number;
    error?: string;
  } | null>(null);
  const patchPollRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch document to get projectId
  const { data: document } = useQuery(
    ['document', documentId],
    () => documentsApi.get(documentId),
    { enabled: !!documentId, staleTime: 60000 }
  );

  // Fetch AI settings to get model name
  const { data: aiSettings } = useQuery(
    ['ai-settings', document?.projectId],
    () => (document?.projectId ? aiApi.getAISettings(document.projectId) : null),
    { enabled: !!document?.projectId, staleTime: 60000 }
  );

  const { data: dna, isLoading: dnaLoading, refetch: refetchDna } = useQuery({
    queryKey: ['document-dna', documentId],
    queryFn: () => analysisApi.getDocumentDna(documentId),
    enabled: !!documentId,
    retry: false,
    // Force refetch to get fresh data
    staleTime: 0,
    cacheTime: 0,
  });

  // Update editJson when dna changes and we're in JSON editing mode
  useEffect(() => {
    if (editingMode === 'json' && dna) {
      setEditJson(JSON.stringify(dna, null, 2));
    }
  }, [dna, editingMode]);

  const regenerateMutation = useMutation({
    mutationFn: () => analysisApi.regenerateDocumentDna(documentId),
    onSuccess: async (newDna) => {
      toast.success('Document DNA regenerated');
      // If in JSON editing mode, update editJson with new data immediately
      if (editingMode === 'json' && newDna) {
        setEditJson(JSON.stringify(newDna, null, 2));
      }
      // If in form editing mode, update dnaDraft
      if (editingMode === 'form' && newDna) {
        setDnaDraft(newDna);
      }
      // Invalidate queries first
      queryClient.invalidateQueries({ queryKey: ['document-dna', documentId] });
      queryClient.invalidateQueries({ queryKey: ['dna-validation', documentId] });
      // Remove from cache to force fresh fetch
      queryClient.removeQueries({ queryKey: ['document-dna', documentId] });
      // Refetch to get the latest data from server
      const result = await refetchDna();
      // Use data from refetch (most up-to-date) or fallback to mutation response
      const updatedDna = result.data || newDna;
      // If in JSON editing mode, update editJson with new data
      if (editingMode === 'json' && updatedDna) {
        setEditJson(JSON.stringify(updatedDna, null, 2));
      }
      // If in form editing mode, update dnaDraft
      if (editingMode === 'form' && updatedDna) {
        setDnaDraft(updatedDna);
      }
    },
    onError: (err: any) => {
      const errorMessage = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Failed to regenerate Document DNA';
      const status = err?.response?.status;
      
      // Show more detailed error messages based on status code
      if (status === 400) {
        toast.error(`Invalid request: ${errorMessage}`, { duration: 8000 });
      } else if (status === 401 || status === 403) {
        toast.error(`Authentication error: ${errorMessage}. Please check your AI provider settings.`, { duration: 8000 });
      } else if (status === 429) {
        toast.error(`Rate limit exceeded: ${errorMessage}. Please wait a moment and try again.`, { duration: 8000 });
      } else if (status === 413 || errorMessage.includes('too large') || errorMessage.includes('context length')) {
        toast.error(`Document too large: ${errorMessage}. Try using a model with a larger context window (e.g., Gemini 1.5 Pro).`, { duration: 10000 });
      } else {
        toast.error(errorMessage, { duration: 8000 });
      }
    },
  });

  const refineMutation = useMutation({
    mutationFn: () => analysisApi.refineDocumentDna(documentId, { preview: true }),
    onSuccess: (refined) => {
      setDraftDna(dna ?? null);
      setRefinedDna(refined);
      setComparisonMode(true);
      toast.success('Refined DNA ready for comparison');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to refine DNA');
    },
  });

  const extractGlossaryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<{
        added: number;
        entries: Array<{ sourceTerm: string; targetTerm: string }>;
      }>(`/documents/${documentId}/extract-glossary`);
      return res.data;
    },
    onSuccess: (data) => {
      const added = data?.added ?? 0;
      toast.success(`Glossary extracted: ${added} term${added === 1 ? '' : 's'} added`);
      queryClient.invalidateQueries({ queryKey: ['glossary', documentId] });
      queryClient.invalidateQueries({ queryKey: ['document-glossary', documentId] });
      queryClient.invalidateQueries({ queryKey: ['analysis', documentId] });
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        err?.message ||
        'Failed to extract glossary';
      toast.error(msg, { duration: 8000 });
    },
  });

  const clearGlossaryMutation = useMutation({
    mutationFn: () => glossaryApi.clearDocumentGlossary(documentId),
    onSuccess: (data) => {
      const n = data?.deleted ?? 0;
      toast.success(n > 0 ? `Glossary cleared (${n} term${n === 1 ? '' : 's'} removed)` : 'Glossary cleared');
      queryClient.invalidateQueries({ queryKey: ['glossary', documentId] });
      queryClient.invalidateQueries({ queryKey: ['document-glossary', documentId] });
      queryClient.invalidateQueries({ queryKey: ['analysis', documentId] });
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to clear glossary');
    },
  });

  const saveMutation = useMutation({
    mutationFn: (payload: DocumentDnaPayload) => analysisApi.updateDocumentDna(documentId, payload),
    onSuccess: (data: UpdateDocumentDnaResponse) => {
      toast.success('Document DNA saved');
      setEditingMode(null);
      setDnaDraft(null);
      setComparisonMode(false);
      setRefinedDna(null);
      setDraftDna(null);
      const count = data.affectedCount ?? 0;
      const ids = data.affectedSegmentIds ?? [];
      if (count > 0 && ids.length > 0) {
        setLastSaveAffected({ affectedCount: count, affectedSegmentIds: ids });
      } else {
        setLastSaveAffected(null);
      }
      queryClient.invalidateQueries({ queryKey: ['document-dna', documentId] });
      queryClient.invalidateQueries({ queryKey: ['dna-validation', documentId] });
      refetchDna();
    },
    onError: (err: any) => {
      const data = err?.response?.data;
      const msg = data?.error || data?.message || err?.message || 'Failed to save';
      const details = Array.isArray(data?.details) ? data.details.join('; ') : data?.details;
      toast.error(details ? `${msg}: ${details}` : msg);
    },
  });

  const [enrichmentModalOpen, setEnrichmentModalOpen] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [useLLM, setUseLLM] = useState(true);
  const [llmProvider, setLlmProvider] = useState<'gemini' | 'openai' | 'yandex' | 'deepseek'>('gemini');
  const [enrichmentProgress, setEnrichmentProgress] = useState<{ current: number; total: number } | null>(null);

  const enrichMutation = useMutation({
    mutationFn: () => {
      if (!csvFile) throw new Error('CSV file is required');
      return analysisApi.enrichDocumentDnaFromCSV(documentId, csvFile, { useLLM, llmProvider });
    },
    onSuccess: async (data) => {
      const added = data?.statistics?.added ?? 0;
      toast.success(`DNA enriched: ${added} entries added`);
      setEnrichmentModalOpen(false);
      setCsvFile(null);
      setEnrichmentProgress(null);
      // Invalidate and remove from cache to force fresh fetch
      queryClient.invalidateQueries({ queryKey: ['document-dna', documentId] });
      queryClient.invalidateQueries({ queryKey: ['dna-validation', documentId] });
      queryClient.removeQueries({ queryKey: ['document-dna', documentId] });
      // Wait for refetch to complete
      const result = await refetchDna();
      // Update editJson if in JSON editing mode
      if (editingMode === 'json' && result.data) {
        setEditJson(JSON.stringify(result.data, null, 2));
      }
      // Update dnaDraft if in form editing mode
      if (editingMode === 'form' && result.data) {
        setDnaDraft(result.data);
      }
    },
    onError: (err: any) => {
      const errorMessage = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Failed to enrich DNA';
      const status = err?.response?.status;
      
      // Show more detailed error messages based on status code
      if (status === 400) {
        toast.error(`Invalid request: ${errorMessage}`, { duration: 8000 });
      } else if (status === 401 || status === 403) {
        toast.error(`Authentication error: ${errorMessage}. Please check your AI provider settings.`, { duration: 8000 });
      } else if (status === 429) {
        toast.error(`Rate limit exceeded: ${errorMessage}. Please wait a moment and try again.`, { duration: 8000 });
      } else {
        toast.error(errorMessage, { duration: 8000 });
      }
      setEnrichmentProgress(null);
    },
  });

  const handleStartEditJson = () => {
    setEditJson(JSON.stringify(dna ?? {}, null, 2));
    setEditingMode('json');
  };
  const handleStartEditForm = () => {
    setDnaDraft(dna ?? {});
    setEditingMode('form');
  };

  const handleSaveEdit = () => {
    try {
      const parsed = JSON.parse(editJson) as DocumentDnaPayload;
      saveMutation.mutate(parsed);
    } catch {
      toast.error('Invalid JSON');
    }
  };

  const handleAcceptRefinement = () => {
    if (refinedDna) saveMutation.mutate(refinedDna);
  };

  const handleRetranslateAffected = async () => {
    if (!lastSaveAffected?.affectedSegmentIds?.length) return;
    setPatchProgress({ status: 'running', currentSegment: 0, totalSegments: lastSaveAffected.affectedCount, aiApplied: 0 });
    try {
      await documentsApi.patchTranslate(documentId, lastSaveAffected.affectedSegmentIds);
    } catch (err: any) {
      setPatchProgress((p) => (p ? { ...p, status: 'error' as const, error: err?.response?.data?.message || err?.message || 'Failed to start' } : null));
      toast.error(err?.response?.data?.message || err?.message || 'Failed to start retranslation');
      return;
    }
  };

  useEffect(() => {
    if (patchProgress?.status !== 'running') return;
    
    let isCancelled = false;
    
    const poll = async () => {
      if (isCancelled) return;
      
      try {
        const p = await documentsApi.getPretranslateProgress(documentId);
        
        // Stop polling if status is completed, error, or cancelled
        if (p.status === 'completed' || p.status === 'error' || p.status === 'cancelled') {
          if (patchPollRef.current) {
            clearInterval(patchPollRef.current);
            patchPollRef.current = null;
          }
          
          setPatchProgress({
            status: p.status,
            currentSegment: p.currentSegment,
            totalSegments: p.totalSegments,
            aiApplied: p.aiApplied,
            error: p.error,
          });
          
          if (p.status === 'completed') {
            toast.success(`Retranslated ${p.aiApplied} segments`);
            setLastSaveAffected(null);
            // Clear progress after a short delay to allow UI to update
            setTimeout(() => {
              setPatchProgress(null);
            }, 1000);
            queryClient.invalidateQueries({ queryKey: ['document-segments', documentId] });
          } else if (p.status === 'error' && p.error) {
            toast.error(p.error);
            setTimeout(() => {
              setPatchProgress(null);
            }, 1000);
          } else if (p.status === 'cancelled') {
            toast('Retranslation cancelled');
            setTimeout(() => {
              setPatchProgress(null);
            }, 1000);
          }
          return;
        }
        
        // Update progress if still running
        setPatchProgress({
          status: p.status,
          currentSegment: p.currentSegment,
          totalSegments: p.totalSegments,
          aiApplied: p.aiApplied,
          error: p.error,
        });
      } catch (error: any) {
        // If 404, progress was cleared - stop polling
        if (error.response?.status === 404) {
          if (patchPollRef.current) {
            clearInterval(patchPollRef.current);
            patchPollRef.current = null;
          }
          setPatchProgress(null);
          return;
        }
        // For other errors, keep polling (might be temporary network issue)
      }
    };
    
    const id = setInterval(poll, 1500);
    patchPollRef.current = id;
    poll(); // Initial poll
    
    return () => {
      isCancelled = true;
      if (patchPollRef.current) {
        clearInterval(patchPollRef.current);
        patchPollRef.current = null;
      }
    };
  }, [documentId, patchProgress?.status, queryClient]);

  const cancelPatchTranslate = async () => {
    try {
      await documentsApi.cancelPretranslate(documentId);
    } catch {
      // ignore
    }
  };

  const hasData = dna && (
    (dna.technicalSchema && Object.keys(dna.technicalSchema).length > 0) ||
    (dna.namingConventions && Object.keys(dna.namingConventions).length > 0) ||
    (dna.abbreviationLogic && Object.keys(dna.abbreviationLogic).length > 0) ||
    (dna.entityGroups && Object.keys(dna.entityGroups).length > 0)
  );

  if (comparisonMode && draftDna && refinedDna) {
    return (
      <div className="mt-4 pt-4 border-t border-gray-200">
        <h4 className="text-sm font-semibold text-gray-900 mb-2">Document DNA — Compare</h4>
        <p className="text-xs text-gray-500 mb-2">
          Draft (primary analysis) vs Refined (after revision). Green = new value (was null), Blue = refined term.
        </p>
        <DnaDiffView draft={draftDna} refined={refinedDna} />
        <div className="flex gap-2 flex-wrap mt-3">
          <button
            type="button"
            onClick={handleAcceptRefinement}
            disabled={saveMutation.isLoading}
            className="btn btn-primary text-sm"
          >
            {saveMutation.isLoading ? 'Saving...' : 'Accept Refinement'}
          </button>
          <button
            type="button"
            onClick={() => {
              setComparisonMode(false);
              setRefinedDna(null);
              setDraftDna(null);
            }}
            className="btn btn-secondary text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-200">
      <h4 className="text-sm font-semibold text-gray-900 mb-2">Document DNA (Project Knowledge Base)</h4>
      <p className="text-xs text-gray-500 mb-2">
        Technical schema, naming, abbreviations, and entity groups used as context for all translation providers.
      </p>
      {dnaLoading ? (
        <div className="text-xs text-gray-500">Loading...</div>
      ) : editingMode === 'form' ? (
        <div className="space-y-2">
          <DocumentDnaEditor
            dna={dnaDraft}
            onChange={setDnaDraft}
            disabled={saveMutation.isLoading}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => dnaDraft && saveMutation.mutate(dnaDraft)}
              disabled={saveMutation.isLoading || !dnaDraft}
              className="btn btn-primary text-sm"
            >
              {saveMutation.isLoading ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setEditingMode(null); setDnaDraft(null); }}
              className="btn btn-secondary text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : editingMode === 'json' ? (
        <div className="space-y-2">
          <textarea
            value={editJson}
            onChange={(e) => setEditJson(e.target.value)}
            className="w-full h-48 px-3 py-2 text-xs font-mono border border-gray-300 rounded-md"
            spellCheck={false}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={saveMutation.isLoading}
              className="btn btn-primary text-sm"
            >
              {saveMutation.isLoading ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditingMode(null)}
              className="btn btn-secondary text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : !hasData ? (
        <div className="text-xs text-gray-500 mb-2">
          Not generated yet. Generated automatically after import, or run Regenerate.
        </div>
      ) : (
        <div className="space-y-2 mb-2">
          {dna.technicalSchema && Object.keys(dna.technicalSchema).length > 0 && (
            <details className="border border-gray-200 rounded p-2">
              <summary className="text-xs font-medium cursor-pointer">Technical schema</summary>
              <pre className="mt-1 text-xs overflow-auto max-h-32 whitespace-pre-wrap">{JSON.stringify(dna.technicalSchema, null, 2)}</pre>
            </details>
          )}
          {dna.namingConventions && Object.keys(dna.namingConventions).length > 0 && (
            <details className="border border-gray-200 rounded p-2">
              <summary className="text-xs font-medium cursor-pointer">Naming conventions</summary>
              <pre className="mt-1 text-xs overflow-auto max-h-32 whitespace-pre-wrap">{JSON.stringify(dna.namingConventions, null, 2)}</pre>
            </details>
          )}
          {dna.abbreviationLogic && Object.keys(dna.abbreviationLogic).length > 0 && (
            <details className="border border-gray-200 rounded p-2">
              <summary className="text-xs font-medium cursor-pointer">Abbreviations</summary>
              <pre className="mt-1 text-xs overflow-auto max-h-32 whitespace-pre-wrap">{JSON.stringify(dna.abbreviationLogic, null, 2)}</pre>
            </details>
          )}
          {dna.entityGroups && Object.keys(dna.entityGroups).length > 0 && (
            <details className="border border-gray-200 rounded p-2">
              <summary className="text-xs font-medium cursor-pointer">Entity groups</summary>
              <pre className="mt-1 text-xs overflow-auto max-h-32 whitespace-pre-wrap">{JSON.stringify(dna.entityGroups, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
      {!editingMode && (
        <div className="flex gap-2 flex-wrap items-center">
          {hasData && (
            <>
              <button
                type="button"
                onClick={() => refineMutation.mutate()}
                disabled={refineMutation.isLoading}
                className="btn btn-primary text-sm disabled:opacity-50"
                title="Re-analyze existing DNA against full document text (AI revision)"
              >
                {refineMutation.isLoading 
                  ? `Refining${aiSettings?.model ? ` (${aiSettings.model})` : ''}...` 
                  : 'Refine with AI'}
              </button>
              <button
                type="button"
                onClick={() => setEnrichmentModalOpen(true)}
                disabled={enrichMutation.isLoading}
                className="btn btn-primary text-sm disabled:opacity-50"
                title="Enrich abbreviationLogic from CSV file"
              >
                Enrich from CSV
              </button>
              <button
                type="button"
                onClick={() => extractGlossaryMutation.mutate()}
                disabled={extractGlossaryMutation.isLoading}
                className="btn btn-secondary text-sm disabled:opacity-50"
                title="Extract glossary term pairs from the document (AI) and add as CANDIDATE entries"
              >
                {extractGlossaryMutation.isLoading ? 'Extracting glossary…' : 'Extract glossary (AI)'}
              </button>
              <button
                type="button"
                onClick={() => window.confirm('Clear all document glossary terms for this document?') && clearGlossaryMutation.mutate()}
                disabled={clearGlossaryMutation.isLoading}
                className="btn btn-secondary text-sm disabled:opacity-50 border-red-200 text-red-700 hover:bg-red-50"
                title="Remove all document glossary entries (does not affect DNA or style rules)"
              >
                {clearGlossaryMutation.isLoading ? 'Clearing…' : 'Clear glossary'}
              </button>
            </>
          )}
          <button type="button" onClick={handleStartEditForm} className="text-xs text-blue-600 hover:underline">
            Safe edit
          </button>
          <button type="button" onClick={handleStartEditJson} className="text-xs text-gray-600 hover:underline">
            Edit JSON
          </button>
          <button
            type="button"
            onClick={() => regenerateMutation.mutate()}
            disabled={regenerateMutation.isLoading}
            className="text-xs text-gray-600 hover:underline disabled:opacity-50"
          >
            {regenerateMutation.isLoading 
              ? `Regenerating${aiSettings?.model ? ` (${aiSettings.model})` : ''}...` 
              : 'Regenerate'}
          </button>
        </div>
      )}
      {lastSaveAffected && lastSaveAffected.affectedCount > 0 && patchProgress?.status !== 'running' && (
        <div className="mt-3 p-2 bg-amber-50 border border-amber-200 rounded text-xs">
          <p className="text-amber-800 mb-1">DNA changed. {lastSaveAffected.affectedCount} segments affected.</p>
          <button
            type="button"
            onClick={handleRetranslateAffected}
            className="btn btn-primary text-sm"
          >
            Retranslate only these
          </button>
        </div>
      )}
      {patchProgress?.status === 'running' && (
        <div className="mt-3 p-2 bg-blue-50 border border-blue-200 rounded text-xs">
          <p className="text-blue-800">Retranslating… {patchProgress.aiApplied}/{patchProgress.totalSegments}</p>
          <button type="button" onClick={cancelPatchTranslate} className="mt-1 text-blue-600 hover:underline">
            Cancel
          </button>
        </div>
      )}
      {patchProgress?.status === 'error' && patchProgress.error && (
        <p className="mt-2 text-xs text-red-600">{patchProgress.error}</p>
      )}
      {!editingMode && hasData && <DnaValidationPanel documentId={documentId} />}

      {/* Enrichment Modal */}
      {enrichmentModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold mb-4">Enrich DNA from CSV</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  CSV File
                </label>
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Required columns: "Наименование энергопроизводящей организации", "Сокращенное наименование"
                </p>
              </div>

              <div>
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={useLLM}
                    onChange={(e) => setUseLLM(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm text-gray-700">Use LLM for translation</span>
                </label>
              </div>

              {useLLM && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    LLM Provider
                  </label>
                  <select
                    value={llmProvider}
                    onChange={(e) => setLlmProvider(e.target.value as typeof llmProvider)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  >
                    <option value="gemini">Gemini</option>
                    <option value="openai">OpenAI</option>
                    <option value="yandex">Yandex</option>
                    <option value="deepseek">DeepSeek</option>
                  </select>
                </div>
              )}

              {enrichmentProgress && (
                <div className="bg-blue-50 border border-blue-200 rounded p-3">
                  <p className="text-sm text-blue-800">
                    Processing: {enrichmentProgress.current} / {enrichmentProgress.total}
                  </p>
                  <div className="mt-2 w-full bg-blue-200 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all"
                      style={{ width: `${(enrichmentProgress.current / enrichmentProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setEnrichmentModalOpen(false);
                    setCsvFile(null);
                    setEnrichmentProgress(null);
                  }}
                  className="btn btn-secondary text-sm"
                  disabled={enrichMutation.isLoading}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => enrichMutation.mutate()}
                  disabled={!csvFile || enrichMutation.isLoading}
                  className="btn btn-primary text-sm disabled:opacity-50"
                >
                  {enrichMutation.isLoading 
                    ? `Enriching${useLLM && aiSettings?.model ? ` (${aiSettings.model})` : ''}...` 
                    : 'Enrich'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

