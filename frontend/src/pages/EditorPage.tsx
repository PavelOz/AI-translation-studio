import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { documentsApi } from '../api/documents.api';
import { segmentsApi } from '../api/segments.api';
import { analysisApi } from '../api/analysis.api';
import SegmentEditor from '../components/editor/SegmentEditor';
import EditorToolbar from '../components/editor/EditorToolbar';
import SidebarTabs from '../components/editor/SidebarTabs';
import GlossaryReviewTable from '../components/Glossary/GlossaryReviewTable';
import type { Segment, SegmentStatus } from '../api/segments.api';
import { getSegmentTmDisplayScore } from '../utils/segmentTm';
import type { GlossaryMode } from '../types/glossary';
import { getLanguageName } from '../utils/languages';

export default function EditorPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const queryClient = useQueryClient();

  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [statusFilter, setStatusFilter] = useState<SegmentStatus | 'ALL'>('ALL');
  const [translationFilter, setTranslationFilter] = useState<'all' | 'empty' | 'nonEmpty' | 'hasTranslation'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([]);
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
  const [showGlossaryReview, setShowGlossaryReview] = useState(false);
  /** Page size for segment list; cap to avoid loading 50k+ segments and hanging the browser. */
  const SEGMENTS_PAGE_SIZE = 500;
  const [segmentsPage, setSegmentsPage] = useState(1);

  const { data: documentData, isLoading: isLoadingDocument } = useQuery({
    queryKey: ['documents', documentId],
    queryFn: () => documentsApi.get(documentId!),
    enabled: !!documentId,
  });

  const { data: segmentsData, isLoading: isLoadingSegments, error: segmentsError, refetch: refetchSegments } = useQuery({
    queryKey: ['segments', documentId, statusFilter, searchQuery, segmentsPage],
    queryFn: async () => {
      if (searchQuery) {
        return segmentsApi.list(documentId!, 1, 1000, searchQuery);
      }
      return segmentsApi.list(documentId!, segmentsPage, SEGMENTS_PAGE_SIZE);
    },
    enabled: !!documentId,
  });

  // Load latest Document DNA when opening the document (shared cache with AnalysisSidebar)
  useQuery({
    queryKey: ['document-dna', documentId],
    queryFn: () => analysisApi.getDocumentDna(documentId!),
    enabled: !!documentId,
    retry: false,
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
  const documentTotal = segmentsData?.total ?? segments.length;
  const totalPages = segmentsData?.totalPages ?? 1;
  const globalSegmentIndex = (segmentsPage - 1) * SEGMENTS_PAGE_SIZE + activeSegmentIndex + 1;

  // Debug: log what we have
  if (import.meta.env.DEV) {
    const segmentsWithTranslations = segments.filter(s => s.targetMt || s.targetFinal);
    console.log('Editor render state:', {
      hasDocumentData: !!documentData,
      hasSegmentsData: !!segmentsData,
      segmentsCount: segments.length,
      segmentsWithTranslations: segmentsWithTranslations.length,
      sampleSegmentWithTranslation: segmentsWithTranslations[0] ? {
        id: segmentsWithTranslations[0].id,
        hasTargetMt: !!segmentsWithTranslations[0].targetMt,
        hasTargetFinal: !!segmentsWithTranslations[0].targetFinal,
        targetMtPreview: segmentsWithTranslations[0].targetMt?.substring(0, 50),
        targetFinalPreview: segmentsWithTranslations[0].targetFinal?.substring(0, 50),
        status: segmentsWithTranslations[0].status,
      } : null,
      isLoadingDocument,
      isLoadingSegments,
      segmentsError: segmentsError ? (segmentsError as any).message : null,
    });
  }
  
  const filteredSegments = segments.filter((seg) => {
    // Status filter
    if (statusFilter !== 'ALL' && seg.status !== statusFilter) {
      return false;
    }
    
    // Translation filter
    const hasTranslation = !!(seg.targetFinal || seg.targetMt);
    const isEmpty = !hasTranslation || (seg.targetFinal?.trim() === '' && seg.targetMt?.trim() === '');
    
    if (translationFilter === 'empty' && !isEmpty) {
      return false;
    }
    if (translationFilter === 'nonEmpty' && isEmpty) {
      return false;
    }
    if (translationFilter === 'hasTranslation' && !hasTranslation) {
      return false;
    }
    
    // Search query filter
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
  
  // Debug: log filtered segments
  if (import.meta.env.DEV && filteredSegments.length > 0) {
    const filteredWithTranslations = filteredSegments.filter(s => s.targetMt || s.targetFinal);
    console.log('[EditorPage] Filtered segments', {
      totalFiltered: filteredSegments.length,
      withTranslations: filteredWithTranslations.length,
      statusFilter,
    });
  }

  // Ensure activeSegmentIndex is within bounds
  const safeActiveIndex = filteredSegments.length > 0 
    ? Math.min(activeSegmentIndex, Math.max(0, filteredSegments.length - 1))
    : 0;
  const activeSegment = filteredSegments[safeActiveIndex];
  
  // Debug: log active segment
  if (import.meta.env.DEV && activeSegment) {
    console.log('[EditorPage] Active segment', {
      segmentId: activeSegment.id,
      hasTargetMt: !!activeSegment.targetMt,
      hasTargetFinal: !!activeSegment.targetFinal,
      targetMtPreview: activeSegment.targetMt?.substring(0, 50),
      targetFinalPreview: activeSegment.targetFinal?.substring(0, 50),
      status: activeSegment.status,
    });
  }
  
  // Update index if it was out of bounds (only when segments change, not on every render)
  useEffect(() => {
    if (filteredSegments.length > 0 && activeSegmentIndex >= filteredSegments.length) {
      setActiveSegmentIndex(0);
    }
  }, [filteredSegments.length, activeSegmentIndex]);

  // Reset to first segment when changing page
  useEffect(() => {
    setActiveSegmentIndex(0);
  }, [segmentsPage]);

  useEffect(() => {
    setSegmentsPage(1);
  }, [searchQuery]);

  const updateSegmentMutation = useMutation({
    mutationFn: ({ segmentId, updates }: { segmentId: string; updates: Partial<Segment> }) =>
      segmentsApi.update(segmentId, updates),
    onSuccess: (updatedSegment) => {
      // Optimistically update the query cache with the updated segment
      queryClient.setQueryData(['segments', documentId, statusFilter, searchQuery, segmentsPage], (oldData: any) => {
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
      queryClient.invalidateQueries({ queryKey: ['segment', updatedSegment.id] });
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
    // When confirming, move to next unedited segment (skip CONFIRMED and EDITED)
    if (!activeSegment) {
      if (filteredSegments.length > 0) {
        const firstUnedited = filteredSegments.find(seg => 
          seg.status !== 'CONFIRMED' && seg.status !== 'EDITED'
        );
        if (firstUnedited) {
          const index = filteredSegments.findIndex(seg => seg.id === firstUnedited.id);
          setActiveSegmentIndex(index);
        } else {
          setActiveSegmentIndex(0);
        }
      }
      return;
    }
    
    const currentIndex = filteredSegments.findIndex(seg => seg.id === activeSegment.id);
    if (currentIndex >= 0 && currentIndex < filteredSegments.length - 1) {
      // Find next unedited segment
      const nextUnedited = filteredSegments.slice(currentIndex + 1).find(seg => 
        seg.status !== 'CONFIRMED' && seg.status !== 'EDITED'
      );
      if (nextUnedited) {
        const nextIndex = filteredSegments.findIndex(seg => seg.id === nextUnedited.id);
        setActiveSegmentIndex(nextIndex);
      } else {
        // No unedited segments found, just move to next
        handleNext();
      }
    } else {
      handleNext();
    }
  }, [activeSegment, filteredSegments, handleNext]);

  const handleApplyTM = useCallback(async (targetText: string) => {
    if (activeSegment && segmentsData) {
      // Optimistically update the query cache immediately for instant UI feedback
      queryClient.setQueryData(['segments', documentId, statusFilter, searchQuery, segmentsPage], (oldData: any) => {
        if (!oldData) return oldData;
        const updatedSegments = oldData.segments.map((seg: Segment) =>
          seg.id === activeSegment.id
            ? {
                ...seg,
                targetFinal: targetText,
                targetMt: targetText,
                status: 'MT' as const,
              }
            : seg
        );
        return {
          ...oldData,
          segments: updatedSegments,
        };
      });

      // Also update via API to ensure data is saved to database
      try {
        await segmentsApi.update(activeSegment.id, {
          targetFinal: targetText,
          status: 'MT',
        });
      } catch (error: any) {
        console.error('Failed to save translation to database:', error);
        // Revert optimistic update on error
        queryClient.invalidateQueries({ queryKey: ['segments', documentId] });
      }
      
      // Invalidate queries in background after a short delay to sync with server
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['segments', documentId] });
        queryClient.invalidateQueries({ queryKey: ['segment', activeSegment.id] });
      }, 500); // Reduced delay for faster sync
    }
  }, [activeSegment, queryClient, documentId, statusFilter, searchQuery, segmentsData, segmentsPage]);

  const handleSegmentClick = useCallback((index: number) => {
    setActiveSegmentIndex(index);
  }, []);

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
  }, [statusFilter, translationFilter, searchQuery]);

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
                  ✓ {documentTotal > segmentsData.segments.length
                    ? `${segmentsData.segments.length.toLocaleString()} of ${documentTotal.toLocaleString()}`
                    : segmentsData.segments.length} segment{segmentsData.segments.length !== 1 ? 's' : ''} loaded
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
    total: documentTotal,
    confirmed: segments.filter((s) => s.status === 'CONFIRMED').length,
    edited: segments.filter((s) => s.status === 'EDITED').length,
    mt: segments.filter((s) => s.status === 'MT').length,
    new: segments.filter((s) => s.status === 'NEW').length,
  };

  const completionRate = progress.total > 0 ? (progress.confirmed / progress.total) * 100 : 0;
  const showPagination = !searchQuery && documentTotal > SEGMENTS_PAGE_SIZE;

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
          onRefresh={async () => {
            console.log('[EditorPage] onRefresh called - invalidating and refetching segments');
            // Invalidate all segment-related queries to ensure fresh data
            await queryClient.invalidateQueries({ 
              queryKey: ['segments', documentId],
              exact: false, // Invalidate all queries that start with this key
            });
            // Also invalidate document query in case it has segment counts
            await queryClient.invalidateQueries({ 
              queryKey: ['documents', documentId],
            });
            // Force refetch with fresh data
            const result = await refetchSegments();
            console.log('[EditorPage] Segments refetched', {
              dataCount: result.data?.segments?.length || 0,
              total: result.data?.total || 0,
              hasTranslations: result.data?.segments?.some((s: Segment) => s.targetMt || s.targetFinal) || false,
              segmentsWithTargetMt: result.data?.segments?.filter((s: Segment) => s.targetMt).length || 0,
              segmentsWithTargetFinal: result.data?.segments?.filter((s: Segment) => s.targetFinal).length || 0,
              sampleSegment: result.data?.segments?.find((s: Segment) => s.targetMt || s.targetFinal),
            });
          }}
          onBatchTranslate={refetchSegments}
          onResetSegments={async (_segmentIds) => {
            // Invalidate and refetch segments after reset
            queryClient.invalidateQueries({ queryKey: ['segments', documentId] });
            await refetchSegments();
            // Clear selection after reset
            setSelectedSegmentIds([]);
          }}
          glossaryMode={glossaryMode}
        />

        {/* Filter and Actions */}
        <div className="bg-white border-b border-gray-200">
          <div className="px-4 py-3 flex items-center space-x-4 flex-wrap gap-3">
            <div className="flex-1 min-w-[200px]">
              <input
                type="text"
                placeholder="Search segments..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input w-full"
              />
            </div>
            <div className="flex items-center space-x-2">
              <label className="text-sm text-gray-700 whitespace-nowrap">Status:</label>
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
            <div className="flex items-center space-x-2">
              <label className="text-sm text-gray-700 whitespace-nowrap">Translation:</label>
              <select
                value={translationFilter}
                onChange={(e) => setTranslationFilter(e.target.value as any)}
                className="input"
              >
                <option value="all">All</option>
                <option value="empty">Empty</option>
                <option value="nonEmpty">Non-empty</option>
                <option value="hasTranslation">Has Translation</option>
              </select>
            </div>
            <button
              onClick={() => setShowGlossaryReview(!showGlossaryReview)}
              className={`btn text-sm whitespace-nowrap ${
                showGlossaryReview ? 'btn-secondary' : 'btn-outline'
              }`}
            >
              {showGlossaryReview ? 'Hide' : 'Show'} Glossary Review
            </button>
          </div>
        </div>

        {/* Glossary Review Section (Collapsible) */}
        {showGlossaryReview && (
          <div className="bg-gray-50 border-b border-gray-200 p-6">
            <GlossaryReviewTable documentId={documentId!} />
          </div>
        )}

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
                <>
                  <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center space-x-3">
                      <button
                        onClick={() => {
                          if (selectedSegmentIds.length === filteredSegments.length) {
                            setSelectedSegmentIds([]);
                          } else {
                            setSelectedSegmentIds(filteredSegments.map(s => s.id));
                          }
                        }}
                        className="text-sm text-gray-600 hover:text-gray-900"
                      >
                        {selectedSegmentIds.length === filteredSegments.length ? 'Deselect All' : 'Select All'}
                      </button>
                      {selectedSegmentIds.length > 0 && (
                        <span className="text-sm text-gray-600">
                          {selectedSegmentIds.length} selected
                        </span>
                      )}
                    </div>
                    {showPagination && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-gray-600">
                          Page {segmentsPage} of {totalPages} (segments {(segmentsPage - 1) * SEGMENTS_PAGE_SIZE + 1}–{Math.min(segmentsPage * SEGMENTS_PAGE_SIZE, documentTotal)} of {documentTotal.toLocaleString()})
                        </span>
                        <button
                          type="button"
                          onClick={() => setSegmentsPage(1)}
                          disabled={segmentsPage <= 1}
                          className="btn btn-secondary text-sm disabled:opacity-50"
                          title="First page"
                        >
                          First
                        </button>
                        <button
                          type="button"
                          onClick={() => setSegmentsPage((p) => Math.max(1, p - 1))}
                          disabled={segmentsPage <= 1}
                          className="btn btn-secondary text-sm disabled:opacity-50"
                          title="Previous page"
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          onClick={() => setSegmentsPage((p) => Math.min(totalPages, p + 1))}
                          disabled={segmentsPage >= totalPages}
                          className="btn btn-secondary text-sm disabled:opacity-50"
                          title="Next page"
                        >
                          Next
                        </button>
                        <button
                          type="button"
                          onClick={() => setSegmentsPage(totalPages)}
                          disabled={segmentsPage >= totalPages}
                          className="btn btn-secondary text-sm disabled:opacity-50"
                          title="Last page"
                        >
                          Last
                        </button>
                      </div>
                    )}
                  </div>
                  {filteredSegments.map((segment, index) => {
                    const isSelected = selectedSegmentIds.includes(segment.id);
                    // Log segment data for debugging
                    if (index === activeSegmentIndex && (segment.targetMt || segment.targetFinal)) {
                      console.log('[EditorPage] Rendering active segment with translation', {
                        segmentId: segment.id,
                        hasTargetMt: !!segment.targetMt,
                        hasTargetFinal: !!segment.targetFinal,
                        targetMtPreview: segment.targetMt?.substring(0, 50),
                        targetFinalPreview: segment.targetFinal?.substring(0, 50),
                        status: segment.status,
                      });
                    }
                    return (
                      <div
                        key={segment.id}
                        className={`flex items-start space-x-2 ${index === activeSegmentIndex ? 'cursor-default' : 'cursor-pointer'}`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            e.stopPropagation();
                            if (e.target.checked) {
                              setSelectedSegmentIds([...selectedSegmentIds, segment.id]);
                            } else {
                              setSelectedSegmentIds(selectedSegmentIds.filter(id => id !== segment.id));
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-2 h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <div
                          onClick={() => handleSegmentClick(index)}
                          className={`flex-1 ${index === activeSegmentIndex ? 'cursor-default' : 'cursor-pointer'}`}
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
                      </div>
                    );
                  })}
                </>
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
                    className="border-l border-gray-200 bg-gray-50 flex flex-col min-h-0"
                    style={{ width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px`, maxWidth: `${sidebarWidth}px` }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <SidebarTabs
                      documentId={documentId!}
                      projectId={documentData.projectId}
                      sourceLocale={documentData.sourceLocale}
                      targetLocale={documentData.targetLocale}
                      segmentId={activeSegment.id}
                      sourceText={activeSegment.sourceText}
                      targetText={activeSegment.targetFinal || activeSegment.targetMt || ''}
                      appliedBestTmEntryId={activeSegment.bestTmEntryId}
                      appliedTmScore={getSegmentTmDisplayScore(activeSegment)}
                      glossaryMode={glossaryMode}
                      onGlossaryModeChange={setGlossaryMode}
                      onApplyTM={handleApplyTM}
                    />
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
              Segment {showPagination ? globalSegmentIndex : activeSegmentIndex + 1} of {documentTotal.toLocaleString()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}