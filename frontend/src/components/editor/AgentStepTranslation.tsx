import { useState, useEffect, useMemo } from 'react';
import { useQuery } from 'react-query';
import { aiApi } from '../../api/ai.api';
import { glossaryApi, type GlossaryEntry } from '../../api/glossary.api';
import toast from 'react-hot-toast';

type AIProvider = 'gemini' | 'openai' | 'yandex';

interface AgentStepTranslationProps {
  sourceText: string;
  projectId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  onComplete: (finalText: string) => void;
  onCancel: () => void;
}

type Step = 'start' | 'review-draft' | 'critique-analysis' | 'final-review';

interface CritiqueErrors {
  term: string;
  expected: string;
  found: string;
  severity: string;
}

interface GlossaryCompliance {
  entry: GlossaryEntry;
  foundInSource: boolean;
  foundInDraft: boolean;
  correctTranslation: boolean;
  actualFound?: string;
}

export default function AgentStepTranslation({
  sourceText,
  projectId,
  sourceLocale,
  targetLocale,
  onComplete,
  onCancel,
}: AgentStepTranslationProps) {
  // Load project AI settings to get default provider/model
  const { data: aiSettings } = useQuery(
    ['ai-settings', projectId],
    () => (projectId ? aiApi.getAISettings(projectId) : Promise.resolve(null)),
    {
      enabled: !!projectId,
      staleTime: 30000,
    },
  );

  // Load glossary entries for compliance checking
  const { data: glossaryEntries, isLoading: isLoadingGlossary, error: glossaryError } = useQuery(
    ['glossary', projectId, sourceLocale, targetLocale],
    () => {
      console.log('Loading glossary with params:', { projectId, sourceLocale, targetLocale });
      return glossaryApi.list(projectId, sourceLocale, targetLocale);
    },
    {
      enabled: !!sourceLocale && !!targetLocale,
      staleTime: 60000,
      onSuccess: (data) => {
        console.log('Glossary loaded successfully:', {
          count: data?.length || 0,
          entries: data?.slice(0, 3).map(e => ({ sourceTerm: e.sourceTerm, targetTerm: e.targetTerm })),
        });
      },
      onError: (error) => {
        console.error('Error loading glossary:', error);
      },
    },
  );
  
  // Debug: Log when locales or glossary changes
  useEffect(() => {
    console.log('AgentStepTranslation props:', {
      sourceLocale,
      targetLocale,
      projectId,
      hasGlossaryEntries: !!glossaryEntries,
      glossaryCount: glossaryEntries?.length || 0,
      isLoadingGlossary,
      glossaryError,
    });
  }, [sourceLocale, targetLocale, projectId, glossaryEntries, isLoadingGlossary, glossaryError]);

  // Compute current provider from localStorage or project settings (reactive)
  const currentProvider = useMemo((): AIProvider => {
    // First, try to get from localStorage (user's current selection in AITranslationPanel)
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
    // Fallback to project settings
    if (aiSettings?.provider && ['gemini', 'openai', 'yandex'].includes(aiSettings.provider)) {
      return aiSettings.provider as AIProvider;
    }
    return 'gemini'; // Default
  }, [aiSettings]);

  // Load selected provider state (for UI updates)
  const [selectedProvider, setSelectedProvider] = useState<AIProvider>(currentProvider);

  // Sync state with computed provider (from localStorage or project settings)
  useEffect(() => {
    setSelectedProvider(currentProvider);
  }, [currentProvider]);

  // Also listen for localStorage changes in real-time (when user changes in AITranslationPanel)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'ai-translation-provider') {
        // Force re-render by reading from localStorage again
        const saved = e.newValue;
        if (saved && ['gemini', 'openai', 'yandex'].includes(saved)) {
          setSelectedProvider(saved as AIProvider);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    
    // Poll for same-window changes (localStorage events only fire in OTHER windows)
    // Check every 2 seconds for changes in the same window
    const interval = setInterval(() => {
      if (typeof window !== 'undefined') {
        try {
          const saved = localStorage.getItem('ai-translation-provider');
          if (saved && ['gemini', 'openai', 'yandex'].includes(saved) && saved !== selectedProvider) {
            setSelectedProvider(saved as AIProvider);
          }
        } catch (error) {
          // Ignore errors
        }
      }
    }, 2000);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(interval);
    };
  }, [selectedProvider]);

  const [step, setStep] = useState<Step>('start');
  const [editedDraftText, setEditedDraftText] = useState('');
  const [critiqueErrors, setCritiqueErrors] = useState<CritiqueErrors[]>([]);
  const [critiqueReasoning, setCritiqueReasoning] = useState('');
  const [finalText, setFinalText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [modelUsed, setModelUsed] = useState<string>('');
  const [glossaryCompliance, setGlossaryCompliance] = useState<GlossaryCompliance[]>([]);

  // Step 1: Generate Draft
  const handleGenerateDraft = async () => {
    setIsLoading(true);
    setLoadingMessage('Generating draft translation...');
    try {
      // Use the current provider (from localStorage or project settings)
      const result = await aiApi.generateDraft({
        sourceText,
        projectId,
        sourceLocale,
        targetLocale,
        provider: currentProvider, // Pass current provider from localStorage/project settings
        model: aiSettings?.model, // Pass model from project settings
      });
      setEditedDraftText(result.draftText);
      setModelUsed(result.modelUsed);
      setStep('review-draft');
      toast.success('Draft generated successfully');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to generate draft');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Check glossary compliance
  // Helper: Extract word root/stem for Russian/Kazakh (simple heuristic)
  const extractRoot = (word: string): string => {
    if (!word || typeof word !== 'string' || word.length < 3) {
      return word ? word.toLowerCase() : '';
    }
    
    // Russian/Kazakh common endings (ordered by length - longest first)
    // Important: longer endings first to handle compound endings correctly
    const endings = [
      'ами', 'ах', 'ов', 'ей', 'ом', 'ой', 'ую', 'ая', 'ое', 'ые', 'ых', // plural/adj endings
      'ия', 'ии', 'ию', 'ий', 'ие', // -ия endings
      'ая', 'ую', 'ой', 'ом', 'ое', // adjective endings
      'ов', 'ев', 'ин', 'ын', // possessive endings
      'а', 'у', 'е', 'и', 'о', 'ы', 'ь', 'й', // basic endings (including 'ы' for plural like "проекты")
    ];
    
    let root = word.toLowerCase().trim();
    
    // Special handling for common plural endings
    // "проекты" -> "проект" (remove "ы")
    // "проектов" -> "проект" (remove "ов")
    // "проекта" -> "проект" (remove "а")
    
    for (const ending of endings) {
      if (root.endsWith(ending) && root.length > ending.length + 2) {
        root = root.slice(0, -ending.length);
        break; // Remove only one ending
      }
    }
    
    return root;
  };

  // Helper: Check if two words share the same root (for morphological matching)
  const shareRoot = (word1: string, word2: string): boolean => {
    if (!word1 || !word2) return false;
    const root1 = extractRoot(word1);
    const root2 = extractRoot(word2);
    
    const minRootLength = Math.min(root1.length, root2.length);
    if (minRootLength < 4) {
      return root1 === root2;
    }
    
    return root1 === root2 || 
           (root1.length >= 4 && root2.startsWith(root1)) ||
           (root2.length >= 4 && root1.startsWith(root2));
  };

  const checkGlossaryCompliance = (source: string, draft: string): GlossaryCompliance[] => {
    // Debug: Always log to see what's happening
    console.log('checkGlossaryCompliance called:', {
      hasGlossaryEntries: !!glossaryEntries,
      glossaryEntriesCount: glossaryEntries?.length || 0,
      sourceText: source.substring(0, 50),
      sourceLocale,
      targetLocale,
      projectId,
      isLoadingGlossary,
      glossaryError: glossaryError ? String(glossaryError) : null,
    });
    
    if (isLoadingGlossary) {
      console.log('Glossary is still loading...');
      return [];
    }
    
    if (glossaryError) {
      console.error('Error loading glossary:', glossaryError);
      return [];
    }
    
    if (!glossaryEntries || glossaryEntries.length === 0) {
      console.log('No glossary entries available', {
        sourceLocale,
        targetLocale,
        projectId,
        enabled: !!sourceLocale && !!targetLocale,
      });
      return [];
    }

    const sourceLower = source.toLowerCase();
    const draftLower = draft.toLowerCase();
    
    // Split source and draft into words (handling special characters)
    // Important: remove punctuation BEFORE splitting to handle cases like "проекты :"
    // Also handle Cyrillic characters properly
    const sourceCleaned = source
      .replace(/[.,!?;:()\[\]{}"']/g, ' ')
      .replace(/\s+/g, ' ') // Normalize multiple spaces
      .trim();
    const sourceWords = sourceCleaned
      .split(/[\s\/\-]+/)
      .map((w: string) => w.toLowerCase().trim())
      .filter((w: string) => w.length > 0);
    
    console.log('Source words extracted:', sourceWords);
    console.log('Glossary terms to check:', glossaryEntries.map(e => ({
      sourceTerm: e.sourceTerm,
      targetTerm: e.targetTerm,
      sourceLocale: e.sourceLocale,
      targetLocale: e.targetLocale,
    })));
    
    const draftCleaned = draft.replace(/[.,!?;:()\[\]{}"']/g, ' ');
    const draftWords = draftCleaned
      .split(/[\s\/\-]+/)
      .map((w: string) => w.toLowerCase().trim())
      .filter((w: string) => w.length > 0);

    return glossaryEntries.map((entry: GlossaryEntry) => {
      const targetTermLower = entry.targetTerm.toLowerCase();
      
      // Extract words from the glossary term
      const termCleaned = entry.sourceTerm.replace(/[.,!?;:()\[\]{}"']/g, ' ');
      const termWords = termCleaned
        .split(/[\s\/\-]+/)
        .map(w => w.toLowerCase().trim())
        .filter(w => w.length > 0);
      
      // Strategy 1: Exact match (for single-word terms)
      let foundInSource = false;
      if (termWords.length === 1) {
        const termWord = termWords[0];
        const termRoot = extractRoot(termWord);
        
        // Try exact match first (whole word, case-insensitive)
        const exactWordMatch = sourceWords.some(w => w === termWord);
        if (exactWordMatch) {
          foundInSource = true;
        } else {
          // Try root-based match (for morphological variants like "проектов", "проекты" from "проект")
          // This is the main strategy for finding morphological variants
          for (const sourceWord of sourceWords) {
            if (shareRoot(termWord, sourceWord)) {
              foundInSource = true;
              break;
            }
          }
          
          // Fallback: check if root appears as substring in any source word
          if (!foundInSource && termRoot.length >= 3) { // Lowered threshold from 4 to 3
            for (const sourceWord of sourceWords) {
              const sourceRoot = extractRoot(sourceWord);
              // Check if roots match or one is a prefix of the other
              if (sourceRoot === termRoot || 
                  (termRoot.length >= 3 && sourceRoot.startsWith(termRoot)) ||
                  (sourceRoot.length >= 3 && termRoot.startsWith(sourceRoot))) {
                foundInSource = true;
                break;
              }
            }
          }
          
          // Also check direct substring match (for cases where root extraction fails)
          if (!foundInSource && termRoot.length >= 3) {
            if (sourceLower.includes(termRoot)) {
              foundInSource = true;
            }
          }
          
          // Last resort: substring match in full text (for compound words)
          if (!foundInSource && sourceLower.includes(termWord)) {
            foundInSource = true;
          }
          
          // Special handling for COMPOUND WORDS (like "энергоэффективности")
          // Split compound words into parts and check if parts match
          if (!foundInSource && termWord.length > 8) {
            // Try to split compound words (common patterns: энерго-, авто-, микро-, etc.)
            const compoundPrefixes = ['энерго', 'авто', 'микро', 'макро', 'супер', 'ультра', 'инфра', 'мега', 'гипер'];
            for (const prefix of compoundPrefixes) {
              if (termWord.startsWith(prefix) && termWord.length > prefix.length) {
                const suffix = termWord.substring(prefix.length);
                const suffixRoot = extractRoot(suffix);
                // Check if suffix root appears in source
                for (const sourceWord of sourceWords) {
                  const sourceRoot = extractRoot(sourceWord);
                  if (sourceRoot.includes(suffixRoot) || suffixRoot.includes(sourceRoot)) {
                    // Also check if prefix appears
                    if (sourceWord.includes(prefix) || sourceLower.includes(prefix)) {
                      foundInSource = true;
                      break;
                    }
                  }
                }
                if (foundInSource) break;
              }
            }
            
            // Also check if the compound word itself appears as substring (for morphological variants)
            // "энергоэффективности" should match "энергоэффективность"
            if (!foundInSource) {
              // Remove common endings and check
              const baseForm = termWord.replace(/(ости|остии|остью|остей)$/, '');
              if (baseForm.length >= 8 && sourceLower.includes(baseForm)) {
                foundInSource = true;
              }
            }
          }
        }
      } else {
        // Strategy 2: Multi-word term - extract and match individual significant words
        // For terms like "Отдел по управлению проектами и эффективностью" → "Жобаларды және тиімділікті басқару бөлімі"
        // We want to find "проект" in source and match it to "жоба" in target
        
        // Extract significant words (length >= 4, skip prepositions and conjunctions)
        // Also include compound words (like "энергоэффективности") even if they're longer
        const stopWords = new Set(['и', 'в', 'на', 'по', 'для', 'от', 'к', 'с', 'о', 'у', 'за', 'из', 'және', 'мен', 'бен']);
        const significantWords = termWords.filter((w: string) => {
          const wLower = w.toLowerCase();
          // Include words >= 4 chars OR compound words (>= 8 chars, likely compound)
          return (w.length >= 4 || w.length >= 8) && !stopWords.has(wLower);
        });
        
        // Extract corresponding target words (try to align source and target words)
        const targetWords = entry.targetTerm
          .replace(/[.,!?;:()\[\]{}"']/g, ' ')
          .split(/[\s\/\-]+/)
          .map(w => w.toLowerCase().trim())
          .filter(w => w.length > 0 && !stopWords.has(w.toLowerCase()));
        
        // Find which significant source words appear in the text
        const foundWordPairs: Array<{ sourceWord: string; targetWord: string; sourceIndex: number }> = [];
        
        for (let i = 0; i < significantWords.length; i++) {
          const termWord = significantWords[i];
          const termRoot = extractRoot(termWord);
          
          // Try to find matching word in source text
          let foundInText = false;
          for (const sourceWord of sourceWords) {
            if (sourceWord === termWord || shareRoot(termWord, sourceWord)) {
              foundInText = true;
              // Try to find corresponding target word (use same index or closest match)
              const targetWord = targetWords[i] || targetWords[Math.min(i, targetWords.length - 1)] || entry.targetTerm;
              foundWordPairs.push({
                sourceWord: termWord,
                targetWord: targetWord,
                sourceIndex: i,
              });
              break;
            }
          }
          
          // Also check root-based match
          if (!foundInText && termRoot.length >= 3) {
            for (const sourceWord of sourceWords) {
              const sourceRoot = extractRoot(sourceWord);
              if (sourceRoot === termRoot || 
                  (termRoot.length >= 3 && sourceRoot.startsWith(termRoot)) ||
                  (sourceRoot.length >= 3 && termRoot.startsWith(sourceRoot))) {
                const targetWord = targetWords[i] || targetWords[Math.min(i, targetWords.length - 1)] || entry.targetTerm;
                foundWordPairs.push({
                  sourceWord: termWord,
                  targetWord: targetWord,
                  sourceIndex: i,
                });
                foundInText = true;
                break;
              }
            }
          }
          
          // Special handling for compound words in multi-word terms
          // Example: "энергоэффективности" in "Отдел цифровизации и энергоэффективности"
          if (!foundInText && termWord.length >= 8) {
            // Check if compound word appears as substring in source
            if (sourceLower.includes(termWord)) {
              const targetWord = targetWords[i] || targetWords[Math.min(i, targetWords.length - 1)] || entry.targetTerm;
              foundWordPairs.push({
                sourceWord: termWord,
                targetWord: targetWord,
                sourceIndex: i,
              });
              foundInText = true;
            } else {
              // Try to match compound word parts (e.g., "энерго" + "эффективн")
              const compoundPrefixes = ['энерго', 'авто', 'микро', 'макро', 'супер', 'ультра', 'инфра', 'мега', 'гипер'];
              for (const prefix of compoundPrefixes) {
                if (termWord.startsWith(prefix) && termWord.length > prefix.length) {
                  const suffix = termWord.substring(prefix.length);
                  const suffixRoot = extractRoot(suffix);
                  // Check if both prefix and suffix root appear in source
                  if (sourceLower.includes(prefix) && suffixRoot.length >= 3) {
                    for (const sourceWord of sourceWords) {
                      const sourceRoot = extractRoot(sourceWord);
                      if (sourceRoot.includes(suffixRoot) || suffixRoot.includes(sourceRoot) || sourceWord.includes(suffixRoot)) {
                        const targetWord = targetWords[i] || targetWords[Math.min(i, targetWords.length - 1)] || entry.targetTerm;
                        foundWordPairs.push({
                          sourceWord: termWord,
                          targetWord: targetWord,
                          sourceIndex: i,
                        });
                        foundInText = true;
                        break;
                      }
                    }
                  }
                  if (foundInText) break;
                }
              }
            }
          }
        }
        
        // If at least one significant word is found, consider the term as found
        foundInSource = foundWordPairs.length > 0;
        
        // Debug log for multi-word terms
        if (foundInSource) {
          console.log('Found multi-word term (partial match):', {
            fullTerm: entry.sourceTerm,
            fullTarget: entry.targetTerm,
            foundWordPairs: foundWordPairs.map(p => `${p.sourceWord} → ${p.targetWord}`),
            allSourceWords: termWords,
            allTargetWords: targetWords,
          });
        }
      }
      
      // Check if target term appears in draft
      const targetWords = entry.targetTerm
        .split(/[\s\/\-]+/)
        .map(w => w.toLowerCase().replace(/[.,!?;:()\[\]{}"']/g, ''))
        .filter(w => w.length > 0);
      
      let foundInDraft = false;
      if (targetWords.length === 1) {
        const targetWord = targetWords[0];
        // Try exact match first
        const exactMatch = draftWords.some(w => w === targetWord) || draftLower.includes(targetWord);
        if (exactMatch) {
          foundInDraft = true;
        } else {
          // Try root-based match
          foundInDraft = draftWords.some(w => shareRoot(targetWord, w));
        }
      } else {
        // Multi-word target term
        const allTargetWordsFound = targetWords.every((targetWord: string) => {
          if (draftWords.some((w: string) => w === targetWord) || draftLower.includes(targetWord)) {
            return true;
          }
          return draftWords.some((w: string) => shareRoot(targetWord, w));
        });
        foundInDraft = allTargetWordsFound;
      }
      
      // Try to find what was actually used in draft (if not the correct term)
      let actualFound: string | undefined;
      if (foundInSource && !foundInDraft) {
        // Try to find similar words or partial matches
        const similarWord = draftWords.find(w => {
          // Check for partial matches (at least 4 characters)
          const minLen = Math.max(4, Math.min(targetTermLower.length, w.length) - 2);
          return w.length >= minLen && (
            w.includes(targetTermLower.substring(0, minLen)) ||
            targetTermLower.includes(w.substring(0, minLen)) ||
            shareRoot(targetTermLower, w)
          );
        });
        if (similarWord) {
          actualFound = similarWord;
        }
      }

      return {
        entry,
        foundInSource,
        foundInDraft,
        correctTranslation: foundInSource ? foundInDraft : true, // If not in source, we don't care
        actualFound,
      };
    }).filter((compliance: GlossaryCompliance) => {
      const found = compliance.foundInSource;
      if (found) {
        console.log('Found glossary term:', {
          sourceTerm: compliance.entry.sourceTerm,
          targetTerm: compliance.entry.targetTerm,
          foundInDraft: compliance.foundInDraft,
          correctTranslation: compliance.correctTranslation,
        });
      }
      return found;
    }); // Only show terms that appear in source
  };

  // Step 2: Run Critic
  const handleRunCritic = async () => {
    setIsLoading(true);
    setLoadingMessage('Running QA critique...');
    try {
      // Check glossary compliance first
      const compliance = checkGlossaryCompliance(sourceText, editedDraftText);
      setGlossaryCompliance(compliance);

      // Use the current provider (from localStorage or project settings)
      const result = await aiApi.runCritique({
        sourceText,
        draftText: editedDraftText,
        projectId,
        sourceLocale, // Pass source locale for correct glossary filtering
        targetLocale, // Pass target locale for correct glossary filtering
        provider: currentProvider, // Pass current provider from localStorage/project settings
        model: aiSettings?.model, // Pass model from project settings
      });
      setCritiqueErrors(result.errors);
      setCritiqueReasoning(result.reasoning);
      setStep('critique-analysis');
      if (result.errors.length === 0) {
        toast.success('No errors found!');
      } else {
        toast.success(`Found ${result.errors.length} error(s)`);
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to run critique');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Skip critic and save draft
  const handleSkipCritic = async () => {
    setFinalText(editedDraftText);
    setStep('final-review');
  };

  // Step 3: Auto-Fix
  const handleAutoFix = async () => {
    if (critiqueErrors.length === 0) {
      setFinalText(editedDraftText);
      setStep('final-review');
      return;
    }

    setIsLoading(true);
    setLoadingMessage('Fixing errors with AI...');
    try {
      // Filter out any errors with missing required fields
      const validErrors = critiqueErrors.filter(
        (e) => e.term && e.expected && e.found && 
               e.term.trim() !== '' && e.expected.trim() !== '' && e.found.trim() !== ''
      );
      
      if (validErrors.length === 0) {
        toast.error('No valid errors to fix');
        setFinalText(editedDraftText);
        setStep('final-review');
        return;
      }
      
      // Use the current provider (from localStorage or project settings)
      const result = await aiApi.fixTranslation({
        sourceText,
        draftText: editedDraftText,
        errors: validErrors,
        projectId,
        sourceLocale,
        targetLocale,
        provider: currentProvider, // Pass current provider from localStorage/project settings
        model: aiSettings?.model, // Pass model from project settings
      });
      setFinalText(result.finalText);
      setStep('final-review');
      toast.success('Translation fixed successfully');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to fix translation');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Ignore errors and save draft
  const handleIgnoreAndSave = () => {
    setFinalText(editedDraftText);
    setStep('final-review');
  };

  // Step 4: Accept Final Translation
  const handleAccept = () => {
    onComplete(finalText);
  };

  const LoadingSpinner = () => (
    <div className="flex items-center justify-center py-4">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      {loadingMessage && <span className="ml-3 text-sm text-gray-600">{loadingMessage}</span>}
    </div>
  );

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-6 max-w-3xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Deep Agent Debugger</h2>
          <div className="flex items-center gap-4 mt-2">
            {currentProvider && (
              <p className="text-sm text-gray-600">
                Provider: <span className="font-medium capitalize text-primary-600">{currentProvider}</span>
                {modelUsed && <span className="ml-1 text-gray-500">({modelUsed})</span>}
                {aiSettings?.model && !modelUsed && <span className="ml-1 text-gray-500">({aiSettings.model})</span>}
              </p>
            )}
            {glossaryEntries && glossaryEntries.length > 0 && (
              <p className="text-sm text-gray-600">
                Glossary: <span className="font-medium text-primary-600">{glossaryEntries.length} terms</span>
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onCancel}
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Step Progress Indicator */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className={`text-sm font-medium ${step === 'start' ? 'text-primary-600' : 'text-gray-500'}`}>
            Step 1: Start
          </span>
          <span className={`text-sm font-medium ${step === 'review-draft' ? 'text-primary-600' : 'text-gray-500'}`}>
            Step 2: Review Draft
          </span>
          <span className={`text-sm font-medium ${step === 'critique-analysis' ? 'text-primary-600' : 'text-gray-500'}`}>
            Step 3: Critique
          </span>
          <span className={`text-sm font-medium ${step === 'final-review' ? 'text-primary-600' : 'text-gray-500'}`}>
            Step 4: Final
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-primary-600 h-2 rounded-full transition-all duration-300"
            style={{
              width: step === 'start' ? '25%' : step === 'review-draft' ? '50%' : step === 'critique-analysis' ? '75%' : '100%',
            }}
          ></div>
        </div>
      </div>

      {isLoading && <LoadingSpinner />}

      {/* STATE 1: Start */}
      {step === 'start' && !isLoading && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800">
              <strong>Step 1:</strong> The AI will generate an initial draft translation using the selected provider ({currentProvider}).
              {glossaryEntries && glossaryEntries.length > 0 && (
                <> Glossary terms will be considered during translation.</>
              )}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Source Text:</label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-gray-900 whitespace-pre-wrap min-h-[100px]">
              {sourceText}
            </div>
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleGenerateDraft}
              disabled={isLoading}
              className="btn btn-primary"
            >
              Generate Draft
            </button>
          </div>
        </div>
      )}

      {/* STATE 2: Review Draft */}
      {step === 'review-draft' && !isLoading && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800">
              <strong>Step 2:</strong> Review and edit the draft if needed. Then run the Critic (QA Agent) to check for glossary compliance and translation quality.
              {modelUsed && (
                <> Draft was generated using <span className="font-medium">{modelUsed}</span>.</>
              )}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Draft Text (Editable):
              {modelUsed && <span className="ml-2 text-xs text-gray-500">Generated by {modelUsed}</span>}
            </label>
            <textarea
              value={editedDraftText}
              onChange={(e) => setEditedDraftText(e.target.value)}
              className="input w-full min-h-[150px] font-medium"
              placeholder="Draft translation will appear here..."
            />
          </div>
          <div className="flex justify-end space-x-2">
            <button
              onClick={handleSkipCritic}
              className="btn btn-secondary"
            >
              Skip Critic & Save
            </button>
            <button
              onClick={handleRunCritic}
              disabled={isLoading || !editedDraftText.trim()}
              className="btn btn-primary"
            >
              Run Critic (QA)
            </button>
          </div>
        </div>
      )}

      {/* STATE 3: Critique Analysis */}
      {step === 'critique-analysis' && !isLoading && (
        <div className="space-y-4">
          {/* Glossary Compliance Checklist */}
          {glossaryCompliance.length > 0 && (
            <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-blue-900 mb-3 flex items-center">
                <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
                Glossary Compliance Checklist
              </h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {glossaryCompliance.map((compliance, index) => (
                  <div
                    key={index}
                    className={`flex items-start p-2 rounded border ${
                      compliance.correctTranslation
                        ? 'bg-green-50 border-green-200'
                        : 'bg-red-50 border-red-200'
                    }`}
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      {compliance.correctTranslation ? (
                        <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                    </div>
                    <div className="ml-2 flex-1 min-w-0">
                      <div className="text-sm">
                        <span className="font-medium text-gray-900">{compliance.entry.sourceTerm}</span>
                        <span className="text-gray-500 mx-1">→</span>
                        <span className="font-medium text-gray-900">{compliance.entry.targetTerm}</span>
                      </div>
                      {!compliance.correctTranslation && (
                        <div className="text-xs text-red-700 mt-1">
                          {compliance.actualFound ? (
                            <>Found: <span className="font-semibold">{compliance.actualFound}</span> (should be: {compliance.entry.targetTerm})</>
                          ) : (
                            <>Missing in translation</>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-blue-200">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-blue-700">
                    Compliant: <span className="font-semibold">{glossaryCompliance.filter(c => c.correctTranslation).length}</span> / {glossaryCompliance.length}
                  </span>
                  <span className={`font-semibold ${
                    glossaryCompliance.every(c => c.correctTranslation)
                      ? 'text-green-700'
                      : 'text-red-700'
                  }`}>
                    {Math.round((glossaryCompliance.filter(c => c.correctTranslation).length / glossaryCompliance.length) * 100)}% Compliant
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Critic's Opinion Alert */}
          <div className={`p-4 rounded-lg border-2 ${
            critiqueErrors.length === 0
              ? 'bg-green-50 border-green-200'
              : critiqueErrors.some(e => e.severity === 'error')
              ? 'bg-red-50 border-red-200'
              : 'bg-yellow-50 border-yellow-200'
          }`}>
            <div className="flex items-start">
              <div className="flex-shrink-0">
                {critiqueErrors.length === 0 ? (
                  <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ) : (
                  <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                )}
              </div>
              <div className="ml-3 flex-1">
                <h3 className={`text-sm font-semibold ${
                  critiqueErrors.length === 0
                    ? 'text-green-800'
                    : critiqueErrors.some(e => e.severity === 'error')
                    ? 'text-red-800'
                    : 'text-yellow-800'
                }`}>
                  AI Critic's Analysis
                </h3>
                {critiqueReasoning && (
                  <p className={`mt-1 text-sm whitespace-pre-wrap ${
                    critiqueErrors.length === 0
                      ? 'text-green-700'
                      : critiqueErrors.some(e => e.severity === 'error')
                      ? 'text-red-700'
                      : 'text-yellow-700'
                  }`}>
                    {critiqueReasoning}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Errors List */}
          {critiqueErrors.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Found Errors ({critiqueErrors.length}):
              </label>
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {critiqueErrors.map((error, index) => (
                  <div
                    key={index}
                    className={`p-3 rounded-lg border ${
                      error.severity === 'error'
                        ? 'bg-red-50 border-red-200'
                        : 'bg-yellow-50 border-yellow-200'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-900">
                          Term: <span className="font-bold">{error.term}</span>
                        </div>
                        <div className="text-sm text-gray-600 mt-1">
                          Expected: <span className="font-semibold text-green-700">{error.expected}</span>
                        </div>
                        <div className="text-sm text-gray-600">
                          Found: <span className="font-semibold text-red-700">{error.found}</span>
                        </div>
                      </div>
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        error.severity === 'error'
                          ? 'bg-red-200 text-red-800'
                          : 'bg-yellow-200 text-yellow-800'
                      }`}>
                        {error.severity}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {critiqueErrors.length === 0 && (
            <div className="space-y-3">
              <div className="text-center py-2">
                <p className="text-green-600 font-medium">✓ No errors found - translation looks good!</p>
              </div>
              
              {/* Show found glossary terms when no errors */}
              {glossaryCompliance.length > 0 && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-green-900 mb-3 flex items-center">
                    <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Glossary Terms Found & Verified ({glossaryCompliance.length})
                  </h4>
                  <div className="space-y-2 max-h-[200px] overflow-y-auto">
                    {glossaryCompliance.map((compliance, index) => (
                      <div
                        key={index}
                        className="flex items-start p-2 rounded bg-white border border-green-200"
                      >
                        <div className="flex-shrink-0 mt-0.5 mr-2">
                          {compliance.correctTranslation ? (
                            <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-gray-900">
                            <span className="text-gray-600">{compliance.entry.sourceTerm}</span>
                            <span className="mx-2 text-gray-400">→</span>
                            <span className="text-green-700">{compliance.entry.targetTerm}</span>
                          </div>
                          {compliance.entry.description && (
                            <div className="text-xs text-gray-500 mt-1 italic">
                              {compliance.entry.description}
                            </div>
                          )}
                          {compliance.entry.forbidden && (
                            <span className="inline-block mt-1 text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded">
                              FORBIDDEN
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {glossaryCompliance.length === 0 && (
                <div className="text-center py-2">
                  <p className="text-sm text-gray-500">No glossary terms found in this segment.</p>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end space-x-2">
            <button
              onClick={handleIgnoreAndSave}
              className="btn btn-secondary"
            >
              Ignore & Save Draft
            </button>
            {critiqueErrors.length > 0 && (
              <button
                onClick={handleAutoFix}
                disabled={isLoading}
                className="btn btn-primary"
              >
                Auto-Fix with AI
              </button>
            )}
            {critiqueErrors.length === 0 && (
              <button
                onClick={() => {
                  setFinalText(editedDraftText);
                  setStep('final-review');
                }}
                className="btn btn-primary"
              >
                Continue to Final Review
              </button>
            )}
          </div>
        </div>
      )}

      {/* STATE 4: Final Review */}
      {step === 'final-review' && !isLoading && (
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-sm text-green-800">
              <strong>Step 4:</strong> Review the final translation. 
              {critiqueErrors.length > 0 && (
                <> This version has been corrected based on {critiqueErrors.length} error(s) found by the Critic.</>
              )}
              {critiqueErrors.length === 0 && (
                <> No errors were found - the translation is ready.</>
              )}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Final Translation:</label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-gray-900 whitespace-pre-wrap min-h-[100px]">
              {finalText}
            </div>
          </div>
          {critiqueErrors.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-xs text-yellow-800">
                <strong>Note:</strong> {critiqueErrors.length} error(s) were automatically fixed by the Editor AI.
                {glossaryCompliance.length > 0 && (
                  <> Glossary compliance: {glossaryCompliance.filter(c => c.correctTranslation).length}/{glossaryCompliance.length} terms.</>
                )}
              </p>
            </div>
          )}
          <div className="flex justify-end space-x-2">
            <button
              onClick={() => {
                // Go back to critique if errors existed
                if (critiqueErrors.length > 0) {
                  setStep('critique-analysis');
                } else {
                  setStep('review-draft');
                }
              }}
              className="btn btn-secondary"
            >
              Go Back
            </button>
            <button
              onClick={handleAccept}
              className="btn btn-primary"
            >
              Accept Translation
            </button>
          </div>
        </div>
      )}
    </div>
  );
}




