import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { documentsApi } from '../api/documents.api';
import { segmentsApi } from '../api/segments.api';
import SegmentEditor from '../components/editor/SegmentEditor';
import TMSuggestionsPanel from '../components/editor/TMSuggestionsPanel';
import AITranslationPanel from '../components/editor/AITranslationPanel';
import AIChatPanel from '../components/editor/AIChatPanel';
import GuidelinesPanel from '../components/editor/GuidelinesPanel';
import GlossaryPanel from '../components/editor/GlossaryPanel';
import GlossaryModePanel from '../components/editor/GlossaryModePanel';
import QAIssuesPanel from '../components/editor/QAIssuesPanel';
import DebugInspectorPanel from '../components/editor/DebugInspectorPanel';
import EditorToolbar from '../components/editor/EditorToolbar';
import SegmentFilter from '../components/editor/SegmentFilter';
import DocumentGlossary from '../components/DocumentGlossary';
import type { Segment, SegmentStatus } from '../api/segments.api';
import type { GlossaryMode } from '../types/glossary';
import { getLanguageName } from '../utils/languages';
import toast from 'react-hot-toast';

export default function EditorPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const queryClient = useQueryClient();

  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [statusFilter, setStatusFilter] = useState<SegmentStatus | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSegmentIds] = useState<string[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('editor-sidebar-width');
        if (saved) {
          const parsed = parseInt(saved, 10);
          if (!isNaN(parsed) && parsed >= 250 && parsed <= 800) {
            return parsed;
          }
        }
      } catch (error) {
        console.warn('Failed to load sidebar width from localStorage:', error);
      }
    }
    return 320; // Default 320px (w-80)
  });
  const [isResizing, setIsResizing] = useState(false);
  const [glossaryMode, setGlossaryMode] = useState<GlossaryMode>(() => {
    // Load from localStorage or default to 'strict_source'
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('ai-ts-glossary-mode');
        if (saved === 'off' || saved === 'strict_source' || saved === 'strict_semantic') {
          return saved;
        }
      } catch (error) {
        console.warn('Failed to load glossary mode from localStorage:', error);
      }
    }
    return 'strict_source';
  });
  const [loadingProgress, setLoadingProgress] = useState<{
    progress: number;
    stage: string;
    details?: string;
  } | null>(null);
  const [isGeneratingGlossary, setIsGeneratingGlossary] = useState(false);

  const { data: documentData, isLoading: isLoadingDocument } = useQuery({
    queryKey: ['documents', documentId],
    queryFn: () => documentsApi.get(documentId!),
    enabled: !!documentId,
  });

  const { data: segmentsData, isLoading: isLoadingSegments, error: segmentsError, refetch: refetchSegments } = useQuery({
    queryKey: ['segments', documentId, statusFilter, searchQuery],
    queryFn: () => {
      if (searchQuery) {
        return segmentsApi.list(documentId!, 1, 1000, searchQuery);
      }
      return segmentsApi.list(documentId!, 1, 1000);
    },
    enabled: !!documentId,
  });

  // Track loading progress with detailed stages
  useEffect(() => {
    if (isLoadingDocument) {
      setLoadingProgress({ 
        progress: 20, 
        stage: 'Loading document',
        details: 'Fetching document information...'
      });
    } else if (documentData && isLoadingSegments) {
      setLoadingProgress({ 
        progress: 60, 
        stage: 'Loading segments',
        details: 'Retrieving translation segments...'
      });
    } else if (documentData && segmentsData) {
      const segmentCount = segmentsData.segments?.length || 0;
      const totalSegments = segmentsData.total || segmentCount;
      setLoadingProgress({ 
        progress: 100, 
        stage: 'Ready',
        details: `Loaded ${segmentCount}${totalSegments > segmentCount ? ` of ${totalSegments}` : ''} segments`
      });
      // Clear progress after a short delay to show completion
      const timer = setTimeout(() => {
        setLoadingProgress(null);
      }, 500);
      return () => clearTimeout(timer);
    } else if (!isLoadingDocument && !isLoadingSegments) {
      // Clear progress if not loading and no data yet
      if (!documentData) {
        setLoadingProgress(null);
      }
    }
  }, [isLoadingDocument, isLoadingSegments, documentData, segmentsData]);

  const segments = segmentsData?.segments || [];
  
  // Debug: log what we have
  if (import.meta.env.DEV) {
    console.log('Editor render state:', {
      hasDocumentData: !!documentData,
      hasSegmentsData: !!segmentsData,
      segmentsCount: segments.length,
      isLoadingDocument,
      isLoadingSegments,
      segmentsError: segmentsError ? (segmentsError as any).message : null,
    });
  }
  
  const filteredSegments = segments.filter((seg) => {
    if (statusFilter !== 'ALL' && seg.status !== statusFilter) {
      return false;
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        seg.sourceText.toLowerCase().includes(query) ||
        seg.targetFinal?.toLowerCase().includes(query) ||
        seg.targetMt?.toLowerCase().includes(query)
      );
    }
    return true;
  });

  // Ensure activeSegmentIndex is within bounds
  const safeActiveIndex = filteredSegments.length > 0 
    ? Math.min(activeSegmentIndex, Math.max(0, filteredSegments.length - 1))
    : 0;
  const activeSegment = filteredSegments[safeActiveIndex];
  
  // Update index if it was out of bounds (only when segments change, not on every render)
  useEffect(() => {
    if (filteredSegments.length > 0 && activeSegmentIndex >= filteredSegments.length) {
      setActiveSegmentIndex(0);
    }
  }, [filteredSegments.length, activeSegmentIndex]);

  const updateSegmentMutation = useMutation({
    mutationFn: ({ segmentId, updates }: { segmentId: string; updates: Partial<Segment> }) =>
      segmentsApi.update(segmentId, updates),
    onSuccess: (updatedSegment) => {
      // Optimistically update the query cache with the updated segment
      queryClient.setQueryData(['segments', documentId, statusFilter, searchQuery], (oldData: any) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          segments: oldData.segments.map((seg: Segment) =>
            seg.id === updatedSegment.id ? updatedSegment : seg
          ),
        };
      });
      // Also invalidate to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['segments', documentId] });
    },
  });


  const handleSegmentUpdate = useCallback(
    (segmentId: string, updates: Partial<Segment>) => {
      updateSegmentMutation.mutate({ segmentId, updates });
    },
    [updateSegmentMutation],
  );

  const handleNext = useCallback(() => {
    if (activeSegmentIndex < filteredSegments.length - 1) {
      setActiveSegmentIndex(activeSegmentIndex + 1);
    }
  }, [activeSegmentIndex, filteredSegments.length]);

  const handlePrevious = useCallback(() => {
    if (activeSegmentIndex > 0) {
      setActiveSegmentIndex(activeSegmentIndex - 1);
    }
  }, [activeSegmentIndex]);

  const handleConfirm = useCallback(() => {
    handleNext();
  }, [handleNext]);

  const handleApplyTM = useCallback((targetText: string) => {
    if (activeSegment && segmentsData) {
      // Optimistically update the query cache immediately for instant UI feedback
      queryClient.setQueryData(['segments', documentId, statusFilter, searchQuery], (oldData: any) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          segments: oldData.segments.map((seg: Segment) =>
            seg.id === activeSegment.id
              ? {
                  ...seg,
                  targetFinal: targetText,
                  targetMt: targetText,
                  status: 'MT' as const,
                }
              : seg
          ),
        };
      });
      
      // Invalidate queries in background after a short delay to sync with server
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['segments', documentId] });
      }, 500); // Reduced delay for faster sync
    }
  }, [activeSegment, queryClient, documentId, statusFilter, searchQuery, segmentsData]);

  const handleSegmentClick = useCallback((index: number) => {
    setActiveSegmentIndex(index);
  }, []);

  const handleGenerateGlossaryClick = useCallback(async () => {
    if (!documentId || isGeneratingGlossary) return;

    setIsGeneratingGlossary(true);
    try {
      const result = await documentsApi.generateGlossary(documentId);
      
      toast.success(`Successfully generated ${result.count} glossary term${result.count !== 1 ? 's' : ''}`);
      
      // Invalidate glossary-related queries to refresh the UI
      queryClient.invalidateQueries({ queryKey: ['glossary'] });
      queryClient.invalidateQueries({ queryKey: ['glossary', documentData?.projectId] });
      queryClient.invalidateQueries({ queryKey: ['glossary', documentId] }); // Document-specific glossary
      
      // Also invalidate document queries in case glossary is shown in document context
      queryClient.invalidateQueries({ queryKey: ['documents', documentId] });
    } catch (error: any) {
      const errorMessage = error?.response?.data?.error || error?.message || 'Failed to generate glossary';
      toast.error(`Glossary generation failed: ${errorMessage}`);
      console.error('Glossary generation error:', error);
    } finally {
      setIsGeneratingGlossary(false);
    }
  }, [documentId, isGeneratingGlossary, queryClient, documentData?.projectId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Global shortcuts (only when not typing in input)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleNext();
      } else if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handlePrevious();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNext, handlePrevious]);

  // Reset active index when filter changes
  useEffect(() => {
    setActiveSegmentIndex(0);
  }, [statusFilter, searchQuery]);

  // Save sidebar width to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('editor-sidebar-width', sidebarWidth.toString());
      } catch (error) {
        console.warn('Failed to save sidebar width to localStorage:', error);
      }
    }
  }, [sidebarWidth]);

  // Handle sidebar resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      const newWidth = window.innerWidth - e.clientX;
      const minWidth = 250;
      const maxWidth = Math.min(800, window.innerWidth * 0.6);
      
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  // Simple loading check: show loading screen only if we're actively loading
  if (isLoadingDocument || isLoadingSegments) {
    const currentProgress = loadingProgress?.progress || (isLoadingDocument ? 20 : isLoadingSegments ? 60 : 0);
    const currentStage = loadingProgress?.stage || (isLoadingDocument ? 'Loading document' : isLoadingSegments ? 'Loading segments' : 'Preparing');
    const currentDetails = loadingProgress?.details || (isLoadingDocument ? 'Fetching document information...' : isLoadingSegments ? 'Retrieving translation segments...' : 'Initializing editor...');

    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 fixed inset-0 z-50">
        <div className="w-full max-w-lg px-6">
          <div className="bg-white rounded-lg shadow-xl p-8 border border-gray-200">
            <div className="text-center mb-6">
              <div className="inline-block animate-spin rounded-full h-16 w-16 border-4 border-primary-200 border-t-primary-600 mb-6"></div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Loading Translation Editor</h2>
              <p className="text-sm font-medium text-gray-700">{currentStage}</p>
            </div>
            
            {/* Progress Bar */}
            <div className="w-full">
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm font-medium text-gray-700">Progress</span>
                <span className="text-sm font-semibold text-primary-600">{currentProgress}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden shadow-inner">
                <div
                  className="bg-gradient-to-r from-primary-500 to-primary-600 h-4 rounded-full transition-all duration-500 ease-out relative"
                  style={{ width: `${currentProgress}%` }}
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer"></div>
                </div>
              </div>
              <div className="mt-4 text-sm text-gray-600 text-center">
                {currentDetails}
              </div>
              {segmentsData && segmentsData.segments && segmentsData.segments.length > 0 && (
                <div className="mt-3 text-xs text-gray-500 text-center bg-gray-50 rounded px-3 py-2">
                  ✓ {segmentsData.segments.length} segment{segmentsData.segments.length !== 1 ? 's' : ''} loaded
                </div>
              )}
              {documentData && (
                <div className="mt-2 text-xs text-gray-400 text-center">
                  Document: {documentData.name}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error handling - must have documentData to render editor
  if (!documentData) {
    if (isLoadingDocument) {
      // Still loading, should have been caught above, but just in case
      return null;
    }
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="text-gray-500 mb-2">Document not found</div>
          <div className="text-sm text-gray-400">The document may have been deleted or you don't have access to it.</div>
        </div>
      </div>
    );
  }

  // Show segment error only if we have document but segments failed AND we don't have any segments data
  // If we have segmentsData (even if empty), continue to render editor
  if (segmentsError && !segmentsData && !isLoadingSegments) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="text-red-500 mb-2">Error loading segments</div>
          <div className="text-sm text-gray-500">{(segmentsError as any)?.message || 'Unknown error'}</div>
          <button
            onClick={() => refetchSegments()}
            className="btn btn-primary mt-4"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const progress = {
    total: segments.length,
    confirmed: segments.filter((s) => s.status === 'CONFIRMED').length,
    edited: segments.filter((s) => s.status === 'EDITED').length,
    mt: segments.filter((s) => s.status === 'MT').length,
    new: segments.filter((s) => s.status === 'NEW').length,
  };

  const completionRate = progress.total > 0 ? (progress.confirmed / progress.total) * 100 : 0;

  return (
    <div className="h-screen flex flex-col bg-gray-50 fixed inset-0">
      <div className="h-full flex flex-col bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex justify-between items-center">
            <div>
              <div className="flex items-center space-x-3">
                <Link
                  to={`/documents/${documentId}`}
                  className="text-primary-600 hover:text-primary-700 text-sm"
                >
                  ← Back
                </Link>
                <h1 className="text-2xl font-bold text-gray-900">{documentData.name}</h1>
              </div>
              <p className="text-sm text-gray-600 mt-1">
                {getLanguageName(documentData.sourceLocale)} → {getLanguageName(documentData.targetLocale)}
              </p>
            </div>
            <div className="flex items-center space-x-4">
              <div className="text-right">
                <div className="text-sm font-medium text-gray-900">
                  {progress.confirmed} / {progress.total} confirmed
                </div>
                <div className="text-xs text-gray-500">{completionRate.toFixed(1)}% complete</div>
              </div>
              <div className="w-32 bg-gray-200 rounded-full h-2">
                <div
                  className="bg-primary-600 h-2 rounded-full transition-all"
                  style={{ width: `${completionRate}%` }}
                />
              </div>
              <button
                onClick={() => setShowSidebar(!showSidebar)}
                className="btn btn-secondary text-sm"
              >
                {showSidebar ? 'Hide' : 'Show'} Sidebar
              </button>
            </div>
          </div>
        </div>

        {/* Toolbar */}
        <EditorToolbar
          documentId={documentId!}
          selectedSegmentIds={selectedSegmentIds}
          onRefresh={refetchSegments}
          onBatchTranslate={refetchSegments}
          glossaryMode={glossaryMode}
        />

        {/* Filter and Actions */}
        <div className="bg-white border-b border-gray-200">
          <div className="px-4 py-3 flex items-center space-x-4">
            <div className="flex-1">
              <input
                type="text"
                placeholder="Search segments..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input w-full"
              />
            </div>
            <div className="flex items-center space-x-2">
              <label className="text-sm text-gray-700">Status:</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as SegmentStatus | 'ALL')}
                className="input"
              >
                <option value="ALL">All</option>
                <option value="NEW">New</option>
                <option value="MT">MT</option>
                <option value="EDITED">Edited</option>
                <option value="CONFIRMED">Confirmed</option>
              </select>
            </div>
            <button
              onClick={handleGenerateGlossaryClick}
              disabled={isGeneratingGlossary}
              className="btn btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {isGeneratingGlossary ? (
                <>
                  <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2"></span>
                  Generating...
                </>
              ) : (
                'Generate Glossary'
              )}
            </button>
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Segments List */}
          <div className="flex-1 overflow-y-auto bg-white">
            <div className="p-6 space-y-4">
              {filteredSegments.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  {segments.length === 0 ? (
                    <>
                      <p className="text-lg font-medium mb-2">No segments found</p>
                      <p className="text-sm">This document may not have any segments yet, or they are still being processed.</p>
                      {isLoadingSegments && (
                        <p className="text-xs mt-2 text-gray-400">Loading segments...</p>
                      )}
                    </>
                  ) : (
                    <p>No segments found matching your filters</p>
                  )}
                </div>
              ) : (
                filteredSegments.map((segment, index) => (
                  <div
                    key={segment.id}
                    onClick={() => handleSegmentClick(index)}
                    className={index === activeSegmentIndex ? 'cursor-default' : 'cursor-pointer'}
                  >
                    <SegmentEditor
                      segment={segment}
                      isActive={index === activeSegmentIndex}
                      onUpdate={handleSegmentUpdate}
                      onNext={handleNext}
                      onPrevious={handlePrevious}
                      onConfirm={handleConfirm}
                      sourceLocale={documentData?.sourceLocale}
                      targetLocale={documentData?.targetLocale}
                      projectId={documentData?.projectId}
                    />
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Sidebar */}
          {showSidebar && activeSegment && (
            <>
              {/* Resize Handle */}
              <div
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsResizing(true);
                }}
                className={`flex-shrink-0 bg-gray-200 hover:bg-primary-400 cursor-col-resize transition-colors ${
                  isResizing ? 'bg-primary-500' : ''
                }`}
                style={{ width: '6px', minWidth: '6px' }}
                title="Drag to resize sidebar"
              >
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-0.5 h-8 bg-gray-400 rounded" />
                </div>
              </div>
                  <div
                    className="border-l border-gray-200 bg-gray-50 overflow-y-auto p-4 space-y-4"
                    style={{ width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px`, maxWidth: `${sidebarWidth}px` }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <AIChatPanel
                      projectId={documentData.projectId}
                      documentId={documentId!}
                      segmentId={activeSegment.id}
                      sourceText={activeSegment.sourceText}
                      targetText={activeSegment.targetFinal || activeSegment.targetMt}
                    />

                    <AITranslationPanel
                      sourceText={activeSegment.sourceText}
                      sourceLocale={documentData.sourceLocale}
                      targetLocale={documentData.targetLocale}
                      projectId={documentData.projectId}
                      segmentId={activeSegment.id}
                      glossaryMode={glossaryMode}
                      currentTargetText={activeSegment.targetFinal || activeSegment.targetMt}
                      onApply={handleApplyTM}
                    />

                    <TMSuggestionsPanel
                      sourceText={activeSegment.sourceText}
                      sourceLocale={documentData.sourceLocale}
                      targetLocale={documentData.targetLocale}
                      projectId={documentData.projectId}
                      segmentId={activeSegment.id}
                      currentTargetText={activeSegment.targetFinal || activeSegment.targetMt}
                      onApply={handleApplyTM}
                    />

                    <GlossaryModePanel
                      mode={glossaryMode}
                      onModeChange={(mode) => {
                        setGlossaryMode(mode);
                        if (typeof window !== 'undefined') {
                          try {
                            localStorage.setItem('ai-ts-glossary-mode', mode);
                          } catch {
                            // ignore storage errors
                          }
                        }
                      }}
                    />

                    <DocumentGlossary documentId={documentId!} />

                    <GuidelinesPanel projectId={documentData.projectId} />

                    <GlossaryPanel
                      sourceText={activeSegment.sourceText}
                      sourceLocale={documentData.sourceLocale}
                      targetLocale={documentData.targetLocale}
                      projectId={documentData.projectId}
                    />

                    <QAIssuesPanel segmentId={activeSegment.id} />

                    <DebugInspectorPanel segmentId={activeSegment.id} />
                  </div>
            </>
          )}
        </div>

        {/* Footer Stats */}
        <div className="bg-white border-t border-gray-200 px-6 py-2">
          <div className="flex justify-between items-center text-sm text-gray-600">
            <div className="flex space-x-4">
              <span>New: {progress.new}</span>
              <span>MT: {progress.mt}</span>
              <span>Edited: {progress.edited}</span>
              <span>Confirmed: {progress.confirmed}</span>
            </div>
            <div>
              Segment {activeSegmentIndex + 1} of {filteredSegments.length}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}