import { useState, useEffect } from 'react';
import { useMutation } from 'react-query';
import { glossaryApi } from '../api/glossary.api';
import type { GlossaryEntry, UpsertGlossaryEntryRequest, ContextRules } from '../api/glossary.api';
import { projectsApi } from '../api/projects.api';
import { useQuery } from 'react-query';
import toast from 'react-hot-toast';
import LocaleSelector from './LocaleSelector';

interface GlossaryEntryModalProps {
  isOpen: boolean;
  onClose: () => void;
  entry?: GlossaryEntry | null;
  projectId?: string;
  onSuccess?: () => void;
}

export default function GlossaryEntryModal({
  isOpen,
  onClose,
  entry,
  projectId: defaultProjectId,
  onSuccess,
}: GlossaryEntryModalProps) {
  const [formData, setFormData] = useState<UpsertGlossaryEntryRequest>({
    projectId: defaultProjectId,
    sourceTerm: '',
    targetTerm: '',
    sourceLocale: '',
    targetLocale: '',
    description: '',
    status: 'PREFERRED',
    forbidden: false,
    notes: '',
    contextRules: undefined,
  });
  const [showContextRules, setShowContextRules] = useState(false);

  // Fetch projects for dropdown
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  });

  // Populate form when editing
  useEffect(() => {
    if (entry) {
      setFormData({
        id: entry.id,
        projectId: entry.projectId,
        sourceTerm: entry.sourceTerm,
        targetTerm: entry.targetTerm,
        sourceLocale: entry.sourceLocale,
        targetLocale: entry.targetLocale,
        description: entry.description || '',
        status: entry.status,
        forbidden: entry.forbidden,
        notes: entry.notes || '',
        contextRules: entry.contextRules,
      });
      setShowContextRules(!!entry.contextRules);
    } else {
      // Reset form for new entry
      setFormData({
        projectId: defaultProjectId,
        sourceTerm: '',
        targetTerm: '',
        sourceLocale: '',
        targetLocale: '',
        description: '',
        status: 'PREFERRED',
        forbidden: false,
        notes: '',
        contextRules: undefined,
      });
      setShowContextRules(false);
    }
  }, [entry, defaultProjectId]);

  const updateContextRule = (field: keyof ContextRules, value: string[]) => {
    setFormData({
      ...formData,
      contextRules: {
        ...formData.contextRules,
        [field]: value.length > 0 ? value : undefined,
      },
    });
  };

  const parseContextRule = (value: string): string[] => {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  };

  const formatContextRule = (value: string[] | undefined): string => {
    return value ? value.join(', ') : '';
  };

  const upsertMutation = useMutation({
    mutationFn: (data: UpsertGlossaryEntryRequest) => {
      if (entry?.id) {
        return glossaryApi.update(entry.id, data);
      }
      return glossaryApi.upsert(data);
    },
    onSuccess: () => {
      toast.success(entry ? 'Glossary entry updated successfully' : 'Glossary entry created successfully');
      onSuccess?.();
      onClose(); // Close modal after successful creation/update
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || `Failed to ${entry ? 'update' : 'create'} glossary entry`);
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.sourceTerm.trim() || !formData.targetTerm.trim()) {
      toast.error('Source term and target term are required');
      return;
    }

    if (!formData.sourceLocale || !formData.targetLocale) {
      toast.error('Source locale and target locale are required');
      return;
    }

    // Clean up data before sending: convert empty strings to undefined for optional fields
    const cleanedData: UpsertGlossaryEntryRequest = {
      ...formData,
      projectId: formData.projectId || undefined,
      description: formData.description?.trim() || undefined,
      notes: formData.notes?.trim() || undefined,
    };

    upsertMutation.mutate(cleanedData);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold text-gray-900">
              {entry ? 'Edit Glossary Entry' : 'Add Glossary Entry'}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Project <span className="text-gray-400">(optional)</span>
                </label>
                <select
                  value={formData.projectId || ''}
                  onChange={(e) => setFormData({ ...formData, projectId: e.target.value || undefined })}
                  className="input w-full"
                >
                  <option value="">Global (All Projects)</option>
                  {projects?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Status
                </label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value as 'PREFERRED' | 'DEPRECATED' })}
                  className="input w-full"
                >
                  <option value="PREFERRED">Preferred</option>
                  <option value="DEPRECATED">Deprecated</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <LocaleSelector
                  label="Source Locale"
                  value={formData.sourceLocale}
                  onChange={(locale) => setFormData({ ...formData, sourceLocale: locale })}
                  required
                  excludeLocales={[formData.targetLocale].filter(Boolean)}
                  placeholder="Select source locale..."
                />
              </div>

              <div>
                <LocaleSelector
                  label="Target Locale"
                  value={formData.targetLocale}
                  onChange={(locale) => setFormData({ ...formData, targetLocale: locale })}
                  required
                  excludeLocales={[formData.sourceLocale].filter(Boolean)}
                  placeholder="Select target locale..."
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Source Term <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.sourceTerm}
                onChange={(e) => setFormData({ ...formData, sourceTerm: e.target.value })}
                placeholder="Source term"
                className="input w-full"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Target Term <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.targetTerm}
                onChange={(e) => setFormData({ ...formData, targetTerm: e.target.value })}
                placeholder="Target term"
                className="input w-full"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description <span className="text-gray-400">(optional)</span>
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Term description or context"
                rows={3}
                className="input w-full"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes <span className="text-gray-400">(optional)</span>
              </label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Additional notes"
                rows={2}
                className="input w-full"
              />
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                id="forbidden"
                checked={formData.forbidden}
                onChange={(e) => setFormData({ ...formData, forbidden: e.target.checked })}
                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
              />
              <label htmlFor="forbidden" className="ml-2 block text-sm text-gray-700">
                Mark as forbidden term (should not be used in translations)
              </label>
            </div>

            {/* Context Rules Section */}
            <div className="border-t border-gray-200 pt-4">
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-gray-700">
                  Context Rules <span className="text-gray-400">(optional)</span>
                </label>
                <button
                  type="button"
                  onClick={() => setShowContextRules(!showContextRules)}
                  className="text-sm text-primary-600 hover:text-primary-700"
                >
                  {showContextRules ? 'Hide' : 'Show'} Context Rules
                </button>
              </div>
              
              {showContextRules && (
                <div className="space-y-3 bg-gray-50 p-4 rounded-lg">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Use Only In (comma-separated contexts/domains)
                    </label>
                    <input
                      type="text"
                      value={formatContextRule(formData.contextRules?.useOnlyIn)}
                      onChange={(e) => updateContextRule('useOnlyIn', parseContextRule(e.target.value))}
                      placeholder="e.g., legal, medical, technical"
                      className="input w-full text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Only use this term when document matches these contexts
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Exclude From (comma-separated contexts/domains)
                    </label>
                    <input
                      type="text"
                      value={formatContextRule(formData.contextRules?.excludeFrom)}
                      onChange={(e) => updateContextRule('excludeFrom', parseContextRule(e.target.value))}
                      placeholder="e.g., marketing, casual"
                      className="input w-full text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Never use this term in these contexts
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Document Types (comma-separated)
                    </label>
                    <input
                      type="text"
                      value={formatContextRule(formData.contextRules?.documentTypes)}
                      onChange={(e) => updateContextRule('documentTypes', parseContextRule(e.target.value))}
                      placeholder="e.g., contract, report, manual"
                      className="input w-full text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Only use this term in these document types
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Requires (comma-separated conditions)
                    </label>
                    <input
                      type="text"
                      value={formatContextRule(formData.contextRules?.requires)}
                      onChange={(e) => updateContextRule('requires', parseContextRule(e.target.value))}
                      placeholder="e.g., formal_tone, technical"
                      className="input w-full text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Only use when all these conditions are met
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-secondary"
                disabled={upsertMutation.isLoading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={upsertMutation.isLoading}
              >
                {upsertMutation.isLoading ? 'Saving...' : entry ? 'Update' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
