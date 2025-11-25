import { useState, useEffect, useRef, memo } from 'react';
import type { Segment } from '../../api/segments.api';
import { segmentsApi } from '../../api/segments.api';
import toast from 'react-hot-toast';
import AgentStepTranslation from './AgentStepTranslation';

interface SegmentEditorProps {
  segment: Segment;
  isActive: boolean;
  onUpdate: (segmentId: string, updates: Partial<Segment>) => void;
  onNext: () => void;
  onPrevious: () => void;
  onConfirm: () => void;
  sourceLocale?: string;
  targetLocale?: string;
  projectId?: string;
}

const SegmentEditor = memo(function SegmentEditor({
  segment,
  isActive,
  onUpdate,
  onNext,
  onPrevious,
  onConfirm,
  sourceLocale,
  targetLocale,
  projectId,
}: SegmentEditorProps) {
  const [targetText, setTargetText] = useState(segment.targetFinal || segment.targetMt || '');
  const [isSaving, setIsSaving] = useState(false);
  const [localStatus, setLocalStatus] = useState<Segment['status'] | null>(null); // Local status override for immediate UI feedback
  const [isAgentModalOpen, setIsAgentModalOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout>();
  const isEditingRef = useRef(false); // Track if user is actively editing
  const lastSegmentIdRef = useRef(segment.id);
  const isButtonClickRef = useRef(false); // Track if a button is being clicked

  useEffect(() => {
    // Only update target text if:
    // 1. Segment ID changed (different segment), OR
    // 2. Segment data changed AND user is not actively editing
    const segmentChanged = lastSegmentIdRef.current !== segment.id;
    const newTargetText = segment.targetFinal || segment.targetMt || '';
    
    if (segmentChanged) {
      // New segment - always update
      lastSegmentIdRef.current = segment.id;
      isEditingRef.current = false;
      setTargetText(newTargetText);
      setLocalStatus(null); // Reset local status override
    } else if (!isEditingRef.current && newTargetText !== targetText) {
      // Same segment, but data changed and user is not editing - update from external source (e.g., TM apply)
      setTargetText(newTargetText);
      setLocalStatus(null); // Reset local status override when external update happens
    }
  }, [segment.id, segment.targetFinal, segment.targetMt, segment.status]);

  useEffect(() => {
    // Only auto-focus if segment changed, not on every isActive change
    if (isActive && textareaRef.current && lastSegmentIdRef.current === segment.id) {
      // Only focus if not already focused and user is not actively editing
      if (document.activeElement !== textareaRef.current && !isEditingRef.current) {
        textareaRef.current.focus();
      }
    }
  }, [isActive, segment.id]);

  const handleChange = (value: string) => {
    isEditingRef.current = true; // Mark as actively editing
    setTargetText(value);
    
    // Update status optimistically to "EDITED" immediately when user starts editing
    // This provides immediate visual feedback
    const currentText = segment.targetFinal || segment.targetMt || '';
    if (value.trim() && value !== currentText && segment.status !== 'CONFIRMED') {
      setLocalStatus('EDITED');
    }
    
    // Auto-save after 2 seconds of inactivity (increased to reduce interruptions)
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    saveTimeoutRef.current = setTimeout(() => {
      handleSave(value);
      isEditingRef.current = false; // Reset after save
    }, 2000); // Increased from 1 second to 2 seconds
  };

  const handleSave = async (value?: string) => {
    const textToSave = value ?? targetText;
    const currentText = segment.targetFinal || segment.targetMt || '';
    
    // Only save if there are actual changes
    if (textToSave === currentText) {
      isEditingRef.current = false;
      return; // No changes
    }

    setIsSaving(true);
    try {
      const status = textToSave.trim() ? 'EDITED' : segment.status;
      await segmentsApi.update(segment.id, {
        targetFinal: textToSave.trim() || undefined,
        status: status as any,
      });
      onUpdate(segment.id, { targetFinal: textToSave, status: status as any });
      setLocalStatus(null); // Clear local status override after successful save
      isEditingRef.current = false; // Reset after successful save
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to save segment');
      // Keep isEditingRef as true on error so user can continue editing
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+Enter or Cmd+Enter to confirm
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
    // Ctrl+ArrowDown or Tab to next
    else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown') {
      e.preventDefault();
      onNext();
    }
    // Ctrl+ArrowUp to previous
    else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp') {
      e.preventDefault();
      onPrevious();
    }
  };

  const handleConfirm = async () => {
    if (!targetText.trim()) {
      toast.error('Please enter a translation before confirming');
      return;
    }

    setIsSaving(true);
    try {
      // Update via API
      await segmentsApi.update(segment.id, {
        targetFinal: targetText.trim(),
        status: 'CONFIRMED',
      });
      // Update local state/cache through onUpdate callback to trigger cache invalidation
      onUpdate(segment.id, {
        targetFinal: targetText.trim(),
        status: 'CONFIRMED',
      });
      // Move to next segment
      onConfirm();
      toast.success('Segment confirmed');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to confirm segment');
    } finally {
      setIsSaving(false);
    }
  };

  // Use local status if set, otherwise use segment status
  const displayStatus = localStatus || segment.status;

  const getStatusColor = () => {
    switch (displayStatus) {
      case 'CONFIRMED':
        return 'bg-green-100 text-green-800 border-green-300';
      case 'EDITED':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'MT':
        return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const getStatusBackground = () => {
    switch (displayStatus) {
      case 'CONFIRMED':
        return 'bg-green-50'; // Pastel green
      case 'EDITED':
        return 'bg-blue-50'; // Pastel blue
      case 'MT':
        return 'bg-yellow-50'; // Pastel yellow
      default:
        return 'bg-white'; // Default white
    }
  };

  const statusBg = getStatusBackground();
  
  return (
    <div
      className={`border-2 rounded-lg p-4 transition-all ${statusBg} ${
        isActive
          ? 'border-primary-500 shadow-md'
          : 'border-gray-200 hover:border-gray-300'
      }`}
    >
      <div className="flex justify-between items-center mb-3 segment-header">
        <div className="flex items-center space-x-2 flex-wrap gap-1">
          <span className="text-sm font-medium text-gray-500">Segment #{segment.segmentIndex}</span>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200">
            {segment.segmentType === 'table-cell' ? '📊 Table Cell' : 
             segment.segmentType === 'cell' ? '📋 Cell' :
             segment.segmentType === 'unit' ? '📄 Unit' :
             segment.segmentType === 'paragraph' ? '📝 Paragraph' :
             segment.segmentType || '📝 Paragraph'}
          </span>
          <span className={`px-2 py-1 rounded text-xs font-medium border ${getStatusColor()}`}>
            {displayStatus}
          </span>
          {segment.fuzzyScore && (
            <span className="text-xs text-gray-500">TM: {segment.fuzzyScore}%</span>
          )}
        </div>
        {isSaving && <span className="text-xs text-gray-500">Saving...</span>}
      </div>

      <div className="mb-3">
        <label className="text-sm font-medium text-gray-700 mb-1 block">Source:</label>
        <div className="bg-gray-50 border border-gray-200 rounded p-3 text-gray-900 whitespace-pre-wrap">
          {segment.sourceText}
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Target:</label>
        <textarea
          ref={textareaRef}
          value={targetText}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={(e) => {
            // Don't save if a button is being clicked
            if (isButtonClickRef.current) {
              isButtonClickRef.current = false;
              return;
            }
            // Save on blur only if it's a real blur (not caused by button click)
            handleSave();
          }}
          className="input w-full min-h-[100px] font-medium"
          placeholder="Enter translation..."
        />
        <div className="mt-2 flex justify-between items-center">
          <div className="text-xs text-gray-500">
            Word count: {targetText.trim() ? targetText.trim().split(/\s+/).filter(Boolean).length : 0} | 
            Characters: {targetText.length}
          </div>
          <div className="flex space-x-2">
            <button
              type="button"
              onMouseDown={(e) => {
                // Set flag before blur event fires
                isButtonClickRef.current = true;
                e.preventDefault(); // Prevent textarea blur
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                isButtonClickRef.current = false; // Reset flag
                handleSave();
              }}
              disabled={isSaving}
              className="btn btn-secondary text-sm"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onMouseDown={(e) => {
                // Set flag before blur event fires
                isButtonClickRef.current = true;
                e.preventDefault(); // Prevent textarea blur
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                isButtonClickRef.current = false; // Reset flag
                handleConfirm();
              }}
              disabled={isSaving || !targetText.trim()}
              className="btn btn-primary text-sm"
            >
              Confirm
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-between items-center">
        <div className="text-xs text-gray-500">
          <kbd className="px-1 py-0.5 bg-gray-100 rounded">Ctrl+Enter</kbd> to confirm | 
          <kbd className="px-1 py-0.5 bg-gray-100 rounded ml-1">Ctrl+↓</kbd> next | 
          <kbd className="px-1 py-0.5 bg-gray-100 rounded ml-1">Ctrl+↑</kbd> previous
        </div>
        {isActive && (
          <button
            type="button"
            onClick={() => setIsAgentModalOpen(true)}
            className="text-xs px-3 py-1.5 bg-purple-100 text-purple-700 hover:bg-purple-200 rounded-md transition-colors font-medium"
            title="Open Deep Agent Debugger"
          >
            🔍 Deep Agent Debugger
          </button>
        )}
      </div>

      {/* Agent Step Translation Modal */}
      {isAgentModalOpen && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            // Close modal when clicking outside
            if (e.target === e.currentTarget) {
              setIsAgentModalOpen(false);
            }
          }}
        >
          <div 
            className="w-full max-w-4xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <AgentStepTranslation
              sourceText={segment.sourceText}
              projectId={projectId}
              sourceLocale={sourceLocale}
              targetLocale={targetLocale}
              onComplete={async (finalText) => {
                // Save the final translation to the segment
                setIsSaving(true);
                try {
                  await segmentsApi.update(segment.id, {
                    targetFinal: finalText,
                    status: 'EDITED',
                  });
                  onUpdate(segment.id, {
                    targetFinal: finalText,
                    status: 'EDITED',
                  });
                  setTargetText(finalText);
                  setIsAgentModalOpen(false);
                  toast.success('Translation saved successfully');
                } catch (error: any) {
                  toast.error(error.response?.data?.message || 'Failed to save translation');
                } finally {
                  setIsSaving(false);
                }
              }}
              onCancel={() => setIsAgentModalOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison to prevent unnecessary re-renders
  // Only re-render if segment ID changed, isActive changed, or segment data changed
  return (
    prevProps.segment.id === nextProps.segment.id &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.segment.targetFinal === nextProps.segment.targetFinal &&
    prevProps.segment.targetMt === nextProps.segment.targetMt &&
    prevProps.segment.status === nextProps.segment.status &&
    prevProps.sourceLocale === nextProps.sourceLocale &&
    prevProps.targetLocale === nextProps.targetLocale &&
    prevProps.projectId === nextProps.projectId
  );
});

export default SegmentEditor;

