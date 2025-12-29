import { BaseProvider } from './baseProvider';
import type { ProviderPromptRequest, ProviderPromptResponse } from './types';
import { logger } from '../../utils/logger';
import OpenAI from 'openai';

export class DeepSeekProvider extends BaseProvider {
  readonly name = 'deepseek';

  private client: OpenAI | null = null;

  constructor(apiKey?: string, public readonly defaultModel = 'deepseek-chat') {
    super(apiKey);
    
    if (apiKey) {
      this.client = new OpenAI({
        baseURL: 'https://api.deepseek.com',
        apiKey: apiKey,
      });
    }
  }

  async callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse> {
    if (!this.apiKey) {
      this.logFallback('Missing DEEPSEEK_API_KEY');
      return this.mockResponse(request);
    }

    if (!this.client) {
      this.client = new OpenAI({
        baseURL: 'https://api.deepseek.com',
        apiKey: this.apiKey,
      });
    }

    const model = this.ensureModel(request.model);
    
    // Explicit temperature handling to ensure 0.0 is preserved
    const finalTemperature = request.temperature !== undefined ? request.temperature : 0.2;
    
    logger.debug({
      model,
      rawRequestTemp: request.temperature,
      isUndefined: request.temperature === undefined,
      finalTemp: finalTemperature,
      temperatureType: typeof request.temperature,
    }, 'DeepSeek: Temperature Debug');
    
    try {
      const response = await this.client.chat.completions.create({
        model,
        temperature: finalTemperature,
        max_tokens: request.maxTokens ?? 1024,
        messages: [
          { 
            role: 'system', 
            content: request.systemPrompt ?? 'You are a professional technical/legal translator. CRITICAL: Follow the translation direction specified in the user prompt. The user prompt will clearly state SOURCE language (input) and TARGET language (output). You MUST translate FROM source TO target. Your output MUST be in the target language only. Never return text in the source language. ALL source text must be translated - do not keep source text unchanged. Even if source text appears similar to target language, you must still translate it. Follow ALL instructions in the user prompt carefully, including translation direction, glossary terms, formatting requirements, and natural language quality guidelines. Always translate to the target language specified in the prompt, ensuring the translation reads as if originally written by a native speaker, not translated.' 
          },
          { role: 'user', content: request.prompt },
        ],
      });

      // Handle reasoning models (deepseek-reasoner)
      // Reasoning models return reasoning_content in the message
      const message = response.choices[0]?.message;
      const reasoningContent = (message as any)?.reasoning_content;
      
      if (reasoningContent) {
        // Log the reasoning content for debugging
        logger.info({
          model,
          reasoningLength: reasoningContent.length,
          preview: reasoningContent.substring(0, 500),
        }, 'DeepSeek reasoning content received (logged for debugging)');
        
        // Log full reasoning content to console for visibility
        console.log('=== DeepSeek Reasoning Content ===');
        console.log(reasoningContent);
        console.log('=== End Reasoning Content ===');
      }

      // Always return the standard content (not reasoning_content)
      const outputText = message?.content ?? '';
      
      if (!outputText) {
        logger.warn({
          model,
          hasReasoning: !!reasoningContent,
          response: response,
        }, 'DeepSeek API returned empty content');
      }

      return {
        outputText,
        usage: {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          costUsd: undefined,
        },
        raw: response,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      // Handle OpenAI SDK errors
      if (error instanceof OpenAI.APIError) {
        logger.error({
          status: error.status,
          error: error.message,
          errorCode: error.code,
          model,
          apiKeyPresent: !!this.apiKey,
          apiKeyLength: this.apiKey?.length ?? 0,
        }, 'DeepSeek API error');
        
        throw new Error(`DeepSeek API error (${error.status}): ${error.message}`);
      }
      
      logger.error({
        error: errorMessage,
        errorStack,
        model,
        apiKeyPresent: !!this.apiKey,
        apiKeyLength: this.apiKey?.length ?? 0,
        promptLength: request.prompt?.length ?? 0,
      }, 'DeepSeek provider failed');
      
      return this.mockResponse(request);
    }
  }
}

