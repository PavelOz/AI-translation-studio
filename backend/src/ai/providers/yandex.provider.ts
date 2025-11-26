import { BaseProvider } from './baseProvider';
import type { ProviderPromptRequest, ProviderPromptResponse } from './types';
import { logger } from '../../utils/logger';
import { env } from '../../utils/env';

const YANDEX_ENDPOINT = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

export class YandexProvider extends BaseProvider {
  readonly name = 'yandex';
  private folderId?: string;

  constructor(apiKey?: string, public readonly defaultModel = 'yandexgpt-lite', folderId?: string) {
    super(apiKey);
    this.folderId = folderId;
  }

  async callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse> {
    const model = this.ensureModel(request.model);
    
    logger.debug({
      hasApiKey: !!this.apiKey,
      apiKeyLength: this.apiKey?.length ?? 0,
      hasFolderId: !!(this.folderId || env.yandexFolderId),
      folderId: this.folderId || env.yandexFolderId || 'none',
      model,
      promptLength: request.prompt?.length ?? 0,
      segmentsCount: request.segments?.length ?? 0,
    }, 'YandexGPT callModel called');
    
    if (!this.apiKey) {
      logger.warn({
        model,
        hasEnvKey: !!env.yandexApiKey,
        envKeyLength: env.yandexApiKey?.length ?? 0,
      }, 'YandexGPT: No API key provided in provider instance');
      this.logFallback('Missing YANDEX_API_KEY');
      return this.mockResponse(request);
    }

    // YandexGPT requires FOLDER_ID in addition to API key
    // Use provided folderId, or fall back to environment variable
    const folderId = this.folderId || env.yandexFolderId;
    if (!folderId) {
      logger.warn({
        model,
        hasProvidedFolderId: !!this.folderId,
        hasEnvFolderId: !!env.yandexFolderId,
      }, 'YandexGPT: No Folder ID provided');
      this.logFallback('Missing YANDEX_FOLDER_ID');
      return this.mockResponse(request);
    }

    try {
      logger.debug({
        model,
        folderId,
        endpoint: YANDEX_ENDPOINT,
        promptPreview: request.prompt?.substring(0, 200),
      }, 'YandexGPT: Sending request to API');
      const response = await fetch(YANDEX_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Api-Key ${this.apiKey}`,
          'x-folder-id': folderId,
        },
        body: JSON.stringify({
          modelUri: `gpt://${folderId}/${model}/latest`,
          completionOptions: {
            temperature: request.temperature ?? 0.2,
            maxTokens: String(request.maxTokens ?? 1024),
          },
          messages: [
            {
              role: 'system',
              text: `You are a professional technical/legal translator specializing in natural, native-sounding translations. Your job is to translate text from the SOURCE language to the TARGET language as specified in the user prompt. CRITICAL: You MUST output translations ONLY in the TARGET language specified in the prompt. Never return text in the SOURCE language. Always follow the translation direction (SOURCE → TARGET) exactly as stated in the prompt. Ensure translations read as if originally written by a native speaker, not translated.`,
            },
            {
              role: 'user',
              text: request.prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error({
          model,
          status: response.status,
          statusText: response.statusText,
          errorBody: errorBody.substring(0, 500),
        }, 'YandexGPT API returned error');
        throw new Error(`YandexGPT error (${response.status}): ${errorBody}`);
      }

      const payload = await response.json();
      
      // Log the response for debugging
      logger.debug({
        model,
        responseKeys: Object.keys(payload || {}),
        hasResult: !!payload?.result,
        hasAlternatives: !!payload?.result?.alternatives,
        alternativesCount: Array.isArray(payload?.result?.alternatives) ? payload.result.alternatives.length : 0,
        responsePreview: JSON.stringify(payload).substring(0, 300),
      }, 'YandexGPT API response received');
      
      // Safely extract output text with proper error handling
      let outputText = '';
      if (payload?.result?.alternatives && Array.isArray(payload.result.alternatives) && payload.result.alternatives.length > 0) {
        const firstAlternative = payload.result.alternatives[0];
        if (firstAlternative?.message?.text) {
          outputText = firstAlternative.message.text;
        }
      }

      if (!outputText) {
        logger.warn({ 
          payload: JSON.stringify(payload).substring(0, 500),
          fullPayload: payload,
        }, 'YandexGPT returned unexpected response format');
        throw new Error('YandexGPT returned empty or invalid response');
      }
      
      // Log the extracted output for debugging
      logger.debug({
        model,
        outputLength: outputText.length,
        outputPreview: outputText.substring(0, 200),
      }, 'YandexGPT output extracted');

      return {
        outputText,
        usage: {
          inputTokens: payload?.result?.usage?.inputTextTokens,
          outputTokens: payload?.result?.usage?.completionTokens,
          costUsd: undefined,
        },
        raw: payload,
      };
    } catch (error) {
      logger.error({ 
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        model,
        hasApiKey: !!this.apiKey,
        hasFolderId: !!(this.folderId || env.yandexFolderId),
      }, 'YandexGPT provider failed');
      return this.mockResponse(request);
    }
  }
}









