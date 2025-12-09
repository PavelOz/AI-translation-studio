import { useState, useEffect, useRef } from 'react';
import { useQuery } from 'react-query';
import { segmentsApi } from '../../api/segments.api';
import { aiApi } from '../../api/ai.api';
import { tmApi } from '../../api/tm.api';
import { useAuthStore } from '../../stores/authStore';
import toast from 'react-hot-toast';
import type { GlossaryMode } from '../../types/glossary';

// TM Profiles для синхронизации с TM Search Panel
const TM_PROFILES = {
  legal: {
    minScore: 70,
    mode: 'basic' as const,
    useVectorSearch: true,
    vectorSimilarity: 70,
  },
  technical: {
    minScore: 50,
    mode: 'basic' as const,
    useVectorSearch: true,
    vectorSimilarity: 50,
  },
  explore: {
    minScore: 40,
    mode: 'extended' as const,
    useVectorSearch: true,
    vectorSimilarity: 30,
  },
};

type AIProvider = 'gemini' | 'openai' | 'yandex';

interface AITranslationPanelProps {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
  segmentId: string;
  glossaryMode?: GlossaryMode;
  onApply: (targetText: string) => void;
  currentTargetText?: string; // Current translation to check if already exists
}

export default function AITranslationPanel({
  sourceText,
  sourceLocale,
  targetLocale,
  projectId,
  segmentId,
  glossaryMode = 'strict_source',
  onApply,
  currentTargetText,
}: AITranslationPanelProps) {
  // Load project AI settings
  const { data: aiSettings, refetch: refetchAISettings } = useQuery(
    ['ai-settings', projectId],
    () => (projectId ? aiApi.getAISettings(projectId) : Promise.resolve(null)),
    {
      enabled: !!projectId,
      staleTime: 30000, // Cache for 30 seconds
    },
  );

  const [selectedProvider, setSelectedProvider] = useState<AIProvider>(() => {
    // Load from localStorage or default to gemini
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('ai-translation-provider');
        if (saved && ['gemini', 'openai', 'yandex'].includes(saved)) {
          return saved as AIProvider;
        }
      } catch (error) {
        console.warn('Failed to load AI provider from localStorage:', error);
      }
    }
    return 'gemini';
  });

  // Update selected provider when project settings load
  useEffect(() => {
    if (aiSettings?.provider && ['gemini', 'openai', 'yandex'].includes(aiSettings.provider)) {
      setSelectedProvider(aiSettings.provider as AIProvider);
    }
    
  }, [aiSettings]);

  const [translation, setTranslation] = useState<string>('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [translationMetadata, setTranslationMetadata] = useState<any[]>([]);
  const [showGlassBox, setShowGlassBox] = useState<boolean>(false);
  const [useCritic, setUseCritic] = useState(false);
  const [autoTranslate, setAutoTranslate] = useState<boolean>(() => {
    // Load from localStorage, default to false
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('ai-auto-translate');
        return saved === 'true';
      } catch (error) {
        console.warn('Failed to load auto-translate setting from localStorage:', error);
      }
    }
    return false;
  });
  const [syncTmSettings, setSyncTmSettings] = useState<boolean>(() => {
    // Load from localStorage, default to false
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('ai-sync-tm-settings');
        return saved === 'true';
      } catch (error) {
        console.warn('Failed to load sync TM settings from localStorage:', error);
      }
    }
    return false;
  });
  const [translationStage, setTranslationStage] = useState<{
    stage: 'draft' | 'critic' | 'editor' | 'complete' | null;
    message?: string;
  } | null>(null);
  const translateAbortControllerRef = useRef<AbortController | null>(null);
  const currentSourceTextRef = useRef<string>('');
  const lastSegmentIdRef = useRef<string>('');
  const hasAutoTranslatedRef = useRef<boolean>(false);

  // Save provider preference to localStorage and update project settings
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('ai-translation-provider', selectedProvider);
      } catch (error) {
        console.warn('Failed to save AI provider to localStorage:', error);
      }
    }

    // Update project AI settings if projectId is available
    if (projectId && selectedProvider) {
      // Get available providers to find the default model
      aiApi.listProviders().then((providers) => {
        const provider = providers.find((p) => p.name === selectedProvider);
        if (provider) {
          aiApi.upsertAISettings(projectId, {
            provider: selectedProvider,
            model: provider.defaultModel,
          }).catch((error) => {
            console.error('Failed to update project AI settings:', error);
            // Don't show error toast as this is a background operation
          });
        }
      }).catch((error) => {
        console.error('Failed to list AI providers:', error);
      });
    }
  }, [selectedProvider, projectId]);

  // Save auto-translate preference to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('ai-auto-translate', autoTranslate.toString());
      } catch (error) {
        console.warn('Failed to save auto-translate setting to localStorage:', error);
      }
    }
  }, [autoTranslate]);

  // Save sync TM settings preference to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('ai-sync-tm-settings', syncTmSettings.toString());
      } catch (error) {
        console.warn('Failed to save sync TM settings to localStorage:', error);
      }
    }
  }, [syncTmSettings]);

  // Функция для получения настроек TM из localStorage
  const getTmSettingsFromStorage = (): {
    minScore: number;
    vectorSimilarity: number;
    mode: 'basic' | 'extended';
    useVectorSearch: boolean;
    limit: number;
  } | null => {
    if (!syncTmSettings) return null;
    
    try {
      const profile = localStorage.getItem('tm-profile');
      const minScore = localStorage.getItem('tm-min-score');
      const vectorSimilarity = localStorage.getItem('tm-vector-similarity');
      const mode = localStorage.getItem('tm-mode');
      const useVectorSearch = localStorage.getItem('tm-use-vector-search');
      
      // Если есть профиль, использовать его настройки
      if (profile === 'legal' || profile === 'technical' || profile === 'explore') {
        const profileSettings = TM_PROFILES[profile];
        return {
          minScore: profileSettings.minScore,
          vectorSimilarity: profileSettings.vectorSimilarity,
          mode: profileSettings.mode,
          useVectorSearch: profileSettings.useVectorSearch,
          limit: 5,
        };
      }
      
      // Иначе использовать индивидуальные настройки
      return {
        minScore: minScore ? parseInt(minScore, 10) : 50,
        vectorSimilarity: vectorSimilarity ? parseInt(vectorSimilarity, 10) : 60,
        mode: (mode === 'extended' ? 'extended' : 'basic') as 'basic' | 'extended',
        useVectorSearch: useVectorSearch !== 'false',
        limit: 5,
      };
    } catch (error) {
      console.warn('Failed to load TM settings from localStorage:', error);
      return null;
    }
  };

  // Auto-translate when segment changes and no translation exists
  useEffect(() => {
    // Reset auto-translate flag when segment changes
    const segmentChanged = lastSegmentIdRef.current !== segmentId;
    if (segmentChanged) {
      lastSegmentIdRef.current = segmentId;
      hasAutoTranslatedRef.current = false;
    }

    // Skip if auto-translate is disabled
    if (!autoTranslate) {
      return;
    }

    // Skip if already translated this segment
    if (hasAutoTranslatedRef.current) {
      return;
    }

    // Skip if no source text
    if (!sourceText.trim()) {
      return;
    }

    // Skip if already has translation
    if (currentTargetText && currentTargetText.trim()) {
      return;
    }

    // Skip if locales are not set
    if (!sourceLocale || !targetLocale) {
      return;
    }

    // Check TM first
    let timeoutId: NodeJS.Timeout | null = null;
    
    const checkTMAndAutoTranslate = async () => {
      try {
        const tmResults = await tmApi.search({
          sourceText,
          sourceLocale,
          targetLocale,
          projectId,
          limit: 1,
          minScore: 70, // Same threshold as backend
        });

        // If no TM match found (or score < 70%), auto-translate with AI
        if (tmResults.length === 0 || tmResults[0].fuzzyScore < 70) {
          hasAutoTranslatedRef.current = true;
          // Small delay to avoid race conditions and allow component to settle
          timeoutId = setTimeout(() => {
            // Double-check conditions before translating
            // Use refs to get current values without adding to dependencies
            if (
              lastSegmentIdRef.current === segmentId &&
              sourceText.trim() &&
              sourceLocale &&
              targetLocale
            ) {
              // Call handleTranslate directly - it will check conditions internally
              handleTranslate();
            }
          }, 800);
        } else {
          // TM match found, mark as checked
          hasAutoTranslatedRef.current = true;
        }
      } catch (error) {
        console.warn('Failed to check TM for auto-translate:', error);
        // Don't auto-translate if TM check fails
      }
    };

    checkTMAndAutoTranslate();
    
    // Cleanup timeout if component unmounts or segment changes
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentId, sourceText, sourceLocale, targetLocale, autoTranslate, currentTargetText]);

  const handleTranslate = async () => {
    if (!sourceText.trim()) {
      toast.error('Source text is empty');
      return;
    }

    // Cancel any pending translation
    if (translateAbortControllerRef.current) {
      translateAbortControllerRef.current.abort();
    }

    // Create new AbortController for this translation
    const abortController = new AbortController();
    translateAbortControllerRef.current = abortController;
    const searchText = sourceText; // Capture the source text for this request
    currentSourceTextRef.current = searchText;

    setIsTranslating(true);
    setError(null);
    setTranslation('');
    setTranslationStage(null);

    try {
      // Ensure project AI settings are up to date with selected provider
      if (projectId) {
        try {
          const providers = await aiApi.listProviders();
          const provider = providers.find((p) => p.name === selectedProvider);
          if (provider) {
            await aiApi.upsertAISettings(projectId, {
              provider: selectedProvider,
              model: provider.defaultModel,
            });
            // Refetch settings to ensure they're updated
            await refetchAISettings();
          }
        } catch (error) {
          console.warn('Failed to update AI settings before translation:', error);
          // Continue with translation anyway
        }
      }

      // Получить настройки TM, если синхронизация включена
      const tmRagSettings = getTmSettingsFromStorage();

      // Use critic workflow with SSE if enabled
      if (useCritic && segmentId) {
        // Use fetch with streaming for SSE-like behavior
        try {
          const token = useAuthStore.getState().token;
          const response = await fetch(`/api/segments/${segmentId}/mt`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              useCritic: true,
              glossaryMode,
              tmRagSettings: tmRagSettings || undefined, // Convert null to undefined
            }),
            signal: abortController.signal,
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            throw new Error(errorData.message || `Translation failed: ${response.statusText}`);
          }

          // Read the stream
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          if (!reader) {
            throw new Error('Response body is not readable');
          }

          while (true) {
            const { done, value } = await reader.read();
            
            if (done) break;
            if (abortController.signal.aborted) {
              reader.cancel();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  
                  if (data.stage) {
                    if (currentSourceTextRef.current === searchText && !abortController.signal.aborted) {
                      setTranslationStage({
                        stage: data.stage,
                        message: data.message,
                      });
                    }
                  }
                  
                  if (data.result && data.stage === 'complete') {
                    // Translation complete
                    if (currentSourceTextRef.current === searchText && !abortController.signal.aborted) {
                      const translationText = data.result.targetMt || data.result.targetFinal || '';
                      setTranslation(translationText);
                      setIsTranslating(false);
                      setTranslationStage({
                        stage: 'complete',
                        message: 'Translation completed successfully',
                      });
                      // Store metadata if available
                      if (data.result.translationMetadata) {
                        console.log('Received translation metadata:', data.result.translationMetadata);
                        setTranslationMetadata(data.result.translationMetadata);
                      } else {
                        console.log('No translation metadata in result');
                      }
                    }
                    return;
                  }
                  
                  if (data.error) {
                    if (currentSourceTextRef.current === searchText) {
                      setError(data.error);
                      toast.error(data.error);
                      setIsTranslating(false);
                    }
                    return;
                  }
                } catch (parseError) {
                  console.error('Failed to parse SSE data:', parseError);
                }
              }
            }
          }
        } catch (fetchError: any) {
          if (fetchError.name === 'AbortError' || abortController.signal.aborted) {
            return;
          }
          if (currentSourceTextRef.current === searchText) {
            const errorMessage = fetchError.message || 'Failed to start translation';
            setError(errorMessage);
            toast.error(errorMessage);
            setIsTranslating(false);
          }
        }
      } else {
        // Use regular translation API via segments API if segmentId is available
        if (segmentId) {
          const result = await segmentsApi.translate(segmentId, {
            applyTm: true,
            glossaryMode,
            tmRagSettings: tmRagSettings || undefined, // Convert null to undefined
          });
          
          // Check if this request was aborted or if sourceText has changed
          if (abortController.signal.aborted) {
            return; // Don't update state if request was cancelled
          }

          // Verify the results are for the current source text
          if (currentSourceTextRef.current !== searchText) {
            console.log('Translation result discarded - source text changed during translation');
            return; // Don't update state if sourceText changed
          }

          setTranslation(result.targetMt || result.targetFinal || '');
          setIsTranslating(false);
          // Store metadata if available
          if ((result as any).translationMetadata) {
            console.log('Received translation metadata:', (result as any).translationMetadata);
            setTranslationMetadata((result as any).translationMetadata);
          } else {
            console.log('No translation metadata in result');
          }
        } else {
          // Fallback to direct AI translation if no segmentId
      const result = await aiApi.translate({
        sourceText: searchText,
            sourceLocale: sourceLocale || '',
            targetLocale: targetLocale || '',
        projectId: projectId || undefined,
        provider: selectedProvider,
        glossaryMode, // Pass glossary mode to API
      });

      // Check if this request was aborted or if sourceText has changed
      if (abortController.signal.aborted) {
        return; // Don't update state if request was cancelled
      }

      // Verify the results are for the current source text
      if (currentSourceTextRef.current !== searchText) {
        console.log('Translation result discarded - source text changed during translation');
        return; // Don't update state if sourceText changed
      }

      setTranslation(result.targetText);
          setIsTranslating(false);
        }
      }
    } catch (error: any) {
      // Ignore abort errors
      if (error.name === 'AbortError' || abortController.signal.aborted) {
        return;
      }

      // Only show error if this is still the current translation
      if (currentSourceTextRef.current === searchText) {
        const errorMessage = error.response?.data?.message || error.message || 'Failed to translate text';
        setError(errorMessage);
        toast.error(errorMessage);
        setIsTranslating(false);
      }
    }
  };

  const handleApply = async () => {
    if (!translation.trim()) {
      toast.error('No translation to apply');
      return;
    }

    if (!segmentId) {
      toast.error('No active segment selected to apply translation.');
      return;
    }

    try {
      // Update the segment with the AI translation
      await segmentsApi.update(segmentId, {
        targetFinal: translation.trim(),
        status: 'MT',
      });

      // Notify parent component to update local state immediately
      onApply(translation.trim());

      toast.success('AI translation applied to segment');
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Failed to apply translation';
      toast.error(errorMessage);
      console.error('Failed to apply AI translation:', error);
    }
  };

  // Cancel translation when source text changes
  useEffect(() => {
    if (translateAbortControllerRef.current) {
      translateAbortControllerRef.current.abort();
      translateAbortControllerRef.current = null;
    }
    setTranslation('');
    setError(null);
    currentSourceTextRef.current = '';

    return () => {
      if (translateAbortControllerRef.current) {
        translateAbortControllerRef.current.abort();
        translateAbortControllerRef.current = null;
      }
    };
  }, [sourceText]);

  const getProviderDisplayName = (provider: AIProvider) => {
    switch (provider) {
      case 'gemini':
        return 'Google Gemini';
      case 'openai':
        return 'OpenAI (ChatGPT)';
      case 'yandex':
        return 'Yandex GPT';
      default:
        return provider;
    }
  };

  return (
    <div 
      className="bg-white border border-gray-200 rounded-lg p-4"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold text-gray-900">AI Translation</h3>
        {translationMetadata.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowGlassBox(!showGlassBox)}
            className="px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded border border-blue-200 transition-colors"
            title="Show translation process details"
          >
            {showGlassBox ? '🔽 Hide Details' : '🔍 Show Details'}
          </button>
        ) : (
          <span className="text-xs text-gray-400 italic">Translate to see process details</span>
        )}
      </div>

      {/* Glass Box: Translation Process Transparency */}
      {showGlassBox && translationMetadata.length > 0 && (
        <div className="mb-4 p-4 bg-gradient-to-br from-blue-50 to-indigo-50 border-2 border-blue-300 rounded-lg shadow-sm">
          <h4 className="font-bold text-blue-900 mb-3 text-sm flex items-center gap-2">
            <span>🔍</span>
            <span>Translation Process Details</span>
          </h4>
          <div className="space-y-3">
            {translationMetadata.map((meta, idx) => (
              <div key={idx} className="bg-white p-3 rounded-lg border-2 shadow-sm">
                {/* Header */}
                <div className="flex items-center justify-between mb-2 pb-2 border-b">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-800 text-xs font-bold">
                      {meta.priority}
                    </span>
                    <span className="font-semibold text-gray-800 text-sm">
                      {meta.source === 'tm-direct' ? '✅ TM Direct Match (Used)' :
                        meta.source === 'tm-rag' ? '📚 TM Examples (Context)' :
                        meta.source === 'glossary' ? '📖 Glossary Terms (Applied)' :
                        meta.source === 'guidelines' ? '📋 Guidelines (Rules)' :
                        '🤖 AI Translation'}
                    </span>
                  </div>
                </div>
                
                {/* Message */}
                {meta.message && (
                  <p className="text-gray-700 text-sm mb-3 font-medium">{meta.message}</p>
                )}
                
                {/* TM Direct Match - Full Text */}
                {meta.tmDirectMatch && (
                  <div className={`mt-3 p-3 rounded-lg border-2 ${
                    meta.tmDirectMatch.searchMethod === 'vector' || meta.tmDirectMatch.searchMethod === 'hybrid'
                      ? 'bg-blue-50 border-blue-300'
                      : 'bg-green-50 border-green-300'
                  }`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium border ${
                        meta.tmDirectMatch.searchMethod === 'vector' || meta.tmDirectMatch.searchMethod === 'hybrid'
                          ? 'bg-blue-100 text-blue-800 border-blue-300'
                          : 'bg-green-100 text-green-800 border-green-300'
                      }`}>
                        {meta.tmDirectMatch.searchMethod === 'vector' || meta.tmDirectMatch.searchMethod === 'hybrid'
                          ? '[MEANING MATCH]'
                          : '[TEXT MATCH]'}
                      </span>
                      <p className={`font-bold text-sm ${
                        meta.tmDirectMatch.searchMethod === 'vector' || meta.tmDirectMatch.searchMethod === 'hybrid'
                          ? 'text-blue-900'
                          : 'text-green-900'
                      }`}>
                        ✅ Direct TM Match ({meta.tmDirectMatch.fuzzyScore}% similarity)
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <p className={`text-xs font-semibold mb-1 ${
                          meta.tmDirectMatch.searchMethod === 'vector' || meta.tmDirectMatch.searchMethod === 'hybrid'
                            ? 'text-blue-800'
                            : 'text-green-800'
                        }`}>Source:</p>
                        <p className={`text-sm bg-white p-2 rounded border font-mono whitespace-pre-wrap break-words ${
                          meta.tmDirectMatch.searchMethod === 'vector' || meta.tmDirectMatch.searchMethod === 'hybrid'
                            ? 'text-blue-900 border-blue-200'
                            : 'text-green-900 border-green-200'
                        }`}>
                          {meta.tmDirectMatch.sourceText}
                        </p>
                      </div>
                      <div>
                        <p className={`text-xs font-semibold mb-1 ${
                          meta.tmDirectMatch.searchMethod === 'vector' || meta.tmDirectMatch.searchMethod === 'hybrid'
                            ? 'text-blue-800'
                            : 'text-green-800'
                        }`}>Target (Used):</p>
                        <p className={`text-sm bg-white p-2 rounded border font-mono whitespace-pre-wrap break-words ${
                          meta.tmDirectMatch.searchMethod === 'vector' || meta.tmDirectMatch.searchMethod === 'hybrid'
                            ? 'text-blue-900 border-blue-200'
                            : 'text-green-900 border-green-200'
                        }`}>
                          {meta.tmDirectMatch.targetText}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* TM Examples - Full Text */}
                {meta.tmExamples && meta.tmExamples.length > 0 && (
                  <div className="mt-3 p-3 bg-yellow-50 rounded-lg border-2 border-yellow-300">
                    <p className="font-bold text-yellow-900 text-sm mb-2">
                      📚 TM Examples Used for Context ({meta.tmExamples.length} example{meta.tmExamples.length > 1 ? 's' : ''})
                    </p>
                    <div className="space-y-3">
                      {meta.tmExamples.map((ex: any, exIdx: number) => (
                        <div key={exIdx} className="bg-white p-2 rounded border border-yellow-200">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-bold text-yellow-800 bg-yellow-100 px-2 py-0.5 rounded">#{exIdx + 1}</span>
                            <span className={`text-xs px-2 py-0.5 rounded font-medium border ${
                              ex.searchMethod === 'vector' || ex.searchMethod === 'hybrid'
                                ? 'bg-blue-100 text-blue-800 border-blue-300'
                                : 'bg-green-100 text-green-800 border-green-300'
                            }`}>
                              {ex.searchMethod === 'vector' || ex.searchMethod === 'hybrid'
                                ? '[MEANING MATCH]'
                                : '[TEXT MATCH]'}
                            </span>
                            <span className={`text-xs font-semibold ${
                              ex.searchMethod === 'vector' || ex.searchMethod === 'hybrid'
                                ? 'text-blue-700'
                                : 'text-green-700'
                            }`}>
                              {ex.fuzzyScore}% match
                            </span>
                          </div>
                          <div className="space-y-1">
                            <div>
                              <p className="text-xs font-semibold text-yellow-800">Source:</p>
                              <p className="text-yellow-900 text-xs font-mono whitespace-pre-wrap break-words">{ex.sourceText}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold text-yellow-800">Target:</p>
                              <p className="text-yellow-900 text-xs font-mono whitespace-pre-wrap break-words">{ex.targetText}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {meta.tmSearchSettings && (
                      <div className="mt-2 pt-2 border-t border-yellow-300">
                        <p className="text-xs text-yellow-800">
                          <span className="font-semibold">Search Settings:</span> minScore={meta.tmSearchSettings.minScore}%, 
                          vector={meta.tmSearchSettings.vectorSimilarity}%, 
                          mode={meta.tmSearchSettings.mode}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Glossary Entries - Full List */}
                {meta.glossaryEntries && meta.glossaryEntries.length > 0 && (
                  <div className="mt-3 p-3 bg-purple-50 rounded-lg border-2 border-purple-300">
                    <p className="font-bold text-purple-900 text-sm mb-2">
                      📖 Glossary Terms Found in Source ({meta.glossaryEntries.length} term{meta.glossaryEntries.length > 1 ? 's' : ''})
                    </p>
                    <div className="space-y-2">
                      {meta.glossaryEntries.map((entry: any, entryIdx: number) => (
                        <div key={entryIdx} className="bg-white p-2 rounded border border-purple-200 flex items-start gap-2">
                          <span className="text-purple-600 font-bold text-sm flex-shrink-0">
                            {entryIdx + 1}.
                          </span>
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-purple-900 text-sm">{entry.sourceTerm}</span>
                              <span className="text-purple-600">→</span>
                              <span className="font-semibold text-purple-900 text-sm">{entry.targetTerm}</span>
                              {entry.isForbidden && (
                                <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded font-bold">
                                  FORBIDDEN
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {meta.glossaryMode && (
                      <div className="mt-2 pt-2 border-t border-purple-300">
                        <p className="text-xs text-purple-800">
                          <span className="font-semibold">Glossary Mode:</span> {meta.glossaryMode}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Guidelines */}
                {meta.guidelinesCount && (
                  <div className="mt-3 p-3 bg-indigo-50 rounded-lg border-2 border-indigo-300">
                    <p className="font-bold text-indigo-900 text-sm">
                      📋 Guidelines: {meta.guidelinesCount} rule{meta.guidelinesCount > 1 ? 's' : ''} applied
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Provider Selection */}
      <div className="mb-4">
        <label htmlFor="ai-provider" className="block text-sm font-medium text-gray-700 mb-2">
          AI Provider
        </label>
        <select
          id="ai-provider"
          value={selectedProvider}
          onChange={(e) => {
            e.stopPropagation();
            setSelectedProvider(e.target.value as AIProvider);
            // Refetch settings after a short delay to see updated value
            setTimeout(() => {
              if (projectId) {
                refetchAISettings();
              }
            }, 500);
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          disabled={isTranslating}
          className="input w-full"
        >
          <option value="gemini">Google Gemini</option>
          <option value="openai">OpenAI (ChatGPT)</option>
          <option value="yandex">Yandex GPT</option>
        </select>
        <p className="text-xs text-gray-500 mt-1">
          Using: {getProviderDisplayName(selectedProvider)}
          {aiSettings?.model && ` (${aiSettings.model})`}
        </p>
      </div>

      {/* Auto-Translate Toggle */}
      <div className="mb-4">
        <label className="flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={autoTranslate}
            onChange={(e) => {
              e.stopPropagation();
              setAutoTranslate(e.target.checked);
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={isTranslating}
            className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
          />
          <span className="text-sm font-medium text-gray-700">
            Auto-translate when TM not found
          </span>
        </label>
        <p className="text-xs text-gray-500 mt-1 ml-6">
          Automatically translate segments with no TM match (≥70%)
        </p>
      </div>

      {/* Sync TM Settings Toggle */}
      <div className="mb-4">
        <label className="flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={syncTmSettings}
            onChange={(e) => {
              e.stopPropagation();
              setSyncTmSettings(e.target.checked);
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={isTranslating}
            className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
          />
          <span className="text-sm font-medium text-gray-700">
            Use TM Search settings for AI examples
          </span>
        </label>
        <p className="text-xs text-gray-500 mt-1 ml-6">
          AI will use your TM Search Panel settings (profile, min score, mode, vector search) for RAG examples
        </p>
      </div>

      {/* Critic Mode Toggle */}
      <div className="mb-4">
        <label className="flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={useCritic}
            onChange={(e) => {
              e.stopPropagation();
              setUseCritic(e.target.checked);
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={isTranslating}
            className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
          />
          <span className="text-sm font-medium text-gray-700">
            Use Critic Workflow (3-step quality check)
          </span>
        </label>
        <p className="text-xs text-gray-500 mt-1 ml-6">
          Draft → Critic QA → Editor (if errors found)
        </p>
      </div>

      {/* Source Text Display */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Source:</label>
        <div className="bg-gray-50 border border-gray-200 rounded p-3 text-sm text-gray-700 whitespace-pre-wrap">
          {sourceText || <span className="text-gray-400">No source text</span>}
        </div>
      </div>

      {/* Translation Stage Indicator */}
      {translationStage && isTranslating && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-center mb-2">
            <div className="flex-1">
              <div className="text-sm font-medium text-blue-900">
                {translationStage.stage === 'draft' && '📝 Step 1: Draft'}
                {translationStage.stage === 'critic' && '🔍 Step 2: Critic QA'}
                {translationStage.stage === 'editor' && '✏️ Step 3: Editor'}
                {translationStage.stage === 'complete' && '✅ Complete'}
              </div>
              {translationStage.message && (
                <div className="text-xs text-blue-700 mt-1">{translationStage.message}</div>
              )}
            </div>
            <svg
              className="animate-spin h-5 w-5 text-blue-600"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
          </div>
          {/* Progress Bar */}
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div
              className={`bg-blue-600 h-2 rounded-full transition-all duration-300 ${
                translationStage.stage === 'draft' ? 'w-1/3' :
                translationStage.stage === 'critic' ? 'w-2/3' :
                translationStage.stage === 'editor' ? 'w-5/6' :
                'w-full'
              }`}
            ></div>
          </div>
        </div>
      )}

      {/* Translate Button */}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleTranslate();
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            disabled={isTranslating || !sourceText.trim()}
            className="btn btn-primary w-full mb-4"
          >
        {isTranslating ? (
          <>
            <svg
              className="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
            {useCritic ? 'Translating with Critic...' : 'Translating...'}
          </>
        ) : (
          `Translate with ${getProviderDisplayName(selectedProvider)}${useCritic ? ' (Critic)' : ''}`
        )}
      </button>

      {/* Error Display */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Translation Result */}
      {translation && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Translation:</label>
          <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-gray-900 whitespace-pre-wrap">
            {translation}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleApply();
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            className="btn btn-primary w-full mt-3"
          >
            Apply Translation
          </button>
        </div>
      )}

      {/* Info */}
      {!translation && !isTranslating && !error && (
        <div className="text-xs text-gray-500 text-center py-2">
          Click "Translate" to get AI translation for this segment
        </div>
      )}

    </div>
  );
}

