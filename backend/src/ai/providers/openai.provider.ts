import { BaseProvider } from './baseProvider';
import type { ProviderPromptRequest, ProviderPromptResponse } from './types';
import { logger } from '../../utils/logger';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';

  constructor(apiKey?: string, public readonly defaultModel = 'gpt-4o-mini') {
    super(apiKey);
  }

  async callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse> {
    if (!this.apiKey) {
      this.logFallback('Missing OPENAI_API_KEY');
      return this.mockResponse(request);
    }

    const model = this.ensureModel(request.model);
    try {
      const response = await fetch(OPENAI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 1024,
          messages: [
            { 
              role: 'system', 
              content: 'You are a professional technical/legal translator. Follow ALL instructions in the user prompt carefully, including translation direction, glossary terms, and formatting requirements. Always translate to the target language specified in the prompt.' 
            },
            { role: 'user', content: request.prompt },
          ],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI error (${response.status}): ${errorBody}`);
      }

      const payload = await response.json();
      const outputText = payload?.choices?.[0]?.message?.content ?? '';

      return {
        outputText,
        usage: {
          inputTokens: payload?.usage?.prompt_tokens,
          outputTokens: payload?.usage?.completion_tokens,
          costUsd: undefined,
        },
        raw: payload,
      };
    } catch (error) {
      logger.error({ error }, 'OpenAI provider failed');
      return this.mockResponse(request);
    }
  }
}









