import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { analysisApi } from '../api/analysis.api';
import type { DocumentDnaPayload } from '../api/analysis.api';
import toast from 'react-hot-toast';

type Props = {
  documentId: string;
};

const DNA_SECTIONS = ['abbreviationLogic', 'namingConventions', 'technicalSchema', 'entityGroups'] as const;
type DnaSection = (typeof DNA_SECTIONS)[number];

/** Infer which DNA JSON section an issue likely refers to (for copy-paste guidance). */
function suggestDnaSection(message: string, suggestion?: string): DnaSection {
  const text = `${message} ${suggestion ?? ''}`.toLowerCase();
  if (/\b(shortform|longform|abbreviation|аббревиатур|ключ|глоссари|key\s*["'])/i.test(text)) return 'abbreviationLogic';
  if (/\b(naming|regex|pattern|convention|правил)/i.test(text)) return 'namingConventions';
  if (/\b(technical|schema|схем)/i.test(text)) return 'technicalSchema';
  if (/\b(entity|group|групп)/i.test(text)) return 'entityGroups';
  return 'abbreviationLogic';
}

/**
 * Extract only the pasteable JSON from a suggestion (strip "Добавьте:", "Add:", etc.).
 * Returns text that can be pasted into the DNA JSON section.
 */
function suggestedCopyText(message: string, suggestion?: string): string {
  const raw = (suggestion && suggestion.trim()) ? suggestion.trim() : message.trim();
  // Strip instruction prefix (e.g. "Добавьте: ", "Add: ", "Измените ... на ")
  let out = raw
    .replace(/^(Добавьте|Add|Add the following|Измените)[:\s]+/i, '')
    .replace(/^[^"{\[]*:\s*/, '') // strip "Something: " before JSON
    .trim();
  // If we have something like "key": { ... }, extract it (first quoted key through matching })
  const keyObjMatch = out.match(/^("[^"]+")\s*:\s*(\{[\s\S]*\})/);
  if (keyObjMatch) {
    const keyPart = keyObjMatch[1];
    let braceCount = 0;
    let i = keyObjMatch[2].indexOf('{');
    for (; i < keyObjMatch[2].length; i++) {
      if (keyObjMatch[2][i] === '{') braceCount++;
      if (keyObjMatch[2][i] === '}') {
        braceCount--;
        if (braceCount === 0) break;
      }
    }
    const objPart = i >= 0 ? keyObjMatch[2].slice(0, i + 1) : keyObjMatch[2];
    out = `${keyPart}: ${objPart}`;
  }
  return out.trim() || raw;
}

/**
 * Parse suggested copy text into a single key-value for merging into a DNA section.
 * Returns { key, value } or null if not parseable.
 */
function parseSuggestionEntry(copyText: string): { key: string; value: unknown } | null {
  const trimmed = copyText.trim();
  if (!trimmed) return null;
  try {
    const wrapped = trimmed.startsWith('{') ? trimmed : `{${trimmed}}`;
    const parsed = JSON.parse(wrapped) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (keys.length === 1) return { key: keys[0], value: parsed[keys[0]] };
    if (keys.length > 1) return { key: keys[0], value: parsed[keys[0]] };
    return null;
  } catch {
    return null;
  }
}

export default function DnaValidationPanel({ documentId }: Props) {
  const queryClient = useQueryClient();
  const [editModalOpen, setEditModalOpen] = useState(false);

  const { data: validation, isLoading, refetch } = useQuery({
    queryKey: ['dna-validation', documentId],
    queryFn: () => analysisApi.validateDocumentDna(documentId),
    enabled: !!documentId,
    retry: false,
  });

  const { data: dnaForEdit, isLoading: dnaLoading } = useQuery({
    queryKey: ['document-dna', documentId],
    queryFn: () => analysisApi.getDocumentDna(documentId),
    enabled: !!documentId && editModalOpen,
    staleTime: 0,
  });

  const [editJsonText, setEditJsonText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  /** Per-issue editable suggestion text (so you can edit before "Add to DNA"). */
  const [suggestionEdits, setSuggestionEdits] = useState<Record<string, string>>({});
  /** Issue IDs optimistically hidden after "Add to DNA"; cleared when validation refetches. */
  const [appliedSuggestionIds, setAppliedSuggestionIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (editModalOpen && dnaForEdit) {
      setEditJsonText(JSON.stringify(dnaForEdit, null, 2));
      setParseError(null);
    }
  }, [editModalOpen, dnaForEdit]);

  // When validation data updates (e.g. after refetch), clear optimistic hides so list reflects server
  useEffect(() => {
    setAppliedSuggestionIds(new Set());
  }, [validation?.contractValidation]);

  const updateDnaMutation = useMutation({
    mutationFn: (payload: DocumentDnaPayload) =>
      analysisApi.updateDocumentDna(documentId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dna-validation', documentId] });
      queryClient.invalidateQueries({ queryKey: ['document-dna', documentId] });
      setEditModalOpen(false);
      setSuggestionEdits({});
      setAppliedSuggestionIds(new Set());
      refetch();
      toast.success('DNA updated. Validation will refresh.');
    },
    onError: (err: any) => {
      const data = err?.response?.data;
      const msg = data?.error || err?.message || 'Failed to update DNA';
      const details = Array.isArray(data?.details) ? data.details : [];
      toast.error(details.length ? `${msg}: ${details.join('; ')}` : msg);
    },
  });

  /** Apply a single suggestion into DNA and refetch (modal stays open; issue may disappear from list). */
  const applySuggestionMutation = useMutation({
    mutationFn: (payload: DocumentDnaPayload) =>
      analysisApi.updateDocumentDna(documentId, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dna-validation', documentId] });
      queryClient.invalidateQueries({ queryKey: ['document-dna', documentId] });
      refetch();
      setEditJsonText(JSON.stringify(variables, null, 2));
      toast.success('Suggestion applied to DNA. List will refresh.');
    },
    onError: (err: any) => {
      const data = err?.response?.data;
      const msg = data?.error || err?.message || 'Failed to apply suggestion';
      const details = Array.isArray(data?.details) ? data.details : [];
      toast.error(details.length ? `${msg}: ${details.join('; ')}` : msg);
    },
  });

  const handleAddSuggestionToDna = (section: DnaSection, copyText: string) => {
    const entry = parseSuggestionEntry(copyText);
    if (!entry) {
      toast.error('Could not parse suggestion as JSON. Use Copy and paste into the DNA JSON.');
      return;
    }
    const key = typeof entry.key === 'string' ? entry.key.trim() : String(entry.key).trim();
    if (!key) {
      toast.error('Entry key is empty after trimming. Use a non-empty key.');
      return;
    }
    // Normalize abbreviationLogic value to { longForm, shortForm } so backend accepts it
    let value: unknown = entry.value;
    if (section === 'abbreviationLogic' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const o = value as Record<string, unknown>;
      const long = (o.longForm ?? o.value ?? ''); const short = (o.shortForm ?? o.longForm ?? o.value ?? '');
      const l = typeof long === 'string' ? long.trim() : ''; const s = typeof short === 'string' ? short.trim() : l;
      value = { longForm: l || s, shortForm: s || l };
    }
    const current = dnaForEdit ?? {};
    const sectionKey = section as keyof DocumentDnaPayload;
    const currentSection = (current[sectionKey] && typeof current[sectionKey] === 'object' && !Array.isArray(current[sectionKey]))
      ? (current[sectionKey] as Record<string, unknown>)
      : {};
    const merged: DocumentDnaPayload = {
      ...current,
      [sectionKey]: { ...currentSection, [key]: value },
    };
    applySuggestionMutation.mutate(merged);
  };

  const handleSaveDna = () => {
    setParseError(null);
    try {
      const parsed = JSON.parse(editJsonText) as DocumentDnaPayload;
      if (typeof parsed !== 'object' || parsed === null) {
        setParseError('DNA must be a JSON object.');
        return;
      }
      const payload: DocumentDnaPayload = {
        technicalSchema: parsed.technicalSchema ?? null,
        namingConventions: parsed.namingConventions ?? null,
        abbreviationLogic: parsed.abbreviationLogic ?? null,
        entityGroups: parsed.entityGroups ?? null,
      };
      updateDnaMutation.mutate(payload);
    } catch (e) {
      setParseError((e as Error).message || 'Invalid JSON');
    }
  };

  if (isLoading) {
    return (
      <div className="mt-3 p-2 bg-gray-50 border border-gray-200 rounded text-xs">
        <p className="text-gray-600">Validating DNA...</p>
      </div>
    );
  }

  if (!validation) {
    return null;
  }

  const contractValidation = validation.contractValidation;

  if (!contractValidation) {
    // Базовая валидация
    if (!validation.valid) {
      return (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-xs">
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-red-600 font-semibold">✗ Validation Failed</span>
            </div>
            <button
              onClick={() => refetch()}
              className="text-red-600 hover:text-red-800 underline"
            >
              Refresh
            </button>
          </div>
          <ul className="list-disc list-inside space-y-1 text-red-700">
            {validation.errors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        </div>
      );
    }
    return (
      <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded text-xs">
        <div className="flex items-center justify-between">
          <span className="text-green-700 font-medium">✓ DNA is valid</span>
          <button
            onClick={() => refetch()}
            className="text-green-600 hover:text-green-800 underline"
          >
            Refresh
          </button>
        </div>
        <p className="text-green-600 mt-1">
          {validation.abbreviationCount} abbreviation{validation.abbreviationCount !== 1 ? 's' : ''} defined
        </p>
      </div>
    );
  }

  // Расширенная валидация (DNA-Contract-Validator)
  const errors = contractValidation.issues.filter(i => i.type === 'error');
  const warnings = contractValidation.issues.filter(i => i.type === 'warning');

  return (
    <div className="mt-3 space-y-2">
      {/* Статус валидации */}
      <div
        className={`p-3 rounded border ${
          contractValidation.status === 'ERROR'
            ? 'bg-red-50 border-red-200'
            : contractValidation.status === 'WARNING'
              ? 'bg-amber-50 border-amber-200'
              : 'bg-green-50 border-green-200'
        }`}
      >
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            {contractValidation.status === 'ERROR' && (
              <span className="text-red-600 font-semibold">✗ Validation Failed</span>
            )}
            {contractValidation.status === 'WARNING' && (
              <span className="text-amber-700 font-semibold">⚠ Validation Warnings</span>
            )}
            {contractValidation.status === 'OK' && (
              <span className="text-green-700 font-semibold">✓ All Checks Passed</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {(warnings.length > 0 || errors.length > 0) && (
              <button
                type="button"
                onClick={() => setEditModalOpen(true)}
                className="text-xs font-medium px-2 py-1 rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
              >
                Edit DNA and fix
              </button>
            )}
            <button
              onClick={() => refetch()}
              className={`text-xs underline ${
                contractValidation.status === 'ERROR'
                  ? 'text-red-600 hover:text-red-800'
                  : contractValidation.status === 'WARNING'
                    ? 'text-amber-600 hover:text-amber-800'
                    : 'text-green-600 hover:text-green-800'
              }`}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Ошибки */}
        {errors.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-red-800 mb-1">Errors (blocking translation):</p>
            <ul className="space-y-1">
              {errors.map((error, i) => (
                <li key={i} className="text-xs text-red-700">
                  <div className="flex items-start gap-1">
                    <span className="text-red-500 mt-0.5">•</span>
                    <div className="flex-1">
                      <p>{error.message}</p>
                      {error.suggestion && (
                        <p className="text-red-600 mt-0.5 italic">→ {error.suggestion}</p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Предупреждения */}
        {warnings.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-amber-800 mb-1">Warnings (recommended fixes):</p>
            <ul className="space-y-1">
              {warnings.map((warning, i) => (
                <li key={i} className="text-xs text-amber-700">
                  <div className="flex items-start gap-1">
                    <span className="text-amber-500 mt-0.5">•</span>
                    <div className="flex-1">
                      <p>{warning.message}</p>
                      {warning.suggestion && (
                        <p className="text-amber-600 mt-0.5 italic">→ {warning.suggestion}</p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Успешная валидация */}
        {contractValidation.status === 'OK' && (
          <p className="text-green-700 text-xs">
            All validation checks passed. DNA is ready for translation.
          </p>
        )}

        {/* Рекомендации */}
        {contractValidation.suggestions.length > 0 && (
          <details className="mt-2">
            <summary className="text-xs font-medium cursor-pointer text-gray-700 hover:text-gray-900">
              View all suggestions ({contractValidation.suggestions.length})
            </summary>
            <ul className="mt-2 space-y-1 pl-4">
              {contractValidation.suggestions.map((suggestion, i) => (
                <li key={i} className="text-xs text-gray-600">• {suggestion}</li>
              ))}
            </ul>
          </details>
        )}

        {/* Детальный отчет */}
        <details className="mt-2">
          <summary className="text-xs font-medium cursor-pointer text-gray-700 hover:text-gray-900">
            View detailed report
          </summary>
          <pre className="mt-2 p-2 bg-white border border-gray-200 rounded text-xs font-mono whitespace-pre-wrap overflow-auto max-h-48">
            {contractValidation.report}
          </pre>
        </details>
      </div>

      {/* Edit DNA modal */}
      {editModalOpen && validation?.contractValidation && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-3 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Edit DNA and fix warnings</h3>
              <button
                type="button"
                onClick={() => {
                  setEditModalOpen(false);
                  setSuggestionEdits({});
                  setAppliedSuggestionIds(new Set());
                }}
                className="text-gray-500 hover:text-gray-700 text-xl leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs space-y-4">
                <p className="font-medium text-amber-900">Validation issues to address:</p>
                {[...errors.map((err, i) => ({ ...err, id: `e-${i}`, isError: true })), ...warnings.map((w, i) => ({ ...w, id: `w-${i}`, isError: false }))]
                  .filter((issue) => !appliedSuggestionIds.has(issue.id))
                  .map((issue) => {
                  const section = suggestDnaSection(issue.message, issue.suggestion);
                  const defaultText = suggestedCopyText(issue.message, issue.suggestion);
                  const editableText = suggestionEdits[issue.id] ?? defaultText;
                  return (
                    <div
                      key={issue.id}
                      className={`rounded border p-2.5 ${issue.isError ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-100/80'}`}
                    >
                      <p className={issue.isError ? 'text-red-800' : 'text-amber-900'}>
                        <span className="font-medium">{issue.isError ? 'Error:' : 'Warning:'}</span> {issue.message}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-gray-600">Include in DNA section:</span>
                        <code className="px-1.5 py-0.5 rounded bg-white border border-gray-300 font-mono text-xs">
                          {section}
                        </code>
                      </div>
                      <div className="mt-2">
                        <p className="text-gray-700 mb-1">Edit if needed, then copy or add directly to DNA:</p>
                        <div className="flex items-start gap-2">
                          <textarea
                            value={editableText}
                            onChange={(e) => setSuggestionEdits((prev) => ({ ...prev, [issue.id]: e.target.value }))}
                            className="flex-1 min-w-0 p-2 rounded bg-white border border-gray-200 text-xs font-mono whitespace-pre-wrap break-words resize-y min-h-[4rem]"
                            rows={3}
                            spellCheck={false}
                          />
                          <div className="flex flex-col gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(editableText);
                                toast.success('Copied to clipboard');
                              }}
                              className="px-2 py-1 text-xs font-medium rounded border border-gray-300 bg-white hover:bg-gray-50"
                            >
                              Copy
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setAppliedSuggestionIds((prev) => new Set(prev).add(issue.id));
                                handleAddSuggestionToDna(section, editableText);
                              }}
                              disabled={applySuggestionMutation.isLoading || !parseSuggestionEntry(editableText)}
                              className="px-2 py-1 text-xs font-medium rounded border border-green-600 bg-green-50 text-green-800 hover:bg-green-100 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {applySuggestionMutation.isLoading ? 'Applying…' : 'Add to DNA'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {dnaLoading ? (
                <p className="text-sm text-gray-500">Loading DNA...</p>
              ) : (
                <>
                  <label className="block text-sm font-medium text-gray-700">DNA JSON</label>
                  <textarea
                    value={editJsonText}
                    onChange={(e) => {
                      setEditJsonText(e.target.value);
                      setParseError(null);
                    }}
                    className="w-full h-64 p-3 font-mono text-xs border border-gray-300 rounded focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    spellCheck={false}
                  />
                  {parseError && (
                    <p className="text-sm text-red-600">Parse error: {parseError}</p>
                  )}
                </>
              )}
            </div>
            <div className="flex justify-end gap-2 p-3 border-t border-gray-200">
              <button
                type="button"
                onClick={() => { setEditModalOpen(false); setSuggestionEdits({}); setAppliedSuggestionIds(new Set()); }}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveDna}
                disabled={dnaLoading || updateDnaMutation.isLoading}
                className="btn btn-primary"
              >
                {updateDnaMutation.isLoading ? 'Saving…' : 'Save to DNA'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
