import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { aiApi } from '../api/ai.api';
import toast from 'react-hot-toast';

interface ProjectAISettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
}

export default function ProjectAISettingsModal({
  isOpen,
  onClose,
  projectId,
}: ProjectAISettingsModalProps) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude'>('openai');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [yandexApiKey, setYandexApiKey] = useState('');
  const [yandexFolderId, setYandexFolderId] = useState('');
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [claudeApiKey, setClaudeApiKey] = useState('');
  const [showOpenaiApiKey, setShowOpenaiApiKey] = useState(false);
  const [showGeminiApiKey, setShowGeminiApiKey] = useState(false);
  const [showYandexApiKey, setShowYandexApiKey] = useState(false);
  const [showDeepseekApiKey, setShowDeepseekApiKey] = useState(false);
  const [showClaudeApiKey, setShowClaudeApiKey] = useState(false);
  const [testingProvider, setTestingProvider] = useState<'openai' | 'gemini' | 'yandex' | 'deepseek' | 'claude' | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  
  // Auto-propagation settings
  const [autoPropagationEnabled, setAutoPropagationEnabled] = useState(true);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.95);

  const { data: aiSettings, isLoading } = useQuery(
    ['ai-settings', projectId],
    () => aiApi.getAISettings(projectId),
    {
      enabled: isOpen && !!projectId,
    },
  );

  const { data: providers } = useQuery(['ai-providers'], () => aiApi.listProviders(), {
    enabled: isOpen,
  });

  const { data: availableModels } = useQuery(
    ['ai-models', provider],
    () => aiApi.getAvailableModels(provider),
    {
      enabled: isOpen,
      onSuccess: (models) => {
        // Set default model if not already set or if current model is not in the list
        if (!selectedModel || !models.includes(selectedModel)) {
          const defaultModel = providers?.find((p) => p.name === provider)?.defaultModel;
          if (defaultModel && models.includes(defaultModel)) {
            setSelectedModel(defaultModel);
          } else if (models.length > 0) {
            setSelectedModel(models[0]);
          }
        }
      },
    },
  );

  const updateMutation = useMutation({
    mutationFn: (data: {
      provider: string;
      model: string;
      config?: Record<string, unknown>;
      temperature?: number;
      maxTokens?: number;
    }) => {
      return aiApi.upsertAISettings(projectId, {
        provider: data.provider,
        model: data.model,
        temperature: data.temperature,
        maxTokens: data.maxTokens,
        config: data.config,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-settings', projectId] });
      toast.success('AI settings saved successfully');
      onClose();
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to save AI settings');
    },
  });

  useEffect(() => {
    if (aiSettings) {
      const providerValue = aiSettings.provider as 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude';
      setProvider(providerValue);
      if (aiSettings.model) {
        setSelectedModel(aiSettings.model);
      } else {
        // If no model is set, use default from provider
        const defaultModel = providers?.find((p) => p.name === providerValue)?.defaultModel;
        if (defaultModel) {
          setSelectedModel(defaultModel);
        }
      }
      // Extract API keys from config if available
      if (aiSettings.config && typeof aiSettings.config === 'object') {
        const config = aiSettings.config as Record<string, unknown>;
        if (config.openaiApiKey) setOpenaiApiKey(String(config.openaiApiKey));
        if (config.geminiApiKey) setGeminiApiKey(String(config.geminiApiKey));
        if (config.yandexApiKey) setYandexApiKey(String(config.yandexApiKey));
        if (config.yandexFolderId) setYandexFolderId(String(config.yandexFolderId));
        if (config.deepseekApiKey) setDeepseekApiKey(String(config.deepseekApiKey));
        if (config.claudeApiKey) setClaudeApiKey(String(config.claudeApiKey));
        // Legacy support: if apiKey exists, assign it to the selected provider
        if (config.apiKey && !config.openaiApiKey && !config.geminiApiKey && !config.yandexApiKey && !config.deepseekApiKey && !config.claudeApiKey) {
          const key = String(config.apiKey);
          if (aiSettings.provider === 'openai') setOpenaiApiKey(key);
          else if (aiSettings.provider === 'gemini') setGeminiApiKey(key);
          else if (aiSettings.provider === 'yandex') setYandexApiKey(key);
          else if (aiSettings.provider === 'deepseek') setDeepseekApiKey(key);
          else if (aiSettings.provider === 'claude') setClaudeApiKey(key);
        }
        
        // Extract auto-propagation settings
        if (config.autoPropagation && typeof config.autoPropagation === 'object') {
          const autoProp = config.autoPropagation as Record<string, unknown>;
          if (typeof autoProp.enabled === 'boolean') {
            setAutoPropagationEnabled(autoProp.enabled);
          }
          if (typeof autoProp.similarityThreshold === 'number') {
            setSimilarityThreshold(Math.max(0.5, Math.min(1.0, autoProp.similarityThreshold)));
          }
        }
      }
    } else if (providers && providers.length > 0) {
      // Default to OpenAI if available
      const openaiProvider = providers.find((p) => p.name === 'openai');
      if (openaiProvider) {
        setProvider('openai');
      }
    }
  }, [aiSettings, providers]);

  const handleSave = () => {
    const selectedProviderData = providers?.find((p) => p.name === provider);
    if (!selectedProviderData) {
      toast.error('Selected provider not found');
      return;
    }

    // Build config with all API keys and auto-propagation settings
    // Preserve existing config to avoid losing other settings
    const existingConfig = aiSettings?.config && typeof aiSettings.config === 'object' 
      ? (aiSettings.config as Record<string, unknown>)
      : {};
    
    const config: Record<string, unknown> = { ...existingConfig };
    
    // Update API keys (only update if provided, preserve existing otherwise)
    if (openaiApiKey.trim()) {
      config.openaiApiKey = openaiApiKey.trim();
    } else if (existingConfig.openaiApiKey) {
      // Preserve existing key if not changed
      config.openaiApiKey = existingConfig.openaiApiKey;
    }
    if (geminiApiKey.trim()) {
      config.geminiApiKey = geminiApiKey.trim();
    } else if (existingConfig.geminiApiKey) {
      config.geminiApiKey = existingConfig.geminiApiKey;
    }
    if (yandexApiKey.trim()) {
      config.yandexApiKey = yandexApiKey.trim();
    } else if (existingConfig.yandexApiKey) {
      config.yandexApiKey = existingConfig.yandexApiKey;
    }
    if (yandexFolderId.trim()) {
      config.yandexFolderId = yandexFolderId.trim();
    } else if (existingConfig.yandexFolderId) {
      config.yandexFolderId = existingConfig.yandexFolderId;
    }
    if (deepseekApiKey.trim()) {
      config.deepseekApiKey = deepseekApiKey.trim();
    } else if (existingConfig.deepseekApiKey) {
      config.deepseekApiKey = existingConfig.deepseekApiKey;
    }
    if (claudeApiKey.trim()) {
      config.claudeApiKey = claudeApiKey.trim();
    } else if (existingConfig.claudeApiKey) {
      config.claudeApiKey = existingConfig.claudeApiKey;
    }
    
    // Add/update auto-propagation settings
    config.autoPropagation = {
      enabled: autoPropagationEnabled,
      similarityThreshold: similarityThreshold,
    };

    if (!selectedModel) {
      toast.error('Please select a model');
      return;
    }

    updateMutation.mutate({
      provider,
      model: selectedModel,
      config: Object.keys(config).length > 0 ? config : undefined,
    });
  };

  const handleTestCredentials = async (testProvider: 'openai' | 'gemini' | 'yandex' | 'deepseek' | 'claude') => {
    let apiKeyToTest = '';
    let folderIdToTest = '';
    if (testProvider === 'openai') apiKeyToTest = openaiApiKey.trim();
    else if (testProvider === 'gemini') apiKeyToTest = geminiApiKey.trim();
    else if (testProvider === 'yandex') {
      apiKeyToTest = yandexApiKey.trim();
      folderIdToTest = yandexFolderId.trim();
    } else if (testProvider === 'deepseek') apiKeyToTest = deepseekApiKey.trim();
    else if (testProvider === 'claude') apiKeyToTest = claudeApiKey.trim();

    if (!apiKeyToTest) {
      toast.error(`Please enter a ${testProvider} API key to test`);
      return;
    }

    if (testProvider === 'yandex' && !folderIdToTest) {
      toast.error('Please enter Yandex Folder ID to test');
      return;
    }

    setTestingProvider(testProvider);
    setTestResults((prev) => ({ ...prev, [testProvider]: { success: false, message: 'Testing...' } }));

    try {
      const result = await aiApi.testCredentials({
        provider: testProvider,
        apiKey: apiKeyToTest,
        ...(testProvider === 'yandex' && folderIdToTest ? { yandexFolderId: folderIdToTest } : {}),
      });

      setTestResults((prev) => ({
        ...prev,
        [testProvider]: { success: result.success, message: result.message },
      }));

      if (result.success) {
        toast.success(`${testProvider.charAt(0).toUpperCase() + testProvider.slice(1)} credentials are valid!`);
      } else {
        toast.error(`Credential test failed: ${result.message}`);
      }
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || 'Failed to test credentials';
      setTestResults((prev) => ({
        ...prev,
        [testProvider]: { success: false, message: errorMessage },
      }));
      toast.error(errorMessage);
    } finally {
      setTestingProvider(null);
    }
  };

  if (!isOpen) return null;

  const selectedProviderData = providers?.find((p) => p.name === provider);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-900">AI Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
            disabled={updateMutation.isLoading}
          >
            ×
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-8">Loading...</div>
        ) : (
          <div className="space-y-4">
            {/* Provider Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                AI Provider *
              </label>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude');
                  // Reset model selection when provider changes
                  setSelectedModel('');
                }}
                className="input w-full"
                disabled={updateMutation.isLoading}
              >
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI (ChatGPT)</option>
                <option value="yandex">Yandex GPT</option>
                <option value="deepseek">DeepSeek</option>
                <option value="claude">Anthropic Claude</option>
              </select>
              {selectedProviderData && (
                <p className="text-xs text-gray-500 mt-1">
                  Default model: {selectedProviderData.defaultModel}
                </p>
              )}
            </div>

            {/* Model Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                AI Model *
              </label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="input w-full"
                disabled={updateMutation.isLoading || !availableModels || availableModels.length === 0}
              >
                {!availableModels || availableModels.length === 0 ? (
                  <option value="">Loading models...</option>
                ) : (
                  <>
                    <option value="">Select a model</option>
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                        {model === selectedProviderData?.defaultModel ? ' (default)' : ''}
                      </option>
                    ))}
                  </>
                )}
              </select>
              {selectedModel && (
                <p className="text-xs text-gray-500 mt-1">
                  Selected: {selectedModel}
                </p>
              )}
            </div>

            {/* OpenAI API Key */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  OpenAI API Key
                </label>
                <button
                  type="button"
                  onClick={() => setShowOpenaiApiKey(!showOpenaiApiKey)}
                  className="text-xs text-primary-600 hover:text-primary-700"
                >
                  {showOpenaiApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                type={showOpenaiApiKey ? 'text' : 'password'}
                value={openaiApiKey}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
                placeholder="Enter OpenAI API key (sk-...)"
                className="input w-full"
                disabled={updateMutation.isLoading}
              />
              <div className="flex items-center justify-between mt-1">
                <p className="text-xs text-gray-500">
                  Get your API key from{' '}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 hover:underline"
                  >
                    OpenAI Platform
                  </a>
                </p>
                {openaiApiKey.trim() && (
                  <button
                    type="button"
                    onClick={() => handleTestCredentials('openai')}
                    disabled={testingProvider === 'openai' || updateMutation.isLoading}
                    className="text-xs text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
                  >
                    {testingProvider === 'openai' ? (
                      <span className="flex items-center gap-1">
                        <svg
                          className="animate-spin h-3 w-3"
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
                        Testing...
                      </span>
                    ) : (
                      'Test credentials'
                    )}
                  </button>
                )}
              </div>
              {testResults.openai && (
                <div
                  className={`text-xs mt-1 px-2 py-1 rounded ${
                    testResults.openai.success
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-red-50 text-red-700 border border-red-200'
                  }`}
                >
                  {testResults.openai.success ? '✓' : '✗'} {testResults.openai.message}
                </div>
              )}
            </div>

            {/* Gemini API Key */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Google Gemini API Key
                </label>
                <button
                  type="button"
                  onClick={() => setShowGeminiApiKey(!showGeminiApiKey)}
                  className="text-xs text-primary-600 hover:text-primary-700"
                >
                  {showGeminiApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                type={showGeminiApiKey ? 'text' : 'password'}
                value={geminiApiKey}
                onChange={(e) => setGeminiApiKey(e.target.value)}
                placeholder="Enter Gemini API key"
                className="input w-full"
                disabled={updateMutation.isLoading}
              />
              <div className="flex items-center justify-between mt-1">
                <p className="text-xs text-gray-500">
                  Get your API key from{' '}
                  <a
                    href="https://makersuite.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 hover:underline"
                  >
                    Google AI Studio
                  </a>
                </p>
                {geminiApiKey.trim() && (
                  <button
                    type="button"
                    onClick={() => handleTestCredentials('gemini')}
                    disabled={testingProvider === 'gemini' || updateMutation.isLoading}
                    className="text-xs text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
                  >
                    {testingProvider === 'gemini' ? (
                      <span className="flex items-center gap-1">
                        <svg
                          className="animate-spin h-3 w-3"
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
                        Testing...
                      </span>
                    ) : (
                      'Test credentials'
                    )}
                  </button>
                )}
              </div>
              {testResults.gemini && (
                <div
                  className={`text-xs mt-1 px-2 py-1 rounded ${
                    testResults.gemini.success
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-red-50 text-red-700 border border-red-200'
                  }`}
                >
                  {testResults.gemini.success ? '✓' : '✗'} {testResults.gemini.message}
                </div>
              )}
            </div>

            {/* Yandex API Key */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Yandex GPT API Key
                </label>
                <button
                  type="button"
                  onClick={() => setShowYandexApiKey(!showYandexApiKey)}
                  className="text-xs text-primary-600 hover:text-primary-700"
                >
                  {showYandexApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                type={showYandexApiKey ? 'text' : 'password'}
                value={yandexApiKey}
                onChange={(e) => setYandexApiKey(e.target.value)}
                placeholder="Enter Yandex API key"
                className="input w-full"
                disabled={updateMutation.isLoading}
              />
              <div className="flex items-center justify-between mt-1">
                <p className="text-xs text-gray-500">
                  Get your API key from{' '}
                  <a
                    href="https://cloud.yandex.ru/docs/iam/operations/api-key/create"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 hover:underline"
                  >
                    Yandex Cloud
                  </a>
                </p>
                {yandexApiKey.trim() && (
                  <button
                    type="button"
                    onClick={() => handleTestCredentials('yandex')}
                    disabled={testingProvider === 'yandex' || updateMutation.isLoading}
                    className="text-xs text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
                  >
                    {testingProvider === 'yandex' ? (
                      <span className="flex items-center gap-1">
                        <svg
                          className="animate-spin h-3 w-3"
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
                        Testing...
                      </span>
                    ) : (
                      'Test credentials'
                    )}
                  </button>
                )}
              </div>
              {testResults.yandex && (
                <div
                  className={`text-xs mt-1 px-2 py-1 rounded ${
                    testResults.yandex.success
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-red-50 text-red-700 border border-red-200'
                  }`}
                >
                  {testResults.yandex.success ? '✓' : '✗'} {testResults.yandex.message}
                </div>
              )}
            </div>

            {/* Yandex Folder ID */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Yandex GPT Folder ID <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={yandexFolderId}
                onChange={(e) => setYandexFolderId(e.target.value)}
                placeholder="Enter Yandex Cloud Folder ID (required for YandexGPT)"
                className="input w-full"
                disabled={updateMutation.isLoading}
              />
              <p className="text-xs text-gray-500 mt-1">
                Required for YandexGPT. Find your Folder ID in{' '}
                <a
                  href="https://console.cloud.yandex.ru/folders"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-600 hover:underline"
                >
                  Yandex Cloud Console
                </a>
                {' '}(Settings → Folder ID)
              </p>
            </div>

            {/* DeepSeek API Key */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  DeepSeek API Key
                </label>
                <button
                  type="button"
                  onClick={() => setShowDeepseekApiKey(!showDeepseekApiKey)}
                  className="text-xs text-primary-600 hover:text-primary-700"
                >
                  {showDeepseekApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                type={showDeepseekApiKey ? 'text' : 'password'}
                value={deepseekApiKey}
                onChange={(e) => setDeepseekApiKey(e.target.value)}
                placeholder="Enter DeepSeek API key"
                className="input w-full"
                disabled={updateMutation.isLoading}
              />
              <div className="flex items-center justify-between mt-1">
                <p className="text-xs text-gray-500">
                  Get your API key from{' '}
                  <a
                    href="https://platform.deepseek.com/api_keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 hover:underline"
                  >
                    DeepSeek Platform
                  </a>
                </p>
                {deepseekApiKey.trim() && (
                  <button
                    type="button"
                    onClick={() => handleTestCredentials('deepseek')}
                    disabled={testingProvider === 'deepseek' || updateMutation.isLoading}
                    className="text-xs text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
                  >
                    {testingProvider === 'deepseek' ? (
                      <span className="flex items-center gap-1">
                        <svg
                          className="animate-spin h-3 w-3"
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
                        Testing...
                      </span>
                    ) : (
                      'Test credentials'
                    )}
                  </button>
                )}
              </div>
              {testResults.deepseek && (
                <div
                  className={`text-xs mt-1 px-2 py-1 rounded ${
                    testResults.deepseek.success
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-red-50 text-red-700 border border-red-200'
                  }`}
                >
                  {testResults.deepseek.success ? '✓' : '✗'} {testResults.deepseek.message}
                </div>
              )}
            </div>

            {/* Claude API Key */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Anthropic Claude API Key
                </label>
                <button
                  type="button"
                  onClick={() => setShowClaudeApiKey(!showClaudeApiKey)}
                  className="text-xs text-primary-600 hover:text-primary-700"
                >
                  {showClaudeApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                type={showClaudeApiKey ? 'text' : 'password'}
                value={claudeApiKey}
                onChange={(e) => setClaudeApiKey(e.target.value)}
                placeholder="Enter Anthropic Claude API key"
                className="input w-full"
                disabled={updateMutation.isLoading}
              />
              <div className="flex items-center justify-between mt-1">
                <p className="text-xs text-gray-500">
                  Get your API key from{' '}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 hover:underline"
                  >
                    Anthropic Console
                  </a>
                </p>
                {claudeApiKey.trim() && (
                  <button
                    type="button"
                    onClick={() => handleTestCredentials('claude')}
                    disabled={testingProvider === 'claude' || updateMutation.isLoading}
                    className="text-xs text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
                  >
                    {testingProvider === 'claude' ? (
                      <span className="flex items-center gap-1">
                        <svg
                          className="animate-spin h-3 w-3"
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
                        Testing...
                      </span>
                    ) : (
                      'Test credentials'
                    )}
                  </button>
                )}
              </div>
              {testResults.claude && (
                <div
                  className={`text-xs mt-1 px-2 py-1 rounded ${
                    testResults.claude.success
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-red-50 text-red-700 border border-red-200'
                  }`}
                >
                  {testResults.claude.success ? '✓' : '✗'} {testResults.claude.message}
                </div>
              )}
            </div>

            {/* Auto-Propagation Settings */}
            <div className="border-t pt-4 mt-4">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Auto-Propagation Settings</h3>
              <p className="text-sm text-gray-600 mb-4">
                When you confirm a segment, automatically apply the same translation to similar segments in the same document.
              </p>
              
              <div className="space-y-4">
                {/* Enable/Disable */}
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="autoPropagationEnabled"
                    checked={autoPropagationEnabled}
                    onChange={(e) => setAutoPropagationEnabled(e.target.checked)}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                    disabled={updateMutation.isLoading}
                  />
                  <label htmlFor="autoPropagationEnabled" className="ml-2 block text-sm text-gray-700">
                    Enable auto-propagation
                  </label>
                </div>

                {/* Similarity Threshold */}
                {autoPropagationEnabled && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Similarity Threshold: {(similarityThreshold * 100).toFixed(0)}%
                    </label>
                    <input
                      type="range"
                      min="0.5"
                      max="1.0"
                      step="0.01"
                      value={similarityThreshold}
                      onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                      disabled={updateMutation.isLoading}
                    />
                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                      <span>50% (More matches)</span>
                      <span>100% (Exact matches only)</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Segments with similarity ≥ {(similarityThreshold * 100).toFixed(0)}% will automatically receive the same translation when you confirm a segment.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Info */}
            <div className="bg-blue-50 border border-blue-200 rounded p-3">
              <p className="text-sm text-blue-800">
                <strong>Note:</strong> API keys are stored securely per provider. The selected provider above will be used for translations. 
                If no API key is provided for a provider, the system will use the default API key from environment variables.
              </p>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-secondary"
                disabled={updateMutation.isLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="btn btn-primary"
                disabled={updateMutation.isLoading}
              >
                {updateMutation.isLoading ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

