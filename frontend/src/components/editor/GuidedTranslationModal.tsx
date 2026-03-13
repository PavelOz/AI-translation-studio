import { useState, useEffect } from 'react';
import { useQuery } from 'react-query';
import { documentsApi } from '../../api/documents.api';
import { analysisApi } from '../../api/analysis.api';
import { glossaryApi } from '../../api/glossary.api';
import { segmentsApi } from '../../api/segments.api';
import toast from 'react-hot-toast';
import type { GlossaryMode } from '../../types/glossary';

const STEPS = [
  'Context for this document',
  'Document DNA',
  'Document glossary',
  'What the AI will receive (sample segment)',
  'Run translation',
];

interface GuidedTranslationModalProps {
  documentId: string;
  isOpen: boolean;
  onClose: () => void;
  onComplete?: () => void;
  initialSegmentId?: string | null;
  glossaryMode?: GlossaryMode;
}

export default function GuidedTranslationModal({
  documentId,
  isOpen,
  onClose,
  onComplete,
  initialSegmentId = null,
  glossaryMode = 'strict_source',
}: GuidedTranslationModalProps) {
  const [step, setStep] = useState(0);
  const [isTranslating, setIsTranslating] = useState(false);

  const { data: document, isLoading: docLoading } = useQuery(
    ['document', documentId],
    () => documentsApi.get(documentId),
    { enabled: isOpen && !!documentId, staleTime: 60000 }
  );

  const { data: dna, isLoading: dnaLoading } = useQuery(
    ['document-dna', documentId],
    () => analysisApi.getDocumentDna(documentId),
    { enabled: isOpen && !!documentId && step >= 1, staleTime: 0, retry: false }
  );

  const { data: docGlossary = [], isLoading: glossaryLoading } = useQuery(
    ['glossary', documentId],
    async () => {
      try {
        return await glossaryApi.getGlossary(documentId);
      } catch (err: any) {
        if (err?.response?.status === 404) return [];
        throw err;
      }
    },
    { enabled: isOpen && !!documentId && step >= 2, staleTime: 0 }
  );

  const { data: firstPage } = useQuery(
    ['segments-list', documentId],
    () => segmentsApi.list(documentId, 1, 1),
    { enabled: isOpen && !!documentId && step >= 3 && !initialSegmentId }
  );

  const sampleSegmentId = initialSegmentId || firstPage?.segments?.[0]?.id || null;

  const { data: debugInfo, isLoading: debugLoading } = useQuery(
    ['segment-debug', sampleSegmentId],
    () => (sampleSegmentId ? segmentsApi.getDebugInfo(sampleSegmentId) : null),
    { enabled: isOpen && !!sampleSegmentId && step >= 3 }
  );

  useEffect(() => {
    if (!isOpen) {
      setStep(0);
      setIsTranslating(false);
    }
  }, [isOpen]);

  const handleNext = () => {
    if (step < STEPS.length - 1) setStep((s) => s + 1);
  };

  const handleBack = () => {
    if (step > 0) setStep((s) => s - 1);
  };

  const handleStartTranslation = async () => {
    setIsTranslating(true);
    try {
      await documentsApi.pretranslate(documentId, {
        applyAiToEmptyOnly: true,
        applyAiToLowMatches: false,
        glossaryMode,
      });
      toast.success('Translation started. Progress will appear in the editor.');
      onComplete?.();
      onClose();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to start translation');
    } finally {
      setIsTranslating(false);
    }
  };

  if (!isOpen) return null;

  const dnaSummary =
    dna && typeof dna.abbreviationLogic === 'object' && dna.abbreviationLogic
      ? Object.keys(dna.abbreviationLogic).length
      : 0;
  const namingCount =
    dna && typeof dna.namingConventions === 'object' && dna.namingConventions
      ? Object.keys(dna.namingConventions).length
      : 0;
  const promptPreview = debugInfo?.prompt ? debugInfo.prompt.slice(0, 500) + (debugInfo.prompt.length > 500 ? '…' : '') : '';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-lg w-full mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900">Guide: How translation works</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="text-xs text-gray-500 mb-2">
          Step {step + 1} of {STEPS.length}
        </div>
        <div className="w-full bg-gray-200 rounded-full h-1.5 mb-4">
          <div
            className="bg-primary-600 h-1.5 rounded-full transition-all"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        <div className="min-h-0 overflow-y-auto flex-1 space-y-4">
          <h3 className="font-semibold text-gray-800">{STEPS[step]}</h3>

          {step === 0 && (
            <>
              <p className="text-sm text-gray-600">
                Translation uses Document DNA and the document glossary so the AI keeps your terms and style. Here is the context for this document.
              </p>
              {docLoading ? (
                <p className="text-sm text-gray-500">Loading document…</p>
              ) : document ? (
                <div className="p-3 bg-gray-50 rounded border border-gray-200 text-sm">
                  <p><strong>Document:</strong> {document.name}</p>
                  <p><strong>Direction:</strong> {document.sourceLocale} → {document.targetLocale}</p>
                </div>
              ) : null}
            </>
          )}

          {step === 1 && (
            <>
              <p className="text-sm text-gray-600">
                Document DNA is the project knowledge (abbreviations, naming conventions). It is included in the prompt sent to the AI.
              </p>
              {dnaLoading ? (
                <p className="text-sm text-gray-500">Loading DNA…</p>
              ) : dna ? (
                <div className="p-3 bg-gray-50 rounded border border-gray-200 text-sm">
                  <p><strong>DNA:</strong> Loaded</p>
                  <p>{dnaSummary} abbreviation(s), {namingCount} naming rule(s).</p>
                </div>
              ) : (
                <div className="p-3 bg-amber-50 rounded border border-amber-200 text-sm text-amber-800">
                  <p><strong>DNA:</strong> Not generated.</p>
                  <p className="mt-1">Generate it from the Analysis sidebar (Document DNA → Regenerate) so the AI can use your terminology.</p>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-sm text-gray-600">
                Only terms from the <strong>document glossary</strong> are sent to the translator. Project glossary terms appear here after you run Analysis (or when they are added to this document).
              </p>
              {glossaryLoading ? (
                <p className="text-sm text-gray-500">Loading glossary…</p>
              ) : (
                <div className="p-3 bg-gray-50 rounded border border-gray-200 text-sm">
                  <p><strong>Document glossary:</strong> {docGlossary.length} term(s).</p>
                  {docGlossary.length === 0 && (
                    <p className="mt-2 text-amber-700">Tip: Run Analysis or add terms to the document glossary to see them here. Then they will be used when you translate.</p>
                  )}
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <p className="text-sm text-gray-600">
                For each segment, the app picks glossary terms that appear in that segment and builds a prompt. Here is a preview for one segment.
              </p>
              {!sampleSegmentId ? (
                <p className="text-sm text-gray-500">No segment available. Add content to the document first.</p>
              ) : debugLoading ? (
                <p className="text-sm text-gray-500">Loading segment context…</p>
              ) : debugInfo ? (
                <>
                  <div className="p-3 bg-gray-50 rounded border border-gray-200 text-sm space-y-2">
                    <p><strong>Sample segment #{debugInfo.segment.segmentIndex + 1}:</strong></p>
                    <p className="text-gray-600 truncate max-w-full" title={debugInfo.segment.sourceText}>
                      {debugInfo.segment.sourceText.slice(0, 80)}{debugInfo.segment.sourceText.length > 80 ? '…' : ''}
                    </p>
                    <p><strong>Glossary terms for this segment:</strong></p>
                    {debugInfo.glossaryTerms.length === 0 ? (
                      <p className="text-gray-500">None.</p>
                    ) : (
                      <ul className="list-disc pl-4 text-gray-700">
                        {debugInfo.glossaryTerms.slice(0, 10).map((t, i) => (
                          <li key={i}>{t.sourceTerm} → {t.targetTerm}</li>
                        ))}
                        {debugInfo.glossaryTerms.length > 10 && (
                          <li className="text-gray-500">… and {debugInfo.glossaryTerms.length - 10} more</li>
                        )}
                      </ul>
                    )}
                    <p><strong>Prompt preview:</strong></p>
                    <pre className="text-xs bg-white p-2 rounded border border-gray-200 overflow-auto max-h-32 whitespace-pre-wrap">
                      {promptPreview || '—'}
                    </pre>
                  </div>
                </>
              ) : null}
            </>
          )}

          {step === 4 && (
            <>
              <p className="text-sm text-gray-600">
                Translation will be sent to the AI using the same process as the main Pretranslate button. You will see the result in the editor and can track progress there.
              </p>
              <div className="p-3 bg-blue-50 rounded border border-blue-200 text-sm">
                <p>Ready. Click &quot;Start translation&quot; below to run pretranslation (same as the main Pretranslate action).</p>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-between mt-4 pt-4 border-t border-gray-200">
          <div>
            {step > 0 ? (
              <button type="button" onClick={handleBack} className="btn btn-secondary">
                Back
              </button>
            ) : (
              <span />
            )}
          </div>
          <div className="flex gap-2">
            {step < STEPS.length - 1 ? (
              <button type="button" onClick={handleNext} className="btn btn-primary">
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStartTranslation}
                disabled={isTranslating}
                className="btn btn-primary"
              >
                {isTranslating ? 'Starting…' : 'Start translation'}
              </button>
            )}
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
