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
    try {
      const doc = await documentsApi.get(documentId);
      const blob = await documentsApi.download(documentId, exportFile);
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
      toast.success('Download started');
    } catch (error: any) {
      toast.error('Failed to download document');
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
          className="btn btn-secondary text-sm"
        >
          Download Original
        </button>
        <button
          onClick={() => handleDownload(true)}
          className="btn btn-primary text-sm"
        >
          Export Translated
        </button>
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

