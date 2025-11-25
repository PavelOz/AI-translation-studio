import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { aiApi } from '../../api/ai.api';
import toast from 'react-hot-toast';

interface GuidelinesPanelProps {
  projectId: string;
}

export default function GuidelinesPanel({ projectId }: GuidelinesPanelProps) {
  const queryClient = useQueryClient();
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [newRule, setNewRule] = useState('');

  const { data: guidelines, isLoading } = useQuery(
    ['ai-guidelines', projectId],
    () => aiApi.getGuidelines(projectId),
    {
      enabled: !!projectId,
      staleTime: 30000, // Cache for 30 seconds
    },
  );

  const updateMutation = useMutation({
    mutationFn: (rules: Array<{ title: string; description?: string; instruction?: string } | string>) => {
      // Convert all rules to object format before sending
      const convertedRules = rules.map((rule) => {
        if (typeof rule === 'string') {
          return {
            title: rule,
            instruction: rule,
          };
        }
        return rule;
      });
      return aiApi.upsertGuidelines(projectId, convertedRules);
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['ai-guidelines', projectId]);
      toast.success('Guidelines updated');
      setEditingRuleId(null);
      setEditText('');
      setNewRule('');
    },
    onError: (error: any) => {
      console.error('Guidelines update error:', error);
      toast.error(error.response?.data?.message || 'Failed to update guidelines');
    },
  });

  // Handle both string[] and object[] formats
  const rulesList = guidelines?.rules || [];
  const rulesArray = Array.isArray(rulesList) ? rulesList : [];
  const displayRules = rulesArray.map((rule: any, index: number) => ({
    id: index,
    text: typeof rule === 'string' ? rule : rule.title || rule.instruction || rule.description || '',
    fullRule: rule,
  }));

  const handleStartEdit = (rule: typeof displayRules[0]) => {
    setEditingRuleId(rule.id);
    setEditText(rule.text);
  };

  const handleSaveEdit = () => {
    if (!editText.trim() || editingRuleId === null) return;

    // Convert all rules to object format (backend expects objects)
    const updatedRules = rulesArray.map((rule: any, index: number) => {
      if (index === editingRuleId) {
        // Update the edited rule
        return {
          title: editText.trim(),
          instruction: editText.trim(),
        };
      }
      // Keep existing rules, convert strings to objects if needed
      if (typeof rule === 'string') {
        return {
          title: rule,
          instruction: rule,
        };
      }
      return rule;
    });

    updateMutation.mutate(updatedRules);
  };

  const handleCancelEdit = () => {
    setEditingRuleId(null);
    setEditText('');
  };

  const handleDelete = (index: number) => {
    if (!confirm('Delete this rule?')) return;

    // Convert remaining rules to object format
    const updatedRules = rulesArray
      .filter((_: any, i: number) => i !== index)
      .map((rule: any) => {
        if (typeof rule === 'string') {
          return {
            title: rule,
            instruction: rule,
          };
        }
        return rule;
      });

    updateMutation.mutate(updatedRules);
  };

  const handleAddRule = () => {
    if (!newRule.trim()) return;

    // Convert all existing rules to object format and add new one
    const convertedRules = rulesArray.map((rule: any) => {
      if (typeof rule === 'string') {
        return {
          title: rule,
          instruction: rule,
        };
      }
      return rule;
    });

    const updatedRules = [
      ...convertedRules,
      { title: newRule.trim(), instruction: newRule.trim() }
    ];

    updateMutation.mutate(updatedRules);
  };

  if (isLoading) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-gray-900 mb-2">Translation Guidelines</h3>
        <div className="text-sm text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div 
      className="bg-white border border-gray-200 rounded-lg p-4"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold text-gray-900">Translation Guidelines</h3>
        <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
          {displayRules.length} active
        </span>
      </div>
      
      <div className="space-y-2 max-h-[300px] overflow-y-auto mb-3">
        {displayRules.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-4">
            No guidelines set yet. Add rules below or save them from chat conversations.
          </div>
        ) : (
          displayRules.map((rule) => (
            <div
              key={rule.id}
              className="text-sm text-gray-700 bg-gray-50 rounded p-2 border border-gray-200"
            >
              {editingRuleId === rule.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm resize-none"
                    rows={2}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSaveEdit();
                      }}
                      className="text-xs px-2 py-1 bg-primary-600 text-white rounded hover:bg-primary-700"
                      disabled={updateMutation.isPending}
                    >
                      Save
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancelEdit();
                      }}
                      className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 group">
                  <span className="text-primary-600 font-semibold text-xs flex-shrink-0">
                    {rule.id + 1}.
                  </span>
                  <span className="flex-1">{rule.text}</span>
                  <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStartEdit(rule);
                      }}
                      className="text-xs text-primary-600 hover:text-primary-700 mr-2"
                      title="Edit rule"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(rule.id);
                      }}
                      className="text-xs text-red-600 hover:text-red-700"
                      title="Delete rule"
                      disabled={updateMutation.isPending}
                    >
                      ×
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Add New Rule */}
      <div className="pt-3 border-t border-gray-200">
        <div className="flex gap-2 mb-2">
          <textarea
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
            placeholder="Add new rule..."
            className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm resize-none"
            rows={2}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={updateMutation.isPending}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleAddRule();
            }}
            className="px-3 py-1 bg-primary-600 text-white rounded hover:bg-primary-700 text-sm disabled:opacity-50"
            disabled={!newRule.trim() || updateMutation.isPending}
          >
            Add
          </button>
        </div>
        <p className="text-xs text-gray-500">
          ✓ These rules are automatically applied to all AI translations
        </p>
      </div>
    </div>
  );
}

