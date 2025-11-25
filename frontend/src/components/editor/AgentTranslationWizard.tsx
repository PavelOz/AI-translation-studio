import { useState } from 'react';
import { useQuery } from 'react-query';
import { aiApi } from '../../api/ai.api';
import toast from 'react-hot-toast';

type AIProvider = 'gemini' | 'openai' | 'yandex';

interface AgentTranslationWizardProps {
  sourceText: string;
  projectId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  onComplete: (finalText: string) => void;
  onCancel: () => void;
}

type WizardStep = 'draft' | 'critique' | 'fix' | 'complete';

interface CritiqueError {
  term: string;
  expected: string;
  found: string;
  severity: string;
}

export default function AgentTranslationWizard({
  sourceText,
  projectId,
  sourceLocale,
  targetLocale,
  onComplete,
  onCancel,
}: AgentTranslationWizardProps) {
  // Load project AI settings
  const { data: aiSettings } = useQuery(
    ['ai-settings', projectId],
    () => (projectId ? aiApi.getAISettings(projectId) : Promise.resolve(null)),
    {
      enabled: !!projectId,
      staleTime: 30000,
    },
  );

  // Get current provider from localStorage
  const getCurrentProvider = (): AIProvider => {
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
    return aiSettings?.provider && ['gemini', 'openai', 'yandex'].includes(aiSettings.provider)
      ? (aiSettings.provider as AIProvider)
      : 'gemini';
  };

  const [step, setStep] = useState<WizardStep>('draft');
  const [draftText, setDraftText] = useState<string>('');
  const [critiqueErrors, setCritiqueErrors] = useState<CritiqueError[]>([]);
  const [critiqueReasoning, setCritiqueReasoning] = useState<string>('');
  const [finalText, setFinalText] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');

  // Step 1: Generate Draft
  const handleGenerateDraft = async () => {
    setIsLoading(true);
    setLoadingMessage('Generating draft translation...');
    try {
      const currentProvider = getCurrentProvider();
      const result = await aiApi.generateDraft({
        sourceText,
        projectId,
        sourceLocale,
        targetLocale,
        provider: currentProvider,
        model: aiSettings?.model,
      });
      setDraftText(result.draftText);
      setStep('critique');
      toast.success('Draft generated successfully');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to generate draft');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Step 2: Run Critique
  const handleRunCritique = async () => {
    if (!draftText) {
      toast.error('Please generate a draft first');
      return;
    }

    setIsLoading(true);
    setLoadingMessage('Running critique analysis...');
    try {
      const currentProvider = getCurrentProvider();
      const result = await aiApi.runCritique({
        sourceText,
        draftText,
        projectId,
        provider: currentProvider,
        model: aiSettings?.model,
      });
      
      setCritiqueErrors(result.errors);
      setCritiqueReasoning(result.reasoning || '');
      
      if (result.errors.length === 0) {
        // No errors - show success state
        setStep('complete');
        setFinalText(draftText);
        toast.success('No errors found! Translation is ready.');
      } else {
        // Errors found - proceed to fix step
        setStep('fix');
        toast.warning(`Found ${result.errors.length} error(s)`);
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to run critique');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Step 3: Fix Translation
  const handleFixTranslation = async () => {
    if (!draftText || critiqueErrors.length === 0) {
      toast.error('No errors to fix');
      return;
    }

    setIsLoading(true);
    setLoadingMessage('Fixing translation errors...');
    try {
      const currentProvider = getCurrentProvider();
      const result = await aiApi.fixTranslation({
        sourceText,
        draftText,
        errors: critiqueErrors,
        projectId,
        provider: currentProvider,
        model: aiSettings?.model,
      });
      setFinalText(result.finalText);
      setStep('complete');
      toast.success('Translation fixed successfully');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to fix translation');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Handle completion
  const handleAccept = () => {
    if (finalText) {
      onComplete(finalText);
    }
  };

  const handleUseDraft = () => {
    if (draftText) {
      onComplete(draftText);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Agent Translation Wizard</h2>
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
          <span className={`text-sm font-medium ${step === 'draft' ? 'text-primary-600' : step !== 'draft' ? 'text-gray-900' : 'text-gray-500'}`}>
            Step 1: Draft
          </span>
          <span className={`text-sm font-medium ${step === 'critique' ? 'text-primary-600' : step === 'fix' || step === 'complete' ? 'text-gray-900' : 'text-gray-500'}`}>
            Step 2: Critique
          </span>
          <span className={`text-sm font-medium ${step === 'fix' ? 'text-primary-600' : step === 'complete' ? 'text-gray-900' : 'text-gray-500'}`}>
            Step 3: Fix
          </span>
          <span className={`text-sm font-medium ${step === 'complete' ? 'text-primary-600' : 'text-gray-500'}`}>
            Complete
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-primary-600 h-2 rounded-full transition-all duration-300"
            style={{
              width:
                step === 'draft' ? '25%' : step === 'critique' ? '50%' : step === 'fix' ? '75%' : '100%',
            }}
          />
        </div>
      </div>

      {/* Loading Spinner */}
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          {loadingMessage && <span className="ml-3 text-sm text-gray-600">{loadingMessage}</span>}
        </div>
      )}

      {/* Step 1: Draft */}
      {step === 'draft' && !isLoading && (
        <div className="space-y-4">
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
              className="btn btn-primary px-6 py-2"
            >
              Generate Draft
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Critique */}
      {step === 'critique' && !isLoading && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Draft Translation:</label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-gray-900 whitespace-pre-wrap min-h-[100px]">
              {draftText}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={handleUseDraft}
              className="btn btn-secondary px-6 py-2"
            >
              Use Draft As-Is
            </button>
            <button
              onClick={handleRunCritique}
              disabled={isLoading}
              className="btn btn-primary px-6 py-2"
            >
              Run Critique
            </button>
          </div>
        </div>
      )}

      {/* Step 2 Result: No Errors (Success) */}
      {step === 'complete' && critiqueErrors.length === 0 && !isLoading && (
        <div className="space-y-4">
          <div className="bg-green-50 border-2 border-green-200 rounded-lg p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-green-800">Translation Approved</h3>
                <p className="mt-1 text-sm text-green-700">
                  No errors found. The translation meets all quality standards.
                </p>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Final Translation:</label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-gray-900 whitespace-pre-wrap min-h-[100px]">
              {finalText || draftText}
            </div>
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleAccept}
              className="btn btn-primary px-6 py-2"
            >
              Accept Translation
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Fix (Errors Found) */}
      {step === 'fix' && !isLoading && (
        <div className="space-y-4">
          {/* Error Alert - Shows reasoning from API */}
          <div className="bg-red-50 border-2 border-red-200 rounded-lg p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-red-800 mb-1">Errors Found</h3>
                {critiqueReasoning && (
                  <p className="text-sm text-red-700 whitespace-pre-wrap mb-2">
                    {critiqueReasoning}
                  </p>
                )}
                <p className="text-sm text-red-600 font-medium">
                  {critiqueErrors.length} error(s) need to be corrected.
                </p>
              </div>
            </div>
          </div>

          {/* Error List */}
          {critiqueErrors.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Found Errors ({critiqueErrors.length}):
              </label>
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3 max-h-64 overflow-y-auto">
                {critiqueErrors.map((error, index) => (
                  <div key={index} className="border-l-4 border-red-400 pl-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-900">Term: {error.term}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          error.severity === 'error'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-yellow-100 text-yellow-800'
                        }`}
                      >
                        {error.severity}
                      </span>
                    </div>
                    <div className="text-sm text-gray-700">
                      <span className="font-medium">Expected:</span> {error.expected}
                    </div>
                    <div className="text-sm text-gray-700">
                      <span className="font-medium">Found:</span> {error.found}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={handleUseDraft}
              className="btn btn-secondary px-6 py-2"
            >
              Use Draft Anyway
            </button>
            <button
              onClick={handleFixTranslation}
              disabled={isLoading}
              className="btn btn-primary px-6 py-2"
            >
              Auto-Fix with AI
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Complete (After Fix) */}
      {step === 'complete' && critiqueErrors.length > 0 && !isLoading && (
        <div className="space-y-4">
          <div className="bg-green-50 border-2 border-green-200 rounded-lg p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-green-800">Translation Fixed</h3>
                <p className="mt-1 text-sm text-green-700">
                  All errors have been corrected. The translation is ready for review.
                </p>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Fixed Translation:</label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-gray-900 whitespace-pre-wrap min-h-[100px]">
              {finalText}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setStep('fix')}
              className="btn btn-secondary px-6 py-2"
            >
              Back to Errors
            </button>
            <button
              onClick={handleAccept}
              className="btn btn-primary px-6 py-2"
            >
              Accept Translation
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


import { aiApi } from '../../api/ai.api';
import toast from 'react-hot-toast';

type AIProvider = 'gemini' | 'openai' | 'yandex';

interface AgentTranslationWizardProps {
  sourceText: string;
  projectId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  onComplete: (finalText: string) => void;
  onCancel: () => void;
}

type WizardStep = 'draft' | 'critique' | 'fix' | 'complete';

interface CritiqueError {
  term: string;
  expected: string;
  found: string;
  severity: string;
}

export default function AgentTranslationWizard({
  sourceText,
  projectId,
  sourceLocale,
  targetLocale,
  onComplete,
  onCancel,
}: AgentTranslationWizardProps) {
  // Load project AI settings
  const { data: aiSettings } = useQuery(
    ['ai-settings', projectId],
    () => (projectId ? aiApi.getAISettings(projectId) : Promise.resolve(null)),
    {
      enabled: !!projectId,
      staleTime: 30000,
    },
  );

  // Get current provider from localStorage
  const getCurrentProvider = (): AIProvider => {
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
    return aiSettings?.provider && ['gemini', 'openai', 'yandex'].includes(aiSettings.provider)
      ? (aiSettings.provider as AIProvider)
      : 'gemini';
  };

  const [step, setStep] = useState<WizardStep>('draft');
  const [draftText, setDraftText] = useState<string>('');
  const [critiqueErrors, setCritiqueErrors] = useState<CritiqueError[]>([]);
  const [critiqueReasoning, setCritiqueReasoning] = useState<string>('');
  const [finalText, setFinalText] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');

  // Step 1: Generate Draft
  const handleGenerateDraft = async () => {
    setIsLoading(true);
    setLoadingMessage('Generating draft translation...');
    try {
      const currentProvider = getCurrentProvider();
      const result = await aiApi.generateDraft({
        sourceText,
        projectId,
        sourceLocale,
        targetLocale,
        provider: currentProvider,
        model: aiSettings?.model,
      });
      setDraftText(result.draftText);
      setStep('critique');
      toast.success('Draft generated successfully');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to generate draft');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Step 2: Run Critique
  const handleRunCritique = async () => {
    if (!draftText) {
      toast.error('Please generate a draft first');
      return;
    }

    setIsLoading(true);
    setLoadingMessage('Running critique analysis...');
    try {
      const currentProvider = getCurrentProvider();
      const result = await aiApi.runCritique({
        sourceText,
        draftText,
        projectId,
        provider: currentProvider,
        model: aiSettings?.model,
      });
      
      setCritiqueErrors(result.errors);
      setCritiqueReasoning(result.reasoning || '');
      
      if (result.errors.length === 0) {
        // No errors - show success state
        setStep('complete');
        setFinalText(draftText);
        toast.success('No errors found! Translation is ready.');
      } else {
        // Errors found - proceed to fix step
        setStep('fix');
        toast.warning(`Found ${result.errors.length} error(s)`);
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to run critique');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Step 3: Fix Translation
  const handleFixTranslation = async () => {
    if (!draftText || critiqueErrors.length === 0) {
      toast.error('No errors to fix');
      return;
    }

    setIsLoading(true);
    setLoadingMessage('Fixing translation errors...');
    try {
      const currentProvider = getCurrentProvider();
      const result = await aiApi.fixTranslation({
        sourceText,
        draftText,
        errors: critiqueErrors,
        projectId,
        provider: currentProvider,
        model: aiSettings?.model,
      });
      setFinalText(result.finalText);
      setStep('complete');
      toast.success('Translation fixed successfully');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to fix translation');
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Handle completion
  const handleAccept = () => {
    if (finalText) {
      onComplete(finalText);
    }
  };

  const handleUseDraft = () => {
    if (draftText) {
      onComplete(draftText);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Agent Translation Wizard</h2>
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
          <span className={`text-sm font-medium ${step === 'draft' ? 'text-primary-600' : step !== 'draft' ? 'text-gray-900' : 'text-gray-500'}`}>
            Step 1: Draft
          </span>
          <span className={`text-sm font-medium ${step === 'critique' ? 'text-primary-600' : step === 'fix' || step === 'complete' ? 'text-gray-900' : 'text-gray-500'}`}>
            Step 2: Critique
          </span>
          <span className={`text-sm font-medium ${step === 'fix' ? 'text-primary-600' : step === 'complete' ? 'text-gray-900' : 'text-gray-500'}`}>
            Step 3: Fix
          </span>
          <span className={`text-sm font-medium ${step === 'complete' ? 'text-primary-600' : 'text-gray-500'}`}>
            Complete
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-primary-600 h-2 rounded-full transition-all duration-300"
            style={{
              width:
                step === 'draft' ? '25%' : step === 'critique' ? '50%' : step === 'fix' ? '75%' : '100%',
            }}
          />
        </div>
      </div>

      {/* Loading Spinner */}
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          {loadingMessage && <span className="ml-3 text-sm text-gray-600">{loadingMessage}</span>}
        </div>
      )}

      {/* Step 1: Draft */}
      {step === 'draft' && !isLoading && (
        <div className="space-y-4">
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
              className="btn btn-primary px-6 py-2"
            >
              Generate Draft
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Critique */}
      {step === 'critique' && !isLoading && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Draft Translation:</label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-gray-900 whitespace-pre-wrap min-h-[100px]">
              {draftText}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={handleUseDraft}
              className="btn btn-secondary px-6 py-2"
            >
              Use Draft As-Is
            </button>
            <button
              onClick={handleRunCritique}
              disabled={isLoading}
              className="btn btn-primary px-6 py-2"
            >
              Run Critique
            </button>
          </div>
        </div>
      )}

      {/* Step 2 Result: No Errors (Success) */}
      {step === 'complete' && critiqueErrors.length === 0 && !isLoading && (
        <div className="space-y-4">
          <div className="bg-green-50 border-2 border-green-200 rounded-lg p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-green-800">Translation Approved</h3>
                <p className="mt-1 text-sm text-green-700">
                  No errors found. The translation meets all quality standards.
                </p>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Final Translation:</label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-gray-900 whitespace-pre-wrap min-h-[100px]">
              {finalText || draftText}
            </div>
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleAccept}
              className="btn btn-primary px-6 py-2"
            >
              Accept Translation
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Fix (Errors Found) */}
      {step === 'fix' && !isLoading && (
        <div className="space-y-4">
          {/* Error Alert - Shows reasoning from API */}
          <div className="bg-red-50 border-2 border-red-200 rounded-lg p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-red-800 mb-1">Errors Found</h3>
                {critiqueReasoning && (
                  <p className="text-sm text-red-700 whitespace-pre-wrap mb-2">
                    {critiqueReasoning}
                  </p>
                )}
                <p className="text-sm text-red-600 font-medium">
                  {critiqueErrors.length} error(s) need to be corrected.
                </p>
              </div>
            </div>
          </div>

          {/* Error List */}
          {critiqueErrors.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Found Errors ({critiqueErrors.length}):
              </label>
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3 max-h-64 overflow-y-auto">
                {critiqueErrors.map((error, index) => (
                  <div key={index} className="border-l-4 border-red-400 pl-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-900">Term: {error.term}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          error.severity === 'error'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-yellow-100 text-yellow-800'
                        }`}
                      >
                        {error.severity}
                      </span>
                    </div>
                    <div className="text-sm text-gray-700">
                      <span className="font-medium">Expected:</span> {error.expected}
                    </div>
                    <div className="text-sm text-gray-700">
                      <span className="font-medium">Found:</span> {error.found}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={handleUseDraft}
              className="btn btn-secondary px-6 py-2"
            >
              Use Draft Anyway
            </button>
            <button
              onClick={handleFixTranslation}
              disabled={isLoading}
              className="btn btn-primary px-6 py-2"
            >
              Auto-Fix with AI
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Complete (After Fix) */}
      {step === 'complete' && critiqueErrors.length > 0 && !isLoading && (
        <div className="space-y-4">
          <div className="bg-green-50 border-2 border-green-200 rounded-lg p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-green-800">Translation Fixed</h3>
                <p className="mt-1 text-sm text-green-700">
                  All errors have been corrected. The translation is ready for review.
                </p>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Fixed Translation:</label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-gray-900 whitespace-pre-wrap min-h-[100px]">
              {finalText}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setStep('fix')}
              className="btn btn-secondary px-6 py-2"
            >
              Back to Errors
            </button>
            <button
              onClick={handleAccept}
              className="btn btn-primary px-6 py-2"
            >
              Accept Translation
            </button>
          </div>
        </div>
      )}
    </div>
  );
}






