import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { aiApi } from '../api/ai.api';
import toast from 'react-hot-toast';

interface ProjectGuidelinesModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
}

export default function ProjectGuidelinesModal({
  isOpen,
  onClose,
  projectId,
}: ProjectGuidelinesModalProps) {
  const queryClient = useQueryClient();
  const [newRule, setNewRule] = useState('');

  const { data: guidelines, isLoading } = useQuery(
    ['ai-guidelines', projectId],
    () => aiApi.getGuidelines(projectId),
    {
      enabled: isOpen && !!projectId,
    },
  );

  const updateMutation = useMutation({
    mutationFn: (rules: Array<{ title: string; description?: string; instruction?: string }>) =>
      aiApi.upsertGuidelines(projectId, rules),
    onSuccess: () => {
      queryClient.invalidateQueries(['ai-guidelines', projectId]);
      toast.success('Guidelines updated successfully');
      setNewRule('');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to update guidelines');
    },
  });

  const handleAddRule = () => {
    if (!newRule.trim()) return;

    const currentRules = guidelines?.rules || [];
    const rulesArray = Array.isArray(currentRules) ? currentRules : [];
    
    // Check if guidelines.rules is an array of strings or objects
    const existingRules = rulesArray.map((rule: any) => 
      typeof rule === 'string' ? rule : rule.title || rule.instruction || ''
    );

    if (existingRules.includes(newRule.trim())) {
      toast.error('This rule already exists');
      return;
    }

    // Convert to object format if needed, or keep as string
    const updatedRules = [
      ...rulesArray,
      typeof rulesArray[0] === 'string' 
        ? newRule.trim() 
        : { title: newRule.trim(), instruction: newRule.trim() }
    ];

    updateMutation.mutate(updatedRules);
  };

  const handleDeleteRule = (index: number) => {
    const currentRules = guidelines?.rules || [];
    const rulesArray = Array.isArray(currentRules) ? currentRules : [];
    const updatedRules = rulesArray.filter((_: any, i: number) => i !== index);
    updateMutation.mutate(updatedRules);
  };

  if (!isOpen) return null;

  // Handle both string[] and object[] formats
  const rulesList = guidelines?.rules || [];
  const rulesArray = Array.isArray(rulesList) ? rulesList : [];
  const displayRules = rulesArray.map((rule: any, index: number) => ({
    id: index,
    text: typeof rule === 'string' ? rule : rule.title || rule.instruction || rule.description || '',
    fullRule: rule,
  }));

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-3xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Translation Guidelines</h2>
            <p className="text-sm text-gray-600 mt-1">
              These rules are automatically applied to all AI translations in this project
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
            disabled={updateMutation.isPending}
          >
            ×
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-8">Loading guidelines...</div>
        ) : (
          <div className="space-y-4">
            {/* Info Box */}
            <div className="bg-blue-50 border border-blue-200 rounded p-4">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-blue-800">How Guidelines Work</h3>
                  <div className="mt-2 text-sm text-blue-700">
                    <p>
                      These guidelines are automatically included in every AI translation prompt for this project.
                      Rules saved from chat conversations are also stored here.
                    </p>
                    <p className="mt-2 font-semibold">
                      ✓ All future translations will follow these rules
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Rules List */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3">
                Active Rules ({displayRules.length})
              </h3>
              {displayRules.length === 0 ? (
                <div className="text-center py-8 text-gray-500 border-2 border-dashed border-gray-300 rounded-lg">
                  <p>No guidelines set yet.</p>
                  <p className="text-sm mt-2">Add rules below or save them from chat conversations.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {displayRules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-start justify-between p-3 bg-gray-50 rounded-lg border border-gray-200"
                    >
                      <div className="flex-1">
                        <div className="flex items-start gap-2">
                          <span className="text-primary-600 font-semibold text-sm">
                            {rule.id + 1}.
                          </span>
                          <p className="text-sm text-gray-900 flex-1">{rule.text}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteRule(rule.id)}
                        className="ml-3 text-red-600 hover:text-red-800 text-sm"
                        disabled={updateMutation.isPending}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Add New Rule */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Add New Rule</h3>
              <div className="flex gap-2">
                <textarea
                  value={newRule}
                  onChange={(e) => setNewRule(e.target.value)}
                  placeholder="e.g., Always use formal tone, Use British English spelling, Preserve technical terms..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-sm resize-none"
                  rows={3}
                  disabled={updateMutation.isPending}
                />
                <button
                  onClick={handleAddRule}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!newRule.trim() || updateMutation.isPending}
                >
                  Add
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-secondary"
                disabled={updateMutation.isPending}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}



