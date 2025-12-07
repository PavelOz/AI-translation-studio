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
              content: 'You are a professional technical/legal translator specializing in natural, native-sounding translations. Follow ALL instructions in the user prompt carefully, including translation direction, glossary terms, formatting requirements, and natural language quality guidelines. Always translate to the target language specified in the prompt, ensuring the translation reads as if originally written by a native speaker, not translated.' 
            },
            { role: 'user', content: request.prompt },
          ],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `OpenAI error (${response.status}): ${errorBody}`;
        
        // Try to parse error body as JSON for more details
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error?.message) {
            errorMessage = `OpenAI API error (${response.status}): ${errorJson.error.message}`;
          }
        } catch {
          // If not JSON, use the text as-is
        }
        
        logger.error({
          status: response.status,
          statusText: response.statusText,
          errorBody,
          model,
          apiKeyPresent: !!this.apiKey,
          apiKeyLength: this.apiKey?.length ?? 0,
        }, 'OpenAI API request failed');
        
        throw new Error(errorMessage);
      }

      const payload = await response.json();
      
      // Check for errors in the response payload
      if (payload.error) {
        const errorMessage = payload.error.message || 'Unknown OpenAI API error';
        logger.error({
          error: payload.error,
          model,
        }, 'OpenAI API returned error in response');
        throw new Error(`OpenAI API error: ${errorMessage}`);
      }
      
      const outputText = payload?.choices?.[0]?.message?.content ?? '';
      
      if (!outputText) {
        logger.warn({
          payload,
          model,
        }, 'OpenAI API returned empty response');
      }

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
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      logger.error({
        error: errorMessage,
        errorStack,
        model,
        apiKeyPresent: !!this.apiKey,
        apiKeyLength: this.apiKey?.length ?? 0,
        promptLength: request.prompt?.length ?? 0,
      }, 'OpenAI provider failed');
      
      return this.mockResponse(request);
    }
  }
}









