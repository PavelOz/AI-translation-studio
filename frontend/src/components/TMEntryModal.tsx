import { useState, useEffect } from 'react';
import { useMutation } from 'react-query';
import { tmApi } from '../api/tm.api';
import type { TranslationMemoryEntry } from '../api/tm.api';
import toast from 'react-hot-toast';

interface TMEntryModalProps {
  isOpen: boolean;
  onClose: () => void;
  entry?: TranslationMemoryEntry | null;
  onSuccess?: () => void;
}

export default function TMEntryModal({
  isOpen,
  onClose,
  entry,
  onSuccess,
}: TMEntryModalProps) {
  const [formData, setFormData] = useState({
    sourceText: '',
    targetText: '',
    matchRate: 1,
  });

  // Populate form when editing
  useEffect(() => {
    if (entry) {
      setFormData({
        sourceText: entry.sourceText,
        targetText: entry.targetText,
        matchRate: entry.matchRate ?? 1,
      });
    } else {
      // Reset form for new entry
      setFormData({
        sourceText: '',
        targetText: '',
        matchRate: 1,
      });
    }
  }, [entry]);

  const updateMutation = useMutation({
    mutationFn: (data: { sourceText?: string; targetText?: string; matchRate?: number }) =>
      tmApi.update(entry!.id, data),
    onSuccess: () => {
      toast.success('Translation memory entry updated successfully');
      onSuccess?.();
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to update translation memory entry');
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.sourceText.trim() || !formData.targetText.trim()) {
      toast.error('Source text and target text are required');
      return;
    }

    updateMutation.mutate({
      sourceText: formData.sourceText.trim(),
      targetText: formData.targetText.trim(),
      matchRate: formData.matchRate,
    });
  };

  if (!isOpen || !entry) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold text-gray-900">Edit Translation Memory Entry</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="mb-4 p-3 bg-gray-50 rounded">
            <p className="text-sm text-gray-600 mb-1">Source Locale: <span className="font-medium">{entry.sourceLocale}</span></p>
            <p className="text-sm text-gray-600 mb-1">Target Locale: <span className="font-medium">{entry.targetLocale}</span></p>
            {entry.projectId && (
              <p className="text-sm text-gray-600">Project: <span className="font-medium">{entry.projectId}</span></p>
            )}
            {!entry.projectId && (
              <p className="text-sm text-gray-600">Scope: <span className="font-medium">Global</span></p>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Source Text <span className="text-red-500">*</span>
              </label>
              <textarea
                value={formData.sourceText}
                onChange={(e) => setFormData({ ...formData, sourceText: e.target.value })}
                placeholder="Source text"
                rows={3}
                className="input w-full"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Target Text <span className="text-red-500">*</span>
              </label>
              <textarea
                value={formData.targetText}
                onChange={(e) => setFormData({ ...formData, targetText: e.target.value })}
                placeholder="Target text"
                rows={3}
                className="input w-full"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Match Rate <span className="text-gray-400">(0.0 - 1.0)</span>
              </label>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={formData.matchRate}
                onChange={(e) => setFormData({ ...formData, matchRate: parseFloat(e.target.value) || 1 })}
                className="input w-full"
              />
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-secondary"
                disabled={updateMutation.isLoading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={updateMutation.isLoading}
              >
                {updateMutation.isLoading ? 'Updating...' : 'Update'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

