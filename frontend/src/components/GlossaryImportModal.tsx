import { useState, useEffect } from 'react';
import { useMutation } from 'react-query';
import { glossaryApi } from '../api/glossary.api';
import { projectsApi } from '../api/projects.api';
import { useQuery } from 'react-query';
import toast from 'react-hot-toast';
import LocaleSelector from './LocaleSelector';

interface GlossaryImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  onSuccess?: () => void;
}

export default function GlossaryImportModal({
  isOpen,
  onClose,
  projectId: defaultProjectId,
  onSuccess,
}: GlossaryImportModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [sourceLocale, setSourceLocale] = useState('');
  const [targetLocale, setTargetLocale] = useState('');
  const [projectId, setProjectId] = useState<string>(defaultProjectId || '');
  const [isImporting, setIsImporting] = useState(false);

  // Fetch projects for dropdown
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  });

  // Reset form when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setFile(null);
      setSourceLocale('');
      setTargetLocale('');
      setProjectId(defaultProjectId || '');
    }
  }, [isOpen, defaultProjectId]);

  const importMutation = useMutation({
    mutationFn: (data: { file: File; sourceLocale: string; targetLocale: string; projectId?: string }) =>
      glossaryApi.import(data.file, data.sourceLocale, data.targetLocale, data.projectId),
    onSuccess: (data) => {
      toast.success(`Successfully imported ${data.imported} glossary entries`);
      onSuccess?.();
      onClose();
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to import glossary file');
    },
  });

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (!selectedFile.name.toLowerCase().endsWith('.csv')) {
        toast.error('Please select a CSV file (.csv)');
        e.target.value = '';
        return;
      }
      const maxSize = 5 * 1024 * 1024; // 5MB
      if (selectedFile.size > maxSize) {
        toast.error(`File is too large. Maximum size is 5MB. Your file is ${(selectedFile.size / 1024 / 1024).toFixed(2)}MB`);
        e.target.value = '';
        return;
      }
      setFile(selectedFile);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      toast.error('Please select a CSV file');
      return;
    }
    if (!sourceLocale.trim() || !targetLocale.trim()) {
      toast.error('Source locale and target locale are required');
      return;
    }

    setIsImporting(true);
    importMutation.mutate({
      file,
      sourceLocale: sourceLocale.trim(),
      targetLocale: targetLocale.trim(),
      projectId: projectId || undefined,
    });
    setIsImporting(false);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4">
        <div className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold text-gray-900">Import Glossary from CSV</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
              disabled={isImporting}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Project <span className="text-gray-400">(optional)</span>
              </label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="input w-full"
                disabled={isImporting}
              >
                <option value="">Global (All Projects)</option>
                {projects?.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <LocaleSelector
                label="Source Locale"
                value={sourceLocale}
                onChange={setSourceLocale}
                required
                disabled={isImporting}
                excludeLocales={[targetLocale].filter(Boolean)}
                placeholder="Select source locale..."
              />

              <LocaleSelector
                label="Target Locale"
                value={targetLocale}
                onChange={setTargetLocale}
                required
                disabled={isImporting}
                excludeLocales={[sourceLocale].filter(Boolean)}
                placeholder="Select target locale..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                CSV File <span className="text-red-500">*</span>
              </label>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="input w-full"
                required
                disabled={isImporting}
              />
              <p className="text-xs text-gray-500 mt-1">
                CSV must include <code className="bg-gray-100 px-1 rounded">term_source</code> and <code className="bg-gray-100 px-1 rounded">term_target</code> columns
              </p>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded p-3">
              <p className="text-sm text-blue-800 font-medium mb-1">CSV Format:</p>
              <p className="text-xs text-blue-700">
                The CSV file must include these required columns:<br />
                <code className="bg-blue-100 px-1 rounded font-semibold">term_source</code> (required),{' '}
                <code className="bg-blue-100 px-1 rounded font-semibold">term_target</code> (required)
                <br />
                <br />
                Optional columns:<br />
                <code className="bg-blue-100 px-1 rounded">notes</code>,{' '}
                <code className="bg-blue-100 px-1 rounded">forbidden</code> (true/false)
                <br />
                <br />
                Example CSV:<br />
                <code className="bg-blue-100 px-1 rounded text-xs">
                  term_source,term_target,notes,forbidden<br />
                  ТРУ,Товары работы и услуги,Procurement term,false<br />
                  Исполнитель,Contractor,Legal term,false
                </code>
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-4">
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
                disabled={isImporting || !file || !sourceLocale.trim() || !targetLocale.trim()}
              >
                {isImporting ? 'Importing...' : 'Import'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
