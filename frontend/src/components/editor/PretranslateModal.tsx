import { useState, useEffect, useRef } from 'react';
import { documentsApi } from '../../api/documents.api';
import toast from 'react-hot-toast';
import type { GlossaryMode } from '../../types/glossary';

interface PretranslateModalProps {
  documentId: string;
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
  glossaryMode?: GlossaryMode;
}

export default function PretranslateModal({
  documentId,
  isOpen,
  onClose,
  onComplete,
  glossaryMode = 'strict_source',
}: PretranslateModalProps) {
  const [applyAiToLowMatches, setApplyAiToLowMatches] = useState(false);
  const [applyAiToEmptyOnly, setApplyAiToEmptyOnly] = useState(false);
  const [rewriteConfirmed, setRewriteConfirmed] = useState(false);
  const [rewriteNonConfirmed, setRewriteNonConfirmed] = useState(false);
  const [useCritic, setUseCritic] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<{
    documentId: string;
    status: 'running' | 'completed' | 'cancelled' | 'error';
    currentSegment: number;
    totalSegments: number;
    tmApplied: number;
    aiApplied: number;
    currentSegmentId?: string;
    currentSegmentText?: string;
    error?: string;
  } | null>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isCancelledRef = useRef(false);
  const cancelledToastShownRef = useRef(false);

  // Poll for progress updates
  useEffect(() => {
    if (isProcessing) {
      const pollProgress = async () => {
        // Stop polling if already cancelled and toast shown
        // But only if we've confirmed the cancelled status from backend
        if (cancelledToastShownRef.current && progress?.status === 'cancelled') {
          if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;
          }
          return;
        }

        try {
          const progressData = await documentsApi.getPretranslateProgress(documentId);
          // Only update if data actually changed to prevent UI jumping
          setProgress((prev) => {
            if (!prev || 
                prev.currentSegment !== progressData.currentSegment ||
                prev.tmApplied !== progressData.tmApplied ||
                prev.aiApplied !== progressData.aiApplied ||
                prev.status !== progressData.status) {
              return progressData;
            }
            return prev;
          });

          if (progressData.status === 'completed' || progressData.status === 'cancelled' || progressData.status === 'error') {
            setIsProcessing(false);
            if (progressIntervalRef.current) {
              clearInterval(progressIntervalRef.current);
              progressIntervalRef.current = null;
            }

            if (progressData.status === 'completed') {
              toast.success(
                `Pretranslation complete: ${progressData.tmApplied} TM matches applied, ${progressData.aiApplied} AI translations applied`,
              );
              setTimeout(() => {
                onComplete();
                onClose();
                setProgress(null);
              }, 2000);
            } else if (progressData.status === 'cancelled') {
              // Only show toast once
              if (!cancelledToastShownRef.current) {
                cancelledToastShownRef.current = true;
                toast('Pretranslation cancelled', { icon: 'ℹ️' });
              }
              setIsProcessing(false);
              setProgress(null);
            } else if (progressData.status === 'error') {
              toast.error(progressData.error || 'Pretranslation failed');
              setIsProcessing(false);
              setProgress(null);
            }
          }
        } catch (error: any) {
          // If progress not found (404), it might be starting - don't treat as error
          if (error.response?.status === 404) {
            // Progress not created yet - this is normal when starting
            // Don't update state, just wait for next poll
            return;
          }
          console.error('Error polling progress:', error);
        }
      };

      // Poll every 500ms
      progressIntervalRef.current = setInterval(pollProgress, 500);
      pollProgress(); // Initial poll

      return () => {
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }
      };
    }
  }, [isProcessing, documentId, onComplete, onClose, progress?.status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };
  }, []);

  const handlePretranslate = async () => {
    setIsProcessing(true);
    setProgress(null);
    isCancelledRef.current = false;
    cancelledToastShownRef.current = false; // Reset cancelled toast flag

    try {
      await documentsApi.pretranslate(documentId, {
        applyAiToLowMatches,
        applyAiToEmptyOnly,
        rewriteConfirmed,
        rewriteNonConfirmed,
        glossaryMode, // Pass glossary mode to API
        useCritic, // Pass critic AI option
      });
      // Small delay to ensure backend has created progress before polling starts
      await new Promise(resolve => setTimeout(resolve, 100));
      // Progress will be updated via polling
    } catch (error: any) {
      setIsProcessing(false);
      setProgress(null);
      toast.error(error.response?.data?.message || 'Failed to start pretranslation');
    }
  };

  const handleCancel = async () => {
    if (isCancelledRef.current) {
      return; // Already cancelling
    }
    
    try {
      const result = await documentsApi.cancelPretranslate(documentId);
      console.log('Cancel request sent:', result);
      // Set flag after successful cancel request
      isCancelledRef.current = true;
      // Don't show toast here - let the polling detect cancelled status and show it once
      // Continue polling to see when cancellation completes
      // The polling will detect the cancelled status and stop
    } catch (error: any) {
      console.error('Cancel error:', error);
      const errorMessage = error.response?.data?.message || error.message || 'Failed to cancel pretranslation';
      toast.error(errorMessage);
      // Still try to stop polling if there's an error
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      setIsProcessing(false);
      isCancelledRef.current = false; // Reset so user can try again
      cancelledToastShownRef.current = false;
    }
  };

  const progressPercentage = progress
    ? Math.round((progress.currentSegment / progress.totalSegments) * 100)
    : 0;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-lg w-full mx-4">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Pretranslate Document</h2>
        <p className="text-sm text-gray-600 mb-6">
          This will apply all 100% Translation Memory matches to empty segments. You can optionally apply AI translations to segments with lower matches or only empty segments.
        </p>

        {!isProcessing && (
          <div className="space-y-4 mb-6">
            <div className="border-b border-gray-200 pb-3">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Segment Selection</h3>
              
              <div className="flex items-start mb-3">
                <input
                  type="checkbox"
                  id="rewriteConfirmed"
                  checked={rewriteConfirmed}
                  onChange={(e) => setRewriteConfirmed(e.target.checked)}
                  className="mt-1 mr-3"
                  disabled={isProcessing}
                />
                <label htmlFor="rewriteConfirmed" className="text-sm text-gray-700 cursor-pointer">
                  <span className="font-medium">Rewrite confirmed segments</span>
                  <p className="text-xs text-gray-500 mt-1">
                    Include segments that are already confirmed (status: CONFIRMED)
                  </p>
                </label>
              </div>

              <div className="flex items-start">
                <input
                  type="checkbox"
                  id="rewriteNonConfirmed"
                  checked={rewriteNonConfirmed}
                  onChange={(e) => setRewriteNonConfirmed(e.target.checked)}
                  className="mt-1 mr-3"
                  disabled={isProcessing}
                />
                <label htmlFor="rewriteNonConfirmed" className="text-sm text-gray-700 cursor-pointer">
                  <span className="font-medium">Rewrite non-confirmed segments (not empty)</span>
                  <p className="text-xs text-gray-500 mt-1">
                    Include segments that have translations but are not confirmed (status: NEW, MT, or EDITED)
                  </p>
                </label>
              </div>
            </div>

            <div className="border-b border-gray-200 pb-3">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">AI Translation Options</h3>
              
              <div className="flex items-start mb-3">
                <input
                  type="checkbox"
                  id="applyAiToLowMatches"
                  checked={applyAiToLowMatches}
                  onChange={(e) => {
                    setApplyAiToLowMatches(e.target.checked);
                    if (e.target.checked) {
                      setApplyAiToEmptyOnly(false);
                    }
                  }}
                  className="mt-1 mr-3"
                  disabled={isProcessing}
                />
                <label htmlFor="applyAiToLowMatches" className="text-sm text-gray-700 cursor-pointer">
                  <span className="font-medium">Apply AI translations to segments with &lt; 100% matches</span>
                  <p className="text-xs text-gray-500 mt-1">
                    AI will translate segments that have TM matches but less than 100% similarity, or segments with no matches at all
                  </p>
                </label>
              </div>

              <div className="flex items-start mb-3">
                <input
                  type="checkbox"
                  id="applyAiToEmptyOnly"
                  checked={applyAiToEmptyOnly}
                  onChange={(e) => {
                    setApplyAiToEmptyOnly(e.target.checked);
                    if (e.target.checked) {
                      setApplyAiToLowMatches(false);
                    }
                  }}
                  className="mt-1 mr-3"
                  disabled={isProcessing}
                />
                <label htmlFor="applyAiToEmptyOnly" className="text-sm text-gray-700 cursor-pointer">
                  <span className="font-medium">Apply AI translations only to empty segments</span>
                  <p className="text-xs text-gray-500 mt-1">
                    AI will translate only segments with no TM matches at all
                  </p>
                </label>
              </div>

              <div className="flex items-start">
                <input
                  type="checkbox"
                  id="useCritic"
                  checked={useCritic}
                  onChange={(e) => setUseCritic(e.target.checked)}
                  className="mt-1 mr-3"
                  disabled={isProcessing || (!applyAiToLowMatches && !applyAiToEmptyOnly)}
                />
                <label htmlFor="useCritic" className="text-sm text-gray-700 cursor-pointer">
                  <span className="font-medium">Use Critic AI for higher quality (slower)</span>
                  <p className="text-xs text-gray-500 mt-1">
                    Uses Draft → Critique → Fix workflow for better quality. Processes segments one by one instead of in batches. Only available when AI translation is enabled.
                  </p>
                </label>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded p-3">
              <p className="text-xs text-blue-800">
                <strong>Note:</strong> Empty segments are always processed. Use the options above to also include segments that already have translations.
              </p>
            </div>
          </div>
        )}

        {isProcessing && progress && (
          <div className="mb-6">
            <div className="mb-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium text-gray-700">Progress</span>
                <span className="text-sm font-semibold text-primary-600">
                  {progress.currentSegment} / {progress.totalSegments} segments ({progressPercentage}%)
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden shadow-inner">
                <div
                  className="bg-primary-600 h-full rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${progressPercentage}%` }}
                />
              </div>
            </div>

            {progress.currentSegmentText && (
              <div className="mb-3 p-3 bg-gray-50 border border-gray-200 rounded">
                <div className="text-xs text-gray-500 mb-1">Processing segment:</div>
                <div className="text-sm text-gray-700 line-clamp-2">{progress.currentSegmentText}</div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="p-3 bg-green-50 border border-green-200 rounded">
                <div className="text-green-800 font-medium">TM Matches</div>
                <div className="text-2xl font-bold text-green-900">{progress.tmApplied}</div>
              </div>
              {progress.aiApplied > 0 && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded">
                  <div className="text-blue-800 font-medium">AI Translations</div>
                  <div className="text-2xl font-bold text-blue-900">{progress.aiApplied}</div>
                </div>
              )}
            </div>

            {progress.status === 'cancelled' && (
              <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800">
                Pretranslation cancelled. Processed segments have been saved.
              </div>
            )}

            {progress.status === 'error' && progress.error && (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
                Error: {progress.error}
              </div>
            )}
          </div>
        )}

        {isProcessing && !progress && (
          <div className="mb-6 text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-600 mb-2"></div>
            <p className="text-sm text-gray-600">Starting pretranslation...</p>
          </div>
        )}

        <div className="flex justify-end space-x-3">
          {isProcessing ? (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleCancel();
              }}
              className="btn btn-secondary text-sm"
              disabled={progress?.status === 'cancelled' || progress?.status === 'completed'}
            >
              {progress?.status === 'cancelled' ? 'Cancelling...' : 'Cancel'}
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="btn btn-secondary text-sm"
                disabled={isProcessing}
              >
                Close
              </button>
              <button
                onClick={handlePretranslate}
                className="btn btn-primary text-sm"
                disabled={isProcessing}
              >
                Start Pretranslation
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
