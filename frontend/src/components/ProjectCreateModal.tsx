import { useState } from 'react';
import type { CreateProjectRequest } from '../api/projects.api';
import { SUPPORTED_LANGUAGES, getLanguageName, getLanguageByCode } from '../utils/languages';
import LocaleSelector from './LocaleSelector';

interface ProjectCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: CreateProjectRequest) => void;
  isLoading: boolean;
}

export default function ProjectCreateModal({
  isOpen,
  onClose,
  onCreate,
  isLoading,
}: ProjectCreateModalProps) {
  const [formData, setFormData] = useState<CreateProjectRequest>({
    name: '',
    description: '',
    clientName: '',
    domain: '',
    sourceLocale: '',
    targetLocales: [],
    dueDate: undefined,
  });

  const [targetLocaleInput, setTargetLocaleInput] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate(formData);
    // Reset form
    setFormData({
      name: '',
      description: '',
      clientName: '',
      domain: '',
      sourceLocale: '',
      targetLocales: [],
      dueDate: undefined,
    });
    setTargetLocaleInput('');
  };

  const addTargetLocale = () => {
    if (targetLocaleInput && !formData.targetLocales.includes(targetLocaleInput)) {
      setFormData({
        ...formData,
        targetLocales: [...formData.targetLocales, targetLocaleInput],
      });
      setTargetLocaleInput('');
    }
  };

  const removeTargetLocale = (locale: string) => {
    setFormData({
      ...formData,
      targetLocales: formData.targetLocales.filter((l) => l !== locale),
    });
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-900">Create New Project</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
            disabled={isLoading}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Project Name *
            </label>
            <input
              type="text"
              required
              className="input"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., Website Translation Project"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              className="input min-h-[80px]"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Project description..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Client Name
              </label>
              <input
                type="text"
                className="input"
                value={formData.clientName}
                onChange={(e) => setFormData({ ...formData, clientName: e.target.value })}
                placeholder="Client name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Domain
              </label>
              <input
                type="text"
                className="input"
                value={formData.domain}
                onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
                placeholder="e.g., legal, medical, technical"
              />
            </div>
          </div>

          <LocaleSelector
            label="Source Language"
            value={formData.sourceLocale}
            onChange={(locale) => setFormData({ ...formData, sourceLocale: locale })}
              required
            excludeLocales={formData.targetLocales}
            placeholder="Select source language..."
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Target Languages *
            </label>
            <div className="flex gap-2 mb-2">
              <select
                className="input flex-1"
                value={targetLocaleInput}
                onChange={(e) => setTargetLocaleInput(e.target.value)}
              >
                <option value="">Select target language...</option>
                {SUPPORTED_LANGUAGES.filter(
                  (lang) => lang.code !== formData.sourceLocale && !formData.targetLocales.includes(lang.code)
                ).map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name} ({lang.code})
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={addTargetLocale}
                disabled={!targetLocaleInput}
                className="btn btn-secondary"
              >
                Add
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {formData.targetLocales.map((locale) => {
                const lang = getLanguageByCode(locale);
                return (
                  <span
                    key={locale}
                    className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-primary-100 text-primary-800"
                  >
                    {lang ? `${lang.name} (${locale})` : locale}
                    <button
                      type="button"
                      onClick={() => removeTargetLocale(locale)}
                      className="ml-2 text-primary-600 hover:text-primary-800"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
            {formData.targetLocales.length === 0 && (
              <p className="text-xs text-gray-500 mt-1">
                Select at least one target language
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Due Date
            </label>
            <input
              type="datetime-local"
              className="input"
              value={
                formData.dueDate
                  ? new Date(formData.dueDate).toISOString().slice(0, 16)
                  : ''
              }
              onChange={(e) =>
                setFormData({
                  ...formData,
                  dueDate: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                })
              }
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary"
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isLoading || !formData.name || formData.targetLocales.length === 0}
            >
              {isLoading ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}







