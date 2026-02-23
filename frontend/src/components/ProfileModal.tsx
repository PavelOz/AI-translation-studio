import { useState, useEffect } from 'react';
import type { Profile } from '../api/profiles.api';

type ProfileFormData = {
  name: string;
  expertRole: string;
  instructions: string;
  terminologyJSON: string;
};

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: Profile | null;
  onSubmit: (data: ProfileFormData) => void;
  isLoading: boolean;
}

const emptyForm: ProfileFormData = {
  name: '',
  expertRole: '',
  instructions: '',
  terminologyJSON: '',
};

export default function ProfileModal({
  isOpen,
  onClose,
  profile,
  onSubmit,
  isLoading,
}: ProfileModalProps) {
  const [formData, setFormData] = useState<ProfileFormData>(emptyForm);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const isEdit = !!profile;

  useEffect(() => {
    if (!isOpen) return;
    if (profile) {
      const termJson =
        profile.terminologyJSON != null
          ? typeof profile.terminologyJSON === 'string'
            ? profile.terminologyJSON
            : JSON.stringify(profile.terminologyJSON, null, 2)
          : '';
      setFormData({
        name: profile.name,
        expertRole: profile.expertRole ?? '',
        instructions: profile.instructions ?? '',
        terminologyJSON: termJson,
      });
    } else {
      setFormData(emptyForm);
    }
    setJsonError(null);
  }, [isOpen, profile]);

  const validateJson = (value: string): boolean => {
    if (!value.trim()) return true;
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const termStr = formData.terminologyJSON.trim();
    if (termStr && !validateJson(termStr)) {
      setJsonError('Invalid JSON');
      return;
    }
    setJsonError(null);
    const payload: ProfileFormData = {
      ...formData,
      terminologyJSON: termStr,
    };
    onSubmit(payload);
  };

  const handleTerminologyChange = (value: string) => {
    setFormData((prev) => ({ ...prev, terminologyJSON: value }));
    if (value.trim() && !validateJson(value)) {
      setJsonError('Invalid JSON');
    } else {
      setJsonError(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-900">
            {isEdit ? 'Edit Profile' : 'New Profile'}
          </h2>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
            <input
              type="text"
              required
              className="input"
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. Technical Default"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Expert role (optional)
            </label>
            <input
              type="text"
              className="input"
              value={formData.expertRole}
              onChange={(e) => setFormData((prev) => ({ ...prev, expertRole: e.target.value }))}
              placeholder="e.g. Lead electrical engineer. Leave empty to rely on document context only."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Instructions (optional)
            </label>
            <textarea
              className="input min-h-[80px]"
              value={formData.instructions}
              onChange={(e) => setFormData((prev) => ({ ...prev, instructions: e.target.value }))}
              placeholder="Priority rules for translation/analysis. Leave empty to rely on document context only."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Terminology JSON (optional)
            </label>
            <textarea
              className={`input min-h-[120px] font-mono text-sm ${jsonError ? 'border-red-500' : ''}`}
              value={formData.terminologyJSON}
              onChange={(e) => handleTerminologyChange(e.target.value)}
              placeholder='{"term": "target"} or []'
            />
            {jsonError && <p className="text-sm text-red-600 mt-1">{jsonError}</p>}
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
              disabled={isLoading || !formData.name.trim() || !!jsonError}
            >
              {isLoading ? (isEdit ? 'Saving...' : 'Creating...') : isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
