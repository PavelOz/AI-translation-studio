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
  const [provider, setProvider] = useState<'gemini' | 'openai' | 'yandex'>('openai');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [yandexApiKey, setYandexApiKey] = useState('');
  const [yandexFolderId, setYandexFolderId] = useState('');
  const [showOpenaiApiKey, setShowOpenaiApiKey] = useState(false);
  const [showGeminiApiKey, setShowGeminiApiKey] = useState(false);
  const [showYandexApiKey, setShowYandexApiKey] = useState(false);
  const [testingProvider, setTestingProvider] = useState<'openai' | 'gemini' | 'yandex' | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

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
      setProvider(aiSettings.provider as 'gemini' | 'openai' | 'yandex');
      // Extract API keys from config if available
      if (aiSettings.config && typeof aiSettings.config === 'object') {
        const config = aiSettings.config as Record<string, unknown>;
        if (config.openaiApiKey) setOpenaiApiKey(String(config.openaiApiKey));
        if (config.geminiApiKey) setGeminiApiKey(String(config.geminiApiKey));
        if (config.yandexApiKey) setYandexApiKey(String(config.yandexApiKey));
        if (config.yandexFolderId) setYandexFolderId(String(config.yandexFolderId));
        // Legacy support: if apiKey exists, assign it to the selected provider
        if (config.apiKey && !config.openaiApiKey && !config.geminiApiKey && !config.yandexApiKey) {
          const key = String(config.apiKey);
          if (aiSettings.provider === 'openai') setOpenaiApiKey(key);
          else if (aiSettings.provider === 'gemini') setGeminiApiKey(key);
          else if (aiSettings.provider === 'yandex') setYandexApiKey(key);
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

    // Build config with all API keys
    const config: Record<string, unknown> = {};
    if (openaiApiKey.trim()) config.openaiApiKey = openaiApiKey.trim();
    if (geminiApiKey.trim()) config.geminiApiKey = geminiApiKey.trim();
    if (yandexApiKey.trim()) config.yandexApiKey = yandexApiKey.trim();
    if (yandexFolderId.trim()) config.yandexFolderId = yandexFolderId.trim();

    updateMutation.mutate({
      provider,
      model: selectedProviderData.defaultModel,
      config: Object.keys(config).length > 0 ? config : undefined,
    });
  };

  const handleTestCredentials = async (testProvider: 'openai' | 'gemini' | 'yandex') => {
    let apiKeyToTest = '';
    let folderIdToTest = '';
    if (testProvider === 'openai') apiKeyToTest = openaiApiKey.trim();
    else if (testProvider === 'gemini') apiKeyToTest = geminiApiKey.trim();
    else if (testProvider === 'yandex') {
      apiKeyToTest = yandexApiKey.trim();
      folderIdToTest = yandexFolderId.trim();
    }

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
                  setProvider(e.target.value as 'gemini' | 'openai' | 'yandex');
                }}
                className="input w-full"
                disabled={updateMutation.isLoading}
              >
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI (ChatGPT)</option>
                <option value="yandex">Yandex GPT</option>
              </select>
              {selectedProviderData && (
                <p className="text-xs text-gray-500 mt-1">
                  Default model: {selectedProviderData.defaultModel}
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

