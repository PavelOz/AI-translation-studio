import { useState, useEffect, useRef, memo } from 'react';
import type { Segment } from '../../api/segments.api';
import { segmentsApi } from '../../api/segments.api';
import toast from 'react-hot-toast';
import AgentStepTranslation from './AgentStepTranslation';
import { stripFormattingMarkers, restoreFormattingMarkers, hasFormattingMarkers } from '../../utils/formatting';

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
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'SegmentEditor.tsx:41',message:'SegmentEditor useEffect triggered',data:{segmentId:segment.id,segmentChanged,hasTargetFinal:!!segment.targetFinal,hasTargetMt:!!segment.targetMt,newTargetText:newTargetText.substring(0,50),currentTargetText:targetText.substring(0,50),isEditing:isEditingRef.current,status:segment.status,targetFinal:segment.targetFinal?.substring(0,50),targetMt:segment.targetMt?.substring(0,50)},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    
    console.log('[SegmentEditor] Segment data update', {
      segmentId: segment.id,
      segmentChanged,
      hasTargetFinal: !!segment.targetFinal,
      hasTargetMt: !!segment.targetMt,
      newTargetText: newTargetText.substring(0, 50),
      currentTargetText: targetText.substring(0, 50),
      isEditing: isEditingRef.current,
      status: segment.status,
    });
    
    if (segmentChanged) {
      // New segment - always update
      lastSegmentIdRef.current = segment.id;
      isEditingRef.current = false;
      setTargetText(newTargetText);
      setLocalStatus(null); // Reset local status override
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'SegmentEditor.tsx:59',message:'Segment changed - updating text',data:{segmentId:segment.id,targetText:newTargetText.substring(0,50)},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      console.log('[SegmentEditor] Updated target text for new segment', {
        segmentId: segment.id,
        targetText: newTargetText.substring(0, 50),
      });
    } else if (!isEditingRef.current && newTargetText !== targetText) {
      // Same segment, but data changed and user is not editing - update from external source (e.g., TM apply)
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'SegmentEditor.tsx:69',message:'Updating text from external source',data:{segmentId:segment.id,oldText:targetText.substring(0,50),newText:newTargetText.substring(0,50),isEditing:isEditingRef.current},timestamp:Date.now(),runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      console.log('[SegmentEditor] Updating target text from external source', {
        segmentId: segment.id,
        oldText: targetText.substring(0, 50),
        newText: newTargetText.substring(0, 50),
      });
      setTargetText(newTargetText);
      setLocalStatus(null); // Reset local status override when external update happens
    } else {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'SegmentEditor.tsx:78',message:'No update - blocked',data:{segmentId:segment.id,reason:isEditingRef.current?'isEditing=true':'newTargetText===targetText',isEditing:isEditingRef.current,newTargetText:newTargetText.substring(0,50),currentTargetText:targetText.substring(0,50)},timestamp:Date.now(),runId:'run1',hypothesisId:'F'})}).catch(()=>{});
      // #endregion
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
    let textToSave = value ?? targetText;
    const currentText = segment.targetFinal || segment.targetMt || '';
    
    // If user edited text without markers, but original had markers, try to restore them
    if (value && !hasFormattingMarkers(value) && hasFormattingMarkers(currentText)) {
      // User edited text that had markers - try to restore markers based on source text
      textToSave = restoreFormattingMarkers(value, currentText, segment.sourceText);
    }
    
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
      setTargetText(textToSave); // Update state with saved text (may have restored markers)
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

    // If user edited text without markers, but original had markers, try to restore them
    let textToConfirm = targetText;
    const currentText = segment.targetFinal || segment.targetMt || '';
    if (!hasFormattingMarkers(targetText) && hasFormattingMarkers(currentText)) {
      textToConfirm = restoreFormattingMarkers(targetText, currentText, segment.sourceText);
    }

    setIsSaving(true);
    try {
      // Update via API
      await segmentsApi.update(segment.id, {
        targetFinal: textToConfirm.trim(),
        status: 'CONFIRMED',
      });
      // Update local state/cache through onUpdate callback to trigger cache invalidation
      onUpdate(segment.id, {
        targetFinal: textToConfirm.trim(),
        status: 'CONFIRMED',
      });
      setTargetText(textToConfirm); // Update state with confirmed text
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
  const isAutoPropagated = segment._meta?.autoPropagated ?? (typeof segment.fuzzyScore === 'number' && segment.fuzzyScore >= 1000);
  const withNumberReplacement = segment._meta?.differsOnlyByNumbers ?? (typeof segment.fuzzyScore === 'number' && segment.fuzzyScore >= 2000);
  const actualTmScore = isAutoPropagated && segment.fuzzyScore != null
    ? (withNumberReplacement ? segment.fuzzyScore - 2000 : segment.fuzzyScore - 1000)
    : segment.fuzzyScore;

  return (
    <div
      className={`border-2 rounded-lg p-4 transition-all ${statusBg} ${
        isAutoPropagated ? 'bg-purple-50/70 border-purple-200' : ''
      } ${
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
          {isAutoPropagated && (
            <>
              <span
                className="px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 border border-purple-300"
                title={actualTmScore != null ? `Auto-propagated from a similar segment (${actualTmScore}% similarity)` : 'Translation was auto-propagated from a confirmed similar segment'}
              >
                Auto-propagated
              </span>
              {withNumberReplacement && (
                <span
                  className="px-2 py-0.5 rounded text-xs font-medium bg-purple-200 text-purple-900 border border-purple-400"
                  title="Numbers/dates were substituted for this segment"
                >
                  🔢 Numbers
                </span>
              )}
            </>
          )}
          {!isAutoPropagated && actualTmScore != null && (
            <span className="text-xs text-gray-500">TM: {actualTmScore}%</span>
          )}
        </div>
        {isSaving && <span className="text-xs text-gray-500">Saving...</span>}
      </div>

      <div className="mb-3">
        <label className="text-sm font-medium text-gray-700 mb-1 block">Source:</label>
        <div className="bg-gray-50 border border-gray-200 rounded p-3 text-gray-900 whitespace-pre-wrap">
          {stripFormattingMarkers(segment.sourceText)}
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Target:</label>
        <textarea
          ref={textareaRef}
          value={stripFormattingMarkers(targetText)}
          onChange={(e) => {
            // When user edits text without markers, we need to preserve the original markers
            // if the original text had them. We'll store the edited text and try to restore
            // markers on save if the original had them.
            const editedText = e.target.value;
            // Store the edited text - if original had markers, we'll try to restore them on save
            handleChange(editedText);
          }}
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
          className="input w-full min-h-[100px] font-medium whitespace-pre-wrap"
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

