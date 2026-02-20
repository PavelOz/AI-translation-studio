import { useState, useRef, useEffect } from 'react';
import { documentsApi } from '../../api/documents.api';
import { segmentsApi } from '../../api/segments.api';
import apiClient from '../../api/client';
import toast from 'react-hot-toast';
import PretranslateModal from './PretranslateModal';
import type { GlossaryMode } from '../../types/glossary';

interface EditorToolbarProps {
  documentId: string;
  selectedSegmentIds: string[];
  onRefresh: () => void;
  onBatchTranslate: () => void;
  onResetSegments?: (segmentIds: string[] | null) => void;
  glossaryMode?: GlossaryMode;
}

export default function EditorToolbar({
  documentId,
  selectedSegmentIds,
  onRefresh,
  onBatchTranslate,
  onResetSegments,
  glossaryMode = 'strict_source',
}: EditorToolbarProps) {
  const [isPretranslateModalOpen, setIsPretranslateModalOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{
    stage: 'preparing' | 'downloading' | 'processing' | 'complete';
    message: string;
  } | null>(null);
  const [showBatchOptions, setShowBatchOptions] = useState(false);
  const [batchFilterMode, setBatchFilterMode] = useState<'empty' | 'nonEmpty' | 'nonConfirmed' | 'all'>('empty');
  const batchOptionsRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (batchOptionsRef.current && !batchOptionsRef.current.contains(event.target as Node)) {
        setShowBatchOptions(false);
      }
    };

    if (showBatchOptions) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showBatchOptions]);

  const handleBatchTranslate = async () => {
    try {
      const options: any = {
        mode: 'pre_translate',
        applyTm: true,
        minScore: 70,
        glossaryMode,
      };

      // Apply filter based on selection
      if (batchFilterMode === 'empty') {
        options.mtOnlyEmpty = true;
      } else if (batchFilterMode === 'nonEmpty') {
        options.mtOnlyNonEmpty = true;
      } else if (batchFilterMode === 'nonConfirmed') {
        options.rewriteNonConfirmed = true;
      } else if (batchFilterMode === 'all') {
        options.mode = 'translate_all';
      }

      const response = await documentsApi.batchTranslate(documentId, options);
      toast.success(`Batch translation started: ${response.processed} segments processed`);
      onBatchTranslate();
      setShowBatchOptions(false);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to start batch translation');
    }
  };

  const handleDownload = async (exportFile = false) => {
    if (isExporting) return; // Prevent multiple clicks
    
    setIsExporting(true);
    setExportProgress({
      stage: 'preparing',
      message: 'Preparing export...',
    });

    try {
      // Stage 1: Get document info
      setExportProgress({
        stage: 'preparing',
        message: 'Loading document information...',
      });
      const doc = await documentsApi.get(documentId);

      // Stage 2: Download/Export
      setExportProgress({
        stage: exportFile ? 'processing' : 'downloading',
        message: exportFile ? 'Generating translated file...' : 'Downloading original file...',
      });
      
      const blob = await documentsApi.download(documentId, exportFile);
      
      // Stage 3: Create download link
      setExportProgress({
        stage: 'processing',
        message: 'Preparing download...',
      });
      
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const extension = exportFile 
        ? (doc.fileType === 'DOCX' ? 'docx' : doc.fileType === 'XLIFF' ? 'xliff' : 'xlsx')
        : 'txt';
      a.download = `${doc.filename || doc.name}${exportFile ? '' : '_original'}.${extension}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      // Stage 4: Complete
      setExportProgress({
        stage: 'complete',
        message: 'Download started',
      });
      
      toast.success(exportFile ? 'Translated document exported successfully' : 'Original document downloaded');
      
      // Clear progress after a short delay
      setTimeout(() => {
        setExportProgress(null);
        setIsExporting(false);
      }, 1500);
    } catch (error: any) {
      setIsExporting(false);
      setExportProgress(null);
      toast.error(error.response?.data?.message || 'Failed to export document');
    }
  };

  return (
    <>
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex justify-between items-center">
        <div className="flex items-center space-x-3">
          <button onClick={onRefresh} className="btn btn-secondary text-sm">
            Refresh
          </button>
          <button
            onClick={() => setIsPretranslateModalOpen(true)}
            className="btn btn-primary text-sm"
          >
            Pretranslate
          </button>
          <div className="relative" ref={batchOptionsRef}>
            <button 
              onClick={() => setShowBatchOptions(!showBatchOptions)} 
              className="btn btn-secondary text-sm flex items-center gap-1"
            >
              Batch Translate
              <span className="text-xs">{showBatchOptions ? '▲' : '▼'}</span>
            </button>
            
            {showBatchOptions && (
              <div className="absolute left-0 mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50 p-4">
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Filter Segments:
                  </label>
                  <select
                    value={batchFilterMode}
                    onChange={(e) => setBatchFilterMode(e.target.value as any)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  >
                    <option value="empty">Empty segments only</option>
                    <option value="nonEmpty">Non-empty segments only</option>
                    <option value="nonConfirmed">Non-confirmed segments</option>
                    <option value="all">All segments</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-2">
                    {batchFilterMode === 'empty' && 'Only segments with no translation'}
                    {batchFilterMode === 'nonEmpty' && 'Only segments that already have translations'}
                    {batchFilterMode === 'nonConfirmed' && 'Segments that are not confirmed (NEW, MT, EDITED)'}
                    {batchFilterMode === 'all' && 'All segments in the document'}
                  </p>
                </div>
                
                <div className="flex gap-2">
                  <button
                    onClick={handleBatchTranslate}
                    className="btn btn-primary text-sm flex-1"
                  >
                    Start Batch Translate
                  </button>
                  <button
                    onClick={() => setShowBatchOptions(false)}
                    className="btn btn-secondary text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
          {selectedSegmentIds.length > 0 && (
            <>
              <span className="text-sm text-gray-600">
                {selectedSegmentIds.length} selected
              </span>
              <button
                onClick={async () => {
                  if (!onResetSegments) return;
                  try {
                    await segmentsApi.reset({ segmentIds: selectedSegmentIds });
                    toast.success(`Reset ${selectedSegmentIds.length} segment(s) to NEW status`);
                    onResetSegments(selectedSegmentIds);
                  } catch (error: any) {
                    toast.error(error.response?.data?.message || 'Failed to reset segments');
                  }
                }}
                className="btn btn-secondary text-sm"
              >
                Reset Selected to NEW
              </button>
            </>
          )}
          <button
            onClick={async () => {
              if (!onResetSegments) return;
              if (!confirm('Are you sure you want to reset ALL segments in this document to NEW status? This will clear all translations.')) {
                return;
              }
              try {
                await segmentsApi.reset({ documentId, resetAll: true });
                toast.success('All segments reset to NEW status');
                onResetSegments(null);
              } catch (error: any) {
                toast.error(error.response?.data?.message || 'Failed to reset all segments');
              }
            }}
            className="btn btn-secondary text-sm text-red-600 hover:text-red-700"
            title="Reset all segments in this document to NEW status (clears all translations)"
          >
            Reset All to NEW
          </button>
        </div>
      <div className="flex items-center space-x-3">
        <button
          onClick={() => handleDownload(false)}
          disabled={isExporting}
          className="btn btn-secondary text-sm disabled:opacity-50"
        >
          Download Original
        </button>
        <button
          onClick={() => handleDownload(true)}
          disabled={isExporting}
          className="btn btn-primary text-sm disabled:opacity-50 relative"
        >
          {isExporting && exportProgress ? (
            <span className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
              {exportProgress.message}
            </span>
          ) : (
            'Export Translated'
          )}
        </button>
        {exportProgress && exportProgress.stage !== 'complete' && (
          <div className="text-xs text-gray-600 max-w-xs">
            {exportProgress.message}
          </div>
        )}
      </div>
      </div>

      <PretranslateModal
        documentId={documentId}
        isOpen={isPretranslateModalOpen}
        onClose={() => setIsPretranslateModalOpen(false)}
        onComplete={async () => {
          // Explicitly refresh segments after pretranslate completes
          // onRefresh already invalidates cache and refetches, so we only need to call it once
          console.log('[EditorToolbar] Pretranslate completed, refreshing segments...');
          onRefresh();
          // Also call onBatchTranslate as a backup (it's just refetchSegments)
          // This ensures data is refreshed even if onRefresh has issues
          setTimeout(() => {
            onBatchTranslate();
          }, 1000);
        }}
        glossaryMode={glossaryMode}
      />
    </>
  );
}

