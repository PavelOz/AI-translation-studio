import { useState } from 'react';
import { tmApi } from '../api/tm.api';
import toast from 'react-hot-toast';

interface TMImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  onSuccess?: () => void;
}

type ImportMode = 'import' | 'link';

export default function TMImportModal({ isOpen, onClose, projectId, onSuccess }: TMImportModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [clientName, setClientName] = useState('');
  const [domain, setDomain] = useState('');
  const [mode, setMode] = useState<ImportMode>('import');
  const [isImporting, setIsImporting] = useState(false);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (!selectedFile.name.toLowerCase().endsWith('.tmx')) {
        toast.error('Please select a TMX file (.tmx)');
        e.target.value = '';
        return;
      }
      const maxSize = 200 * 1024 * 1024; // 200MB
      if (selectedFile.size > maxSize) {
        toast.error(`File is too large. Maximum size is 200MB. Your file is ${(selectedFile.size / 1024 / 1024).toFixed(2)}MB`);
        e.target.value = '';
        return;
      }
      setFile(selectedFile);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      toast.error('Please select a TMX file');
      return;
    }

    setIsImporting(true);
    try {
      if (mode === 'import') {
        const result = await tmApi.importTmx(
          file,
          projectId || undefined,
          clientName || undefined,
          domain || undefined,
        );
        toast.success(`Successfully imported ${result.imported} translation units`);
      } else {
        const result = await tmApi.linkTmx(
          file,
          projectId || undefined,
          clientName || undefined,
          domain || undefined,
        );
        toast.success(`Successfully linked TMX file with ${result.entryCount} entries (queries on-demand)`);
      }
      setFile(null);
      setClientName('');
      setDomain('');
      onClose();
      if (onSuccess) {
        onSuccess();
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || `Failed to ${mode} TMX file`);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-900">Import/Link TMX File</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
            disabled={isImporting}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Mode *
            </label>
            <div className="flex gap-4">
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="mode"
                  value="import"
                  checked={mode === 'import'}
                  onChange={(e) => setMode(e.target.value as ImportMode)}
                  className="mr-2"
                  disabled={isImporting}
                />
                <div>
                  <div className="font-medium">Import</div>
                  <div className="text-xs text-gray-500">
                    Extract all entries into database (faster searches, uses more space)
                  </div>
                </div>
              </label>
              <label className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="mode"
                  value="link"
                  checked={mode === 'link'}
                  onChange={(e) => setMode(e.target.value as ImportMode)}
                  className="mr-2"
                  disabled={isImporting}
                />
                <div>
                  <div className="font-medium">Link</div>
                  <div className="text-xs text-gray-500">
                    Store reference only (queries file on-demand, saves space)
                  </div>
                </div>
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              TMX File *
            </label>
            <input
              type="file"
              accept=".tmx"
              onChange={handleFileChange}
              className="input"
              required
              disabled={isImporting}
            />
            <p className="text-xs text-gray-500 mt-1">
              Select a Translation Memory eXchange (TMX) file (max 200MB)
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Client Name (Optional)
            </label>
            <input
              type="text"
              className="input"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="e.g., Acme Corp"
              disabled={isImporting}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Domain (Optional)
            </label>
            <input
              type="text"
              className="input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="e.g., legal, medical, technical"
              disabled={isImporting}
            />
          </div>

          {projectId && (
            <div className="bg-blue-50 border border-blue-200 rounded p-3">
              <p className="text-sm text-blue-800">
                This TM will be imported as a <strong>project-specific</strong> translation memory.
              </p>
            </div>
          )}

          {!projectId && (
            <div className="bg-yellow-50 border border-yellow-200 rounded p-3">
              <p className="text-sm text-yellow-800">
                This TM will be imported as a <strong>global</strong> translation memory available to all projects.
              </p>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary"
              disabled={isImporting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isImporting || !file}
            >
              {isImporting
                ? mode === 'import'
                  ? 'Importing...'
                  : 'Linking...'
                : mode === 'import'
                  ? 'Import TMX'
                  : 'Link TMX'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

