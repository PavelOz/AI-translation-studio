import { BaseProvider } from './baseProvider';
import type { ProviderPromptRequest, ProviderPromptResponse } from './types';
import { logger } from '../../utils/logger';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini';

  constructor(apiKey?: string, public readonly defaultModel = 'gemini-1.5-flash') {
    super(apiKey);
  }

  async callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse> {
    if (!this.apiKey) {
      this.logFallback('Missing GEMINI_API_KEY');
      return this.mockResponse(request);
    }

    const model = this.ensureModel(request.model);
    try {
      const response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: request.prompt }],
            },
          ],
          generationConfig: {
            temperature: request.temperature ?? 0.2,
            maxOutputTokens: request.maxTokens ?? 1024,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Gemini error (${response.status}): ${errorBody}`);
      }

      const payload = await response.json();
      const outputText = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

      return {
        outputText,
        usage: {
          inputTokens: payload?.usageMetadata?.promptTokenCount,
          outputTokens: payload?.usageMetadata?.candidatesTokenCount,
          costUsd: undefined,
        },
        raw: payload,
      };
    } catch (error) {
      logger.error({ error }, 'Gemini provider failed');
      return this.mockResponse(request);
    }
  }
}



