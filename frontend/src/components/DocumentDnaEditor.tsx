/**
 * Safe structured UI for editing Document DNA: add/edit/delete entities per section,
 * plus Import/Export JSON. No raw JSON textarea; validation before save.
 */

import React, { useCallback, useMemo, useState } from 'react';
import type { DocumentDnaPayload } from '../api/analysis.api';

const SECTION_KEYS = ['technicalSchema', 'namingConventions', 'abbreviationLogic', 'entityGroups'] as const;
const SECTION_LABELS: Record<(typeof SECTION_KEYS)[number], string> = {
  technicalSchema: 'Technical schema',
  namingConventions: 'Naming conventions',
  abbreviationLogic: 'Abbreviations',
  entityGroups: 'Entity groups',
};

type AbbreviationEntry = { longForm: string; shortForm: string; aliases?: string[] };

function normalizeAbbreviationValue(val: unknown): AbbreviationEntry {
  if (val == null) return { longForm: '', shortForm: '' };
  if (typeof val === 'string') {
    const s = val.trim();
    return { longForm: s, shortForm: s };
  }
  if (typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>;
    const long = String(o.longForm ?? o.value ?? '').trim() || String(o.shortForm ?? '').trim();
    const short = String(o.shortForm ?? o.longForm ?? o.value ?? '').trim() || long;
    const aliases = Array.isArray(o.aliases)
      ? (o.aliases.filter((a): a is string => typeof a === 'string') as string[])
      : undefined;
    return { longForm: long || short, shortForm: short || long, ...(aliases?.length ? { aliases } : undefined) };
  }
  return { longForm: '', shortForm: '' };
}

function buildAbbreviationLogicFromEntries(entries: { key: string; longForm: string; shortForm: string; aliases?: string[] }[]): Record<string, AbbreviationEntry> | null {
  const out: Record<string, AbbreviationEntry> = {};
  for (const { key, longForm, shortForm, aliases } of entries) {
    const k = key.trim();
    if (!k) continue;
    out[k] = { longForm: longForm.trim() || k, shortForm: shortForm.trim() || k, ...(aliases?.length ? { aliases } : undefined) };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function payloadFromDna(dna: DocumentDnaPayload | null): DocumentDnaPayload {
  if (!dna) return {};
  return {
    technicalSchema: dna.technicalSchema ?? null,
    namingConventions: dna.namingConventions ?? null,
    abbreviationLogic: dna.abbreviationLogic ?? null,
    entityGroups: dna.entityGroups ?? null,
  };
}

export type DocumentDnaEditorProps = {
  dna: DocumentDnaPayload | null;
  onChange: (payload: DocumentDnaPayload) => void;
  onExport?: () => void;
  disabled?: boolean;
};

type AbbrevRow = { key: string; longForm: string; shortForm: string; aliases?: string[] };

export function DocumentDnaEditor({ dna, onChange, onExport, disabled }: DocumentDnaEditorProps) {
  const [activeSection, setActiveSection] = useState<(typeof SECTION_KEYS)[number]>('abbreviationLogic');
  const [pendingNewRow, setPendingNewRow] = useState<AbbrevRow | null>(null);

  const abbrevEntries = useMemo(() => {
    const raw = dna?.abbreviationLogic;
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw).map(([key, val]) => ({
      key,
      ...normalizeAbbreviationValue(val),
    }));
  }, [dna?.abbreviationLogic]);

  const displayedAbbrevRows = useMemo<AbbrevRow[]>(
    () => [...abbrevEntries, ...(pendingNewRow ? [pendingNewRow] : [])],
    [abbrevEntries, pendingNewRow],
  );

  const setAbbrevEntries = useCallback(
    (entries: { key: string; longForm: string; shortForm: string; aliases?: string[] }[]) => {
      const next = payloadFromDna(dna);
      next.abbreviationLogic = buildAbbreviationLogicFromEntries(entries);
      onChange(next);
    },
    [dna, onChange],
  );

  const addAbbreviation = useCallback(() => {
    setPendingNewRow({ key: '', longForm: '', shortForm: '' });
  }, []);

  const updateAbbreviation = useCallback(
    (index: number, field: 'key' | 'longForm' | 'shortForm' | 'aliases', value: string | string[]) => {
      const isPending = index === abbrevEntries.length;
      if (isPending && pendingNewRow) {
        const updated: AbbrevRow = { ...pendingNewRow };
        if (field === 'aliases') updated.aliases = Array.isArray(value) ? value : value ? [value] : undefined;
        else updated[field] = typeof value === 'string' ? value : (Array.isArray(value) ? value.join(', ') : '');
        if (updated.key.trim()) {
          setAbbrevEntries([...abbrevEntries, updated]);
          setPendingNewRow(null);
        } else {
          setPendingNewRow(updated);
        }
        return;
      }
      const next = [...abbrevEntries];
      if (!next[index]) return;
      if (field === 'aliases') next[index].aliases = Array.isArray(value) ? value : value ? [value] : undefined;
      else next[index][field] = typeof value === 'string' ? value : (Array.isArray(value) ? value.join(', ') : '');
      setAbbrevEntries(next);
    },
    [abbrevEntries, pendingNewRow, setAbbrevEntries],
  );

  const removeAbbreviation = useCallback(
    (index: number) => {
      if (index === abbrevEntries.length) {
        setPendingNewRow(null);
        return;
      }
      const next = abbrevEntries.filter((_, i) => i !== index);
      setAbbrevEntries(next);
    },
    [abbrevEntries, setAbbrevEntries],
  );

  const setGenericSection = useCallback(
    (section: 'technicalSchema' | 'namingConventions' | 'entityGroups', value: Record<string, unknown> | null) => {
      const next = payloadFromDna(dna);
      (next as Record<string, unknown>)[section] = value;
      onChange(next);
    },
    [dna, onChange],
  );

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = reader.result as string;
          const parsed = JSON.parse(text) as unknown;
          if (parsed === null || typeof parsed !== 'object') {
            throw new Error('JSON must be an object');
          }
          const obj = parsed as Record<string, unknown>;
          const payload: DocumentDnaPayload = {
            technicalSchema: (obj.technicalSchema as Record<string, unknown>) ?? null,
            namingConventions: (obj.namingConventions as Record<string, unknown>) ?? null,
            abbreviationLogic: (obj.abbreviationLogic as Record<string, unknown>) ?? null,
            entityGroups: (obj.entityGroups as Record<string, unknown>) ?? null,
          };
          onChange(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Invalid JSON';
          alert(`Import failed: ${msg}`);
        }
      };
      reader.readAsText(file, 'UTF-8');
      e.target.value = '';
    },
    [onChange],
  );

  const handleExport = useCallback(() => {
    const payload = payloadFromDna(dna);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'document-dna.json';
    a.click();
    URL.revokeObjectURL(url);
    onExport?.();
  }, [dna, onExport]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-2">
        {SECTION_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveSection(key)}
            className={`px-2 py-1 text-xs rounded border ${
              activeSection === key ? 'bg-blue-100 border-blue-400 text-blue-800' : 'bg-gray-50 border-gray-200 text-gray-700'
            }`}
          >
            {SECTION_LABELS[key]}
          </button>
        ))}
      </div>

      {activeSection === 'abbreviationLogic' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-700">Key → Long form / Short form</span>
            <button
              type="button"
              onClick={addAbbreviation}
              disabled={disabled}
              className="text-xs text-blue-600 hover:underline disabled:opacity-50"
            >
              + Add
            </button>
          </div>
          <div className="border border-gray-200 rounded overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-1.5 font-medium">Key</th>
                  <th className="text-left p-1.5 font-medium">Long form</th>
                  <th className="text-left p-1.5 font-medium">Short form</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {displayedAbbrevRows.map((row, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="p-1">
                      <input
                        value={row.key}
                        onChange={(e) => updateAbbreviation(i, 'key', e.target.value)}
                        placeholder="e.g. ESMP"
                        className="w-full px-1.5 py-0.5 border border-gray-200 rounded"
                        disabled={disabled}
                      />
                    </td>
                    <td className="p-1">
                      <input
                        value={row.longForm}
                        onChange={(e) => updateAbbreviation(i, 'longForm', e.target.value)}
                        placeholder="Environmental and Social Management Plan"
                        className="w-full px-1.5 py-0.5 border border-gray-200 rounded"
                        disabled={disabled}
                      />
                    </td>
                    <td className="p-1">
                      <input
                        value={row.shortForm}
                        onChange={(e) => updateAbbreviation(i, 'shortForm', e.target.value)}
                        placeholder="ESMP"
                        className="w-full px-1.5 py-0.5 border border-gray-200 rounded"
                        disabled={disabled}
                      />
                    </td>
                    <td className="p-1">
                      <button
                        type="button"
                        onClick={() => removeAbbreviation(i)}
                        disabled={disabled}
                        className="text-red-600 hover:underline disabled:opacity-50"
                        title="Delete"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(activeSection === 'technicalSchema' || activeSection === 'namingConventions' || activeSection === 'entityGroups') && (
        <GenericSectionEditor
          section={activeSection}
          value={((dna ?? {})[activeSection] as Record<string, unknown>) ?? {}}
          onChange={(v) => setGenericSection(activeSection, Object.keys(v).length > 0 ? v : null)}
          disabled={disabled}
        />
      )}

      <div className="flex gap-2 pt-2 border-t border-gray-200">
        <label className="text-xs text-blue-600 hover:underline cursor-pointer">
          <input type="file" accept=".json,application/json" className="hidden" onChange={handleImport} disabled={disabled} />
          Import JSON
        </label>
        <button type="button" onClick={handleExport} disabled={disabled} className="text-xs text-blue-600 hover:underline disabled:opacity-50">
          Export JSON
        </button>
      </div>
    </div>
  );
}

function GenericSectionEditor({
  section,
  value,
  onChange,
  disabled,
}: {
  section: 'technicalSchema' | 'namingConventions' | 'entityGroups';
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const [editKey, setEditKey] = useState('');
  const [editJson, setEditJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  const keys = Object.keys(value);
  const label = SECTION_LABELS[section];

  const handleAddOrEdit = () => {
    setError(null);
    const key = editKey.trim();
    if (!key) {
      setError('Key is required');
      return;
    }
    let parsed: unknown;
    try {
      parsed = editJson.trim() ? JSON.parse(editJson) : {};
    } catch {
      setError('Invalid JSON for value');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Value must be a JSON object');
      return;
    }
    onChange({ ...value, [key]: parsed });
    setEditKey('');
    setEditJson('');
  };

  const handleRemove = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };

  const handleEdit = (key: string) => {
    setEditKey(key);
    const v = value[key];
    setEditJson(typeof v === 'object' && v !== null ? JSON.stringify(v, null, 2) : JSON.stringify(v ?? {}));
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">{label}: key-value pairs (value = JSON object).</p>
      <ul className="text-xs space-y-1 max-h-40 overflow-auto">
        {keys.map((k) => (
          <li key={k} className="flex items-center gap-2 py-0.5">
            <span className="font-mono truncate max-w-[120px]" title={k}>{k}</span>
            <button type="button" onClick={() => handleEdit(k)} disabled={disabled} className="text-blue-600 hover:underline">
              Edit
            </button>
            <button type="button" onClick={() => handleRemove(k)} disabled={disabled} className="text-red-600 hover:underline">
              Delete
            </button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[1fr_2fr_auto] gap-2 items-end text-xs">
        <input
          value={editKey}
          onChange={(e) => setEditKey(e.target.value)}
          placeholder="Key"
          className="px-2 py-1 border border-gray-200 rounded"
          disabled={disabled}
        />
        <textarea
          value={editJson}
          onChange={(e) => setEditJson(e.target.value)}
          placeholder='{}'
          rows={2}
          className="font-mono px-2 py-1 border border-gray-200 rounded w-full"
          disabled={disabled}
        />
        <button type="button" onClick={handleAddOrEdit} disabled={disabled} className="btn btn-primary text-xs whitespace-nowrap">
          {keys.includes(editKey.trim()) ? 'Update' : 'Add'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
