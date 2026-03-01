import { useState } from 'react';
import type { ValidatorJanitorReport } from '../../api/documents.api';

type Props = {
  report: ValidatorJanitorReport;
  json: string;
  onJsonChange: (json: string) => void;
  onSave: () => void;
  isSaving: boolean;
};

export default function JanitorReportEditor({ report, json, onJsonChange, onSave, isSaving }: Props) {
  const [isValidJson, setIsValidJson] = useState(true);
  const [jsonError, setJsonError] = useState<string>('');

  const handleJsonChange = (value: string) => {
    onJsonChange(value);
    try {
      JSON.parse(value);
      setIsValidJson(true);
      setJsonError('');
    } catch (e) {
      setIsValidJson(false);
      setJsonError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  const formatJson = () => {
    try {
      const parsed = JSON.parse(json);
      const formatted = JSON.stringify(parsed, null, 2);
      onJsonChange(formatted);
      setIsValidJson(true);
      setJsonError('');
    } catch (e) {
      // Already invalid, can't format
    }
  };

  return (
    <div className="space-y-4">
      {/* Report Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-50 rounded p-3">
          <p className="text-xs text-gray-500">Total Segments</p>
          <p className="text-lg font-semibold text-gray-900">{report.totalSegments}</p>
        </div>
        <div className="bg-gray-50 rounded p-3">
          <p className="text-xs text-gray-500">Unfixable</p>
          <p className="text-lg font-semibold text-gray-900">{report.unfixable?.length || 0}</p>
        </div>
        <div className="bg-gray-50 rounded p-3">
          <p className="text-xs text-gray-500">Spot Checks</p>
          <p className="text-lg font-semibold text-gray-900">{report.spotCheckSegmentIds?.length || 0}</p>
        </div>
        <div className="bg-gray-50 rounded p-3">
          <p className="text-xs text-gray-500">Suspicious Abbrev</p>
          <p className="text-lg font-semibold text-amber-600">{report.counts?.suspiciousAbbrevCount || 0}</p>
        </div>
      </div>

      {/* JSON Editor */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-gray-700">Report JSON</label>
          <div className="flex gap-2">
            <button
              onClick={formatJson}
              className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
            >
              Format JSON
            </button>
            <button
              onClick={onSave}
              disabled={!isValidJson || isSaving}
              className="px-3 py-1 text-xs bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
        
        {jsonError && (
          <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
            {jsonError}
          </div>
        )}

        <textarea
          value={json}
          onChange={(e) => handleJsonChange(e.target.value)}
          className={`w-full h-96 font-mono text-sm p-3 border rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 ${
            isValidJson ? 'border-gray-300' : 'border-red-300'
          }`}
          spellCheck={false}
        />

        <p className="text-xs text-gray-500 mt-2">
          Edit the JSON report above. Changes are validated but not saved to backend (preview mode).
        </p>
      </div>

      {/* Quick Actions */}
      <div className="border-t border-gray-200 pt-4">
        <h4 className="text-sm font-medium text-gray-700 mb-2">Quick Actions</h4>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => {
              const updated = { ...report, unfixable: [] };
              onJsonChange(JSON.stringify(updated, null, 2));
            }}
            className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            Clear Unfixable
          </button>
          <button
            onClick={() => {
              const updated = { ...report, spotCheckSegmentIds: [] };
              onJsonChange(JSON.stringify(updated, null, 2));
            }}
            className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            Clear Spot Checks
          </button>
          <button
            onClick={() => {
              const updated = { ...report, counts: { ...report.counts, suspiciousAbbrevCount: 0 } };
              onJsonChange(JSON.stringify(updated, null, 2));
            }}
            className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            Reset Suspicious Count
          </button>
        </div>
      </div>
    </div>
  );
}
