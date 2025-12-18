import { useState } from 'react';
import { documentsApi } from '../../api/documents.api';
import apiClient from '../../api/client';
import toast from 'react-hot-toast';
import PretranslateModal from './PretranslateModal';
import type { GlossaryMode } from '../../types/glossary';

interface EditorToolbarProps {
  documentId: string;
  selectedSegmentIds: string[];
  onRefresh: () => void;
  onBatchTranslate: () => void;
  glossaryMode?: GlossaryMode;
}

export default function EditorToolbar({
  documentId,
  selectedSegmentIds,
  onRefresh,
  onBatchTranslate,
  glossaryMode = 'strict_source',
}: EditorToolbarProps) {
  const [isPretranslateModalOpen, setIsPretranslateModalOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{
    stage: 'preparing' | 'downloading' | 'processing' | 'complete';
    message: string;
  } | null>(null);
  const handleBatchTranslate = async () => {
    try {
      const response = await documentsApi.batchTranslate(documentId, {
        mode: 'pre_translate',
        applyTm: true,
        minScore: 70,
        mtOnlyEmpty: true,
        glossaryMode, // Pass glossary mode to API
      });
      toast.success(`Batch translation started: ${response.processed} segments processed`);
      onBatchTranslate();
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
          <button onClick={handleBatchTranslate} className="btn btn-secondary text-sm">
            Batch Translate
          </button>
          {selectedSegmentIds.length > 0 && (
            <span className="text-sm text-gray-600">
              {selectedSegmentIds.length} selected
            </span>
          )}
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
        onComplete={() => {
          onRefresh();
          onBatchTranslate();
        }}
        glossaryMode={glossaryMode}
      />
    </>
  );
}

