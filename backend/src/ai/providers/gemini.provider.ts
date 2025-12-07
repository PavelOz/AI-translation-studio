import { BaseProvider } from './baseProvider';
import type { ProviderPromptRequest, ProviderPromptResponse } from './types';
import { logger } from '../../utils/logger';

// Use v1 API by default - supports all newer models including gemini-1.5-flash and gemini-1.5-pro
// v1beta API only supports older models like gemini-pro
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1/models';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini';

  constructor(apiKey?: string, public readonly defaultModel = 'gemini-pro') {
    super(apiKey);
  }
  
  /**
   * Map model names to their correct API versions if needed
   * Older models like gemini-pro may need v1beta, newer models use v1
   */
  private getModelEndpoint(model: string): string {
    // Older models that might work better with v1beta
    const v1betaModels = ['gemini-pro'];
    
    if (v1betaModels.includes(model)) {
      return 'https://generativelanguage.googleapis.com/v1beta/models';
    }
    
    // Default to v1 API for newer models (gemini-1.5-flash, gemini-1.5-pro, etc.)
    return GEMINI_ENDPOINT;
  }

  /**
   * List available Gemini models (for debugging)
   * Returns models that support generateContent method
   */
  async listAvailableModels(): Promise<Array<{ name: string; supportedMethods: string[] }>> {
    if (!this.apiKey) {
      logger.warn('Cannot list models: API key missing');
      return [];
    }

    const availableModels: Array<{ name: string; supportedMethods: string[] }> = [];

    try {
      // Try v1 API first
      const v1Response = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${this.apiKey}`);
      if (v1Response.ok) {
        const v1Data = await v1Response.json();
        if (v1Data.models && Array.isArray(v1Data.models)) {
          v1Data.models.forEach((m: any) => {
            if (m.name && m.name.includes('gemini')) {
              availableModels.push({
                name: m.name,
                supportedMethods: m.supportedGenerationMethods || [],
              });
            }
          });
        }
      }

      // Also try v1beta
      const v1betaResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`);
      if (v1betaResponse.ok) {
        const v1betaData = await v1betaResponse.json();
        if (v1betaData.models && Array.isArray(v1betaData.models)) {
          v1betaData.models.forEach((m: any) => {
            if (m.name && m.name.includes('gemini')) {
              // Avoid duplicates
              if (!availableModels.find(am => am.name === m.name)) {
                availableModels.push({
                  name: m.name,
                  supportedMethods: m.supportedGenerationMethods || [],
                });
              }
            }
          });
        }
      }

      logger.info({
        modelsFound: availableModels.length,
        models: availableModels.map(m => ({
          name: m.name,
          supportsGenerateContent: m.supportedMethods.includes('generateContent'),
        })),
      }, 'Listed available Gemini models');

      return availableModels;
    } catch (error) {
      logger.error({ error }, 'Failed to list Gemini models');
      return [];
    }
  }

  async callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse> {
    if (!this.apiKey) {
      this.logFallback('Missing GEMINI_API_KEY');
      return this.mockResponse(request);
    }

    let model = this.ensureModel(request.model);
    let endpoint = this.getModelEndpoint(model);
    
    // First, try to get list of available models to find one that works
    let availableModels: Array<{ name: string; supportedMethods: string[] }> = [];
    try {
      availableModels = await this.listAvailableModels();
    } catch (error) {
      logger.debug({ error }, 'Could not fetch available models list, will try default attempts');
    }
    
    // Find models that support generateContent
    const supportedModels = availableModels
      .filter(m => m.supportedMethods.includes('generateContent'))
      .map(m => {
        // Extract short model name (e.g., "models/gemini-pro" -> "gemini-pro")
        const shortName = m.name.includes('/') ? m.name.split('/').pop() || m.name : m.name;
        return { fullName: m.name, shortName };
      });
    
    // Build model attempts: try requested model first, then available models, then defaults
    const modelAttempts: string[] = [];
    
    // 1. Try requested model (original and variations)
    modelAttempts.push(model);
    if (model.includes('gemini-1.5-flash')) {
      modelAttempts.push('gemini-1.5-flash-001', 'gemini-1.5-flash-latest');
    }
    if (model.includes('gemini-1.5-pro')) {
      modelAttempts.push('gemini-1.5-pro-001', 'gemini-1.5-pro-latest');
    }
    
    // 2. Try models from the available list
    supportedModels.forEach(m => {
      if (!modelAttempts.includes(m.shortName)) {
        modelAttempts.push(m.shortName);
      }
    });
    
    // 3. Fallback defaults
    if (!modelAttempts.includes('gemini-pro')) {
      modelAttempts.push('gemini-pro');
    }
    
    // Remove duplicates
    const uniqueAttempts = [...new Set(modelAttempts)];
    
    logger.debug({
      model,
      endpoint,
      apiVersion: endpoint.includes('/v1/') ? 'v1' : 'v1beta',
      availableModelsCount: supportedModels.length,
      modelAttempts: uniqueAttempts.slice(0, 5), // Log first 5 attempts
    }, 'Gemini API request');
    
    let lastError: Error | null = null;
    
      for (const modelAttempt of uniqueAttempts) {
      try {
        // Determine endpoint and model name format
        // Find if this model is in the available models list to get full name
        const modelInfo = supportedModels.find(m => m.shortName === modelAttempt);
        const fullModelName = modelInfo?.fullName || modelAttempt;
        
        // Determine endpoint based on model
        // All newer models (2.0, 2.5, 3.0) use v1 API
        // Older models use v1beta
        let attemptEndpoint = endpoint;
        if (modelAttempt === 'gemini-pro' || (!modelAttempt.includes('2.') && !modelAttempt.includes('3.'))) {
          attemptEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models';
        } else {
          // Newer models (2.0+, 2.5+, 3.0+) use v1 API
          attemptEndpoint = 'https://generativelanguage.googleapis.com/v1/models';
        }
        
        // Use short model name (without models/ prefix) since endpoint already has /models
        // The endpoint format is: /v1/models/{model_name}:generateContent
        // So we should use just the model name, not models/model_name
        const modelNameForUrl = modelAttempt; // Use short name, endpoint already has /models
        
        const apiUrl = `${attemptEndpoint}/${modelNameForUrl}:generateContent?key=${this.apiKey}`;
        
        logger.debug({
          attempt: modelAttempt,
          fullModelName: modelInfo?.fullName || 'not found in list',
          endpoint: attemptEndpoint,
          apiVersion: attemptEndpoint.includes('/v1/') ? 'v1' : 'v1beta',
          apiUrl: apiUrl.replace(this.apiKey || '', '***'),
        }, 'Trying Gemini model');
        
        const maxOutputTokens = request.maxTokens ? Math.min(request.maxTokens, 8192) : 2048;
        
        // Log maxTokens for debugging
        if (request.maxTokens && request.maxTokens > 2048) {
          logger.debug({
            requestedMaxTokens: request.maxTokens,
            actualMaxOutputTokens: maxOutputTokens,
            modelAttempt,
            promptLength: request.prompt?.length ?? 0,
          }, 'Using high maxTokens for Gemini API (likely critic workflow)');
        }
        
        const response = await fetch(apiUrl, {
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
            // Gemini API supports up to 8192 output tokens for most models
            // Some models may have lower limits, but 8192 is safe for most
            // Cap at 8192 to avoid API errors
            maxOutputTokens,
          },
        }),
      });

      if (!response.ok) {
          const errorBody = await response.text();
          let errorMessage = `Gemini error (${response.status}): ${errorBody}`;
          
          // Try to parse error body as JSON for more details
          try {
            const errorJson = JSON.parse(errorBody);
            if (errorJson.error?.message) {
              errorMessage = `Gemini API error (${response.status}): ${errorJson.error.message}`;
            }
          } catch {
            // If not JSON, use the text as-is
          }
          
          // If it's a 404 (model not found), try next model
          if (response.status === 404) {
            logger.debug({
              modelAttempt,
              status: response.status,
              errorMessage,
            }, 'Model not found, trying next model');
            lastError = new Error(errorMessage);
            continue; // Try next model
          }
          
          // For other errors, log and throw
          logger.error({
            status: response.status,
            statusText: response.statusText,
            errorBody,
            modelAttempt,
            apiKeyPresent: !!this.apiKey,
            apiKeyLength: this.apiKey?.length ?? 0,
          }, 'Gemini API request failed');
          
          throw new Error(errorMessage);
        }

        const payload = await response.json();
        
        // Check for errors in the response payload
        if (payload.error) {
          const errorMessage = payload.error.message || 'Unknown Gemini API error';
          // If it's a model not found error, try next model
          if (errorMessage.includes('not found') || errorMessage.includes('not supported')) {
            logger.debug({
              modelAttempt,
              errorMessage,
            }, 'Model not supported, trying next model');
            lastError = new Error(`Gemini API error: ${errorMessage}`);
            continue; // Try next model
          }
          
          logger.error({
            error: payload.error,
            modelAttempt,
          }, 'Gemini API returned error in response');
          throw new Error(`Gemini API error: ${errorMessage}`);
        }
        
        const outputText = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const finishReason = payload.candidates?.[0]?.finishReason;
        
        // Check if response was truncated due to MAX_TOKENS
        if (finishReason === 'MAX_TOKENS') {
          const requestedMaxTokens = request.maxTokens ?? 2048;
          const actualOutputTokens = payload?.usageMetadata?.candidatesTokenCount;
          const promptTokens = payload?.usageMetadata?.promptTokenCount;
          
          logger.error({
            finishReason,
            requestedMaxTokens,
            actualOutputTokens,
            promptTokens,
            outputLength: outputText.length,
            promptLength: request.prompt?.length ?? 0,
            modelAttempt,
          }, 'Gemini API response exceeded max tokens - response was truncated');
          
          // If we got some output, log a warning but don't fail completely
          // The caller can decide what to do with truncated output
          if (outputText) {
            logger.warn({
              truncatedOutputLength: outputText.length,
              requestedMaxTokens,
              actualOutputTokens,
            }, 'Gemini API response was truncated but contains partial output');
          } else {
            // No output at all - this is a real error
            throw new Error(`Gemini API response exceeded max tokens (requested: ${requestedMaxTokens}, actual: ${actualOutputTokens}). Consider increasing maxTokens (current: ${requestedMaxTokens}, recommended: ${Math.max(requestedMaxTokens * 2, 8192)}) or optimizing the prompt.`);
          }
        }
        
        // Check if response is empty or blocked (other reasons)
        if (!outputText && finishReason) {
          if (finishReason === 'SAFETY') {
            throw new Error('Gemini API blocked the response due to safety filters');
          } else if (finishReason === 'RECITATION') {
            throw new Error('Gemini API blocked the response due to recitation policy');
          } else if (finishReason !== 'MAX_TOKENS') {
            // Other finish reasons (STOP, etc.) are usually OK
            logger.debug({
              finishReason,
              modelAttempt,
            }, 'Gemini API finished with reason (may be normal)');
          }
        }

        // Success! Log which model worked
        logger.info({
          successfulModel: modelAttempt,
          originalModel: model,
        }, 'Gemini API request succeeded');

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
        // If it's not a 404/model not found error, this is a real error
        if (!(error instanceof Error && error.message.includes('not found'))) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        continue; // Try next model
      }
    }
    
    // If we get here, all model attempts failed
    const errorMessage = lastError?.message || 'All Gemini model attempts failed';
    logger.error({
      error: errorMessage,
      model,
      attemptedModels: uniqueAttempts,
      availableModels: supportedModels.map(m => m.shortName),
      apiKeyPresent: !!this.apiKey,
      apiKeyLength: this.apiKey?.length ?? 0,
      promptLength: request.prompt?.length ?? 0,
    }, 'Gemini provider failed - all model attempts exhausted');
    
    return this.mockResponse(request);
  }
}



