import { useState } from 'react';
import type { JanitorReport } from '../../api/janitor.api';

type Props = {
  report: JanitorReport;
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
          <p className="text-lg font-semibold text-gray-900">{report.statistics.totalSegments}</p>
        </div>
        <div className="bg-gray-50 rounded p-3">
          <p className="text-xs text-gray-500">Requires Review</p>
          <p className="text-lg font-semibold text-red-600">{report.statistics.requiresReview}</p>
        </div>
        <div className="bg-gray-50 rounded p-3">
          <p className="text-xs text-gray-500">Auto-fixed</p>
          <p className="text-lg font-semibold text-amber-600">{report.statistics.autoFixed}</p>
        </div>
        <div className="bg-gray-50 rounded p-3">
          <p className="text-xs text-gray-500">Validated</p>
          <p className="text-lg font-semibold text-green-600">{report.statistics.validated}</p>
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
              const updated = { 
                ...report, 
                segments: report.segments.filter(s => s.status !== 'REQUIRES_REVIEW')
              };
              onJsonChange(JSON.stringify(updated, null, 2));
            }}
            className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            Clear Requires Review
          </button>
          <button
            onClick={() => {
              const updated = { 
                ...report, 
                statistics: { ...report.statistics, requiresReview: 0 }
              };
              onJsonChange(JSON.stringify(updated, null, 2));
            }}
            className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            Reset Requires Review Count
          </button>
        </div>
      </div>
    </div>
  );
}
