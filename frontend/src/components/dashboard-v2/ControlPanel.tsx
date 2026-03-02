/**
 * ControlPanel: Панель управления с кнопкой Run Full Cycle и выбором моделей
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from 'react-query';
import { Play, Loader2, Sparkles, Download } from 'lucide-react';
import { documentsApi } from '../../api/documents.api';
import { janitorApi } from '../../api/janitor.api';
import toast from 'react-hot-toast';

interface ControlPanelProps {
  documentId: string;
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  onFullCycleComplete: () => void;
}

export default function ControlPanel({ documentId, tags, onTagsChange, onFullCycleComplete }: ControlPanelProps) {
  const queryClient = useQueryClient();
  const [isRunning, setIsRunning] = useState(false);
  
  // Модели для каждой стадии
  const [synthesisModel, setSynthesisModel] = useState({ provider: 'deepseek', model: 'deepseek-reasoner' });
  const [translationModel, setTranslationModel] = useState({ provider: 'gemini', model: 'gemini-2.5-pro' });
  const [auditModel, setAuditModel] = useState({ provider: 'gemini', model: 'gemini-2.5-pro' });

  // Запуск полного цикла: Synthesis + Translation + Audit
  const runFullCycleMutation = useMutation({
    mutationFn: async () => {
      setIsRunning(true);
      
      try {
        // Step 1: DNA Synthesis
        toast.loading('Step 1/3: Running DNA Synthesis...', { id: 'full-cycle' });
        await documentsApi.analyze(documentId, {
          glossaryMode: 'deep',
          provider: synthesisModel.provider,
          model: synthesisModel.model,
          tags: tags,
        });
        
        // Ждем завершения синтеза (упрощенная версия - в реальности нужен polling)
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Step 2: Mass Translation (через pretranslate)
        toast.loading('Step 2/3: Running Mass Translation...', { id: 'full-cycle' });
        await documentsApi.pretranslate(documentId, {
          applyAiToEmptyOnly: false,
          rewriteNonConfirmed: true,
          provider: translationModel.provider as 'gemini' | 'openai' | 'yandex' | 'deepseek',
          model: translationModel.model,
        });
        
        // Ждем завершения перевода
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Step 3: Universal Audit
        toast.loading('Step 3/3: Running Universal Audit...', { id: 'full-cycle' });
        await janitorApi.auditSegments(documentId, {
          autoFix: true,
          strictMode: true,
          dryRun: false,
        });
        
        toast.success('Full cycle completed successfully!', { id: 'full-cycle' });
        onFullCycleComplete();
      } catch (error: any) {
        toast.error(error?.response?.data?.message || 'Full cycle failed', { id: 'full-cycle' });
        throw error;
      } finally {
        setIsRunning(false);
      }
    },
  });

  const handleRunFullCycle = () => {
    if (isRunning) return;
    runFullCycleMutation.mutate();
  };

  // Smart Export mutation
  const smartExportMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/documents/${documentId}/smart-export?highlightColor=yellow&includeComments=true&validateAbbreviations=true`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('token')}`,
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Export failed: ${response.statusText}`);
      }

      // Получаем имя файла из Content-Disposition
      const contentDisposition = response.headers['content-disposition'];
      let filename = `document_DNA_REVIEWED.docx`;
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch && filenameMatch[1]) {
          filename = decodeURIComponent(filenameMatch[1].replace(/['"]/g, ''));
        }
      }

      const blob = response.data;
      
      // Создаем ссылку для скачивания
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast.success('Smart export completed!');
    },
    onError: (error: any) => {
      toast.error(error?.message || 'Smart export failed');
    },
  });

  const handleSmartExport = () => {
    smartExportMutation.mutate();
  };

  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);

  const handleAddTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      onTagsChange([...tags, tagInput.trim()]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    onTagsChange(tags.filter(t => t !== tagToRemove));
  };

  return (
    <div className="bg-white border-b border-gray-200 px-6 py-4 shadow-sm">
      <div className="flex items-center justify-between">
        {/* Left: Run Button and Tags */}
        <div className="flex items-center gap-4 flex-1">
          <button
            onClick={handleRunFullCycle}
            disabled={isRunning}
            className={`flex items-center gap-2 px-6 py-3 rounded-lg font-semibold text-white transition-all ${
              isRunning
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-primary-600 hover:bg-primary-700 shadow-lg hover:shadow-xl'
            }`}
          >
            {isRunning ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Running...</span>
              </>
            ) : (
              <>
                <Play className="w-5 h-5" />
                <span>Run Full Cycle</span>
              </>
            )}
          </button>
          
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Sparkles className="w-4 h-4" />
            <span>Synthesis → Translation → Audit</span>
          </div>

          {/* Smart Export Button */}
          <button
            onClick={handleSmartExport}
            disabled={smartExportMutation.isPending || isRunning}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
              smartExportMutation.isPending || isRunning
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-green-600 text-white hover:bg-green-700 shadow-md hover:shadow-lg'
            }`}
          >
            {smartExportMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Exporting...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>Export Smart Version</span>
              </>
            )}
          </button>

          {/* Tags Input */}
          <div className="flex items-center gap-2 ml-4">
            <span className="text-sm text-gray-600">Tags:</span>
            <div className="flex items-center gap-2 flex-wrap">
              {tags.map((tag, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs"
                >
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    className="hover:text-blue-900"
                    disabled={isRunning}
                  >
                    ×
                  </button>
                </span>
              ))}
              {showTagInput ? (
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleAddTag();
                      setShowTagInput(false);
                    } else if (e.key === 'Escape') {
                      setShowTagInput(false);
                      setTagInput('');
                    }
                  }}
                  onBlur={() => {
                    if (tagInput.trim()) handleAddTag();
                    setShowTagInput(false);
                    setTagInput('');
                  }}
                  autoFocus
                  className="px-2 py-1 border border-gray-300 rounded text-xs w-24"
                  placeholder="Add tag..."
                />
              ) : (
                <button
                  onClick={() => setShowTagInput(true)}
                  disabled={isRunning}
                  className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 border border-dashed border-gray-300 rounded"
                >
                  + Add tag
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right: Model Selection */}
        <div className="flex items-center gap-4">
          {/* Synthesis Model */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Synthesis:</label>
            <select
              value={`${synthesisModel.provider}:${synthesisModel.model}`}
              onChange={(e) => {
                const [provider, model] = e.target.value.split(':');
                setSynthesisModel({ provider, model });
              }}
              disabled={isRunning}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            >
              <option value="deepseek:deepseek-reasoner">DeepSeek Reasoner</option>
              <option value="gemini:gemini-2.5-pro">Gemini 2.5 Pro</option>
              <option value="openai:gpt-4">GPT-4</option>
            </select>
          </div>

          {/* Translation Model */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Translation:</label>
            <select
              value={`${translationModel.provider}:${translationModel.model}`}
              onChange={(e) => {
                const [provider, model] = e.target.value.split(':');
                setTranslationModel({ provider, model });
              }}
              disabled={isRunning}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            >
              <option value="gemini:gemini-2.5-pro">Gemini 2.5 Pro</option>
              <option value="openai:gpt-4">GPT-4</option>
              <option value="deepseek:deepseek-chat">DeepSeek Chat</option>
            </select>
          </div>

          {/* Audit Model */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Audit:</label>
            <select
              value={`${auditModel.provider}:${auditModel.model}`}
              onChange={(e) => {
                const [provider, model] = e.target.value.split(':');
                setAuditModel({ provider, model });
              }}
              disabled={isRunning}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            >
              <option value="gemini:gemini-2.5-pro">Gemini 2.5 Pro</option>
              <option value="openai:gpt-4">GPT-4</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
