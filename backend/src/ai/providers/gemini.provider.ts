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
   * Extract JSON substring from text that may contain "thought trace" or other non-JSON content
   * Finds the first { or [ and the last matching } or ]
   * Handles cases where thinking models output reasoning before the JSON
   * Returns the extracted JSON if found and valid, otherwise returns original text
   */
  private extractJsonFromText(text: string): { extracted: string; wasExtracted: boolean } {
    if (!text) return { extracted: text, wasExtracted: false };
    
    // Find first JSON start character
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    
    // Determine which comes first and what type of JSON we're looking for
    let startIndex = -1;
    let isArray = false;
    
    if (firstBrace === -1 && firstBracket === -1) {
      // No JSON found, return original text
      return { extracted: text, wasExtracted: false };
    } else if (firstBrace === -1) {
      startIndex = firstBracket;
      isArray = true;
    } else if (firstBracket === -1) {
      startIndex = firstBrace;
      isArray = false;
    } else {
      // Both found, use the one that comes first
      if (firstBracket < firstBrace) {
        startIndex = firstBracket;
        isArray = true;
      } else {
        startIndex = firstBrace;
        isArray = false;
      }
    }
    
    // Find matching closing character from the end
    let endIndex = -1;
    if (isArray) {
      endIndex = text.lastIndexOf(']');
    } else {
      endIndex = text.lastIndexOf('}');
    }
    
    // If we found both start and end, extract the JSON substring
    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      const jsonSubstring = text.substring(startIndex, endIndex + 1);
      
      // Validate that it's valid JSON by trying to parse it
      try {
        JSON.parse(jsonSubstring);
        return { extracted: jsonSubstring, wasExtracted: true };
      } catch {
        // If parsing fails, return original text (might be malformed JSON)
        logger.warn({
          startIndex,
          endIndex,
          extractedLength: jsonSubstring.length,
          preview: jsonSubstring.substring(0, 100),
        }, 'Failed to parse extracted JSON, returning original text');
        return { extracted: text, wasExtracted: false };
      }
    }
    
    // If we couldn't find matching brackets, return original text
    return { extracted: text, wasExtracted: false };
  }
  
  /**
   * Map model names to their correct API versions if needed
   * Older models like gemini-pro may need v1beta, newer models use v1
   */
  private getModelEndpoint(model: string): string {
    // Thinking models strictly require v1alpha API
    // Experimental models (exp) also use v1alpha for safety (works in logs)
    if (model.includes('thinking') || model.includes('exp')) {
      return 'https://generativelanguage.googleapis.com/v1alpha/models';
    }
    
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
      } else {
        // Log non-OK response for debugging
        const errorText = await v1Response.text().catch(() => 'Could not read error response');
        logger.debug({
          status: v1Response.status,
          statusText: v1Response.statusText,
          errorText: errorText.substring(0, 200),
        }, 'v1 API models list request failed (non-critical)');
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
      } else {
        // Log non-OK response for debugging
        const errorText = await v1betaResponse.text().catch(() => 'Could not read error response');
        logger.debug({
          status: v1betaResponse.status,
          statusText: v1betaResponse.statusText,
          errorText: errorText.substring(0, 200),
        }, 'v1beta API models list request failed (non-critical)');
      }

      logger.info({
        modelsFound: availableModels.length,
        models: availableModels.map(m => ({
          name: m.name,
          supportsGenerateContent: m.supportedMethods.includes('generateContent'),
        })),
      }, 'Listed available Gemini models');

      return availableModels;
    } catch (error: any) {
      // Log error details for debugging
      logger.warn({ 
        error: error?.message || String(error),
        errorName: error?.name,
        errorStack: error?.stack?.substring(0, 500),
      }, 'Failed to list Gemini models (non-critical, will use fallback models)');
      return [];
    }
  }

  async callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse> {
    if (!this.apiKey) {
      this.logFallback('Missing GEMINI_API_KEY');
      return this.mockResponse(request);
    }

    let model = this.ensureModel(request.model);
    
    // Map alias to actual model name
    if (model === 'gemini-thinking') {
      model = 'gemini-2.0-flash-thinking-exp';
    }
    
    let endpoint = this.getModelEndpoint(model);
    
    // First, try to get list of available models to find one that works
    let availableModels: Array<{ name: string; supportedMethods: string[] }> = [];
    try {
      availableModels = await this.listAvailableModels();
      if (availableModels.length === 0) {
        logger.warn('No models found in available models list, will use fallback models');
      }
    } catch (error: any) {
      // Log error details for debugging
      logger.warn({ 
        error: error?.message || error,
        errorStack: error?.stack,
      }, 'Could not fetch available models list, will try default attempts');
      // Continue with fallback models - this is not critical
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
    // Add fallbacks for gemini-2.5-pro (may not be available in all regions/API versions)
    if (model.includes('gemini-2.5-pro') || model.includes('gemini-2.5')) {
      modelAttempts.push('gemini-1.5-pro', 'gemini-1.5-pro-001', 'gemini-pro');
    }
    // Add fallbacks for gemini-2.0 models (including thinking models)
    if (model.includes('gemini-2.0')) {
      modelAttempts.push('gemini-1.5-pro', 'gemini-1.5-pro-001', 'gemini-pro');
    }
    // Add support for gemini-2.0-flash-thinking-exp (Reasoning model)
    if (model.includes('gemini-2.0-flash-thinking') || model === 'gemini-thinking') {
      modelAttempts.push('gemini-2.0-flash-thinking-exp');
      // Add fallbacks if thinking model is not available (including non-thinking exp model)
      modelAttempts.push('gemini-2.0-flash-exp', 'gemini-1.5-pro', 'gemini-1.5-pro-001', 'gemini-pro');
    }
    
    // 2. Try models from the available list, but prioritize non-thinking models
    // Filter out thinking models (2.5-flash, 2.5-pro) that consume tokens on thoughts
    const nonThinkingModels = supportedModels.filter(m => 
      !m.shortName.includes('2.5-flash') && 
      !m.shortName.includes('2.5-pro') &&
      !m.shortName.includes('thinking')
    );
    const thinkingModels = supportedModels.filter(m => 
      m.shortName.includes('2.5-flash') || 
      m.shortName.includes('2.5-pro') ||
      m.shortName.includes('thinking')
    );
    
    // Add non-thinking models first (preferred)
    nonThinkingModels.forEach(m => {
      if (!modelAttempts.includes(m.shortName)) {
        modelAttempts.push(m.shortName);
      }
    });
    
    // Add thinking models last (fallback only)
    thinkingModels.forEach(m => {
      if (!modelAttempts.includes(m.shortName)) {
        modelAttempts.push(m.shortName);
      }
    });
    
    // 3. Fallback defaults (ensure we always have at least one working model)
    // Prefer models without thoughts to avoid token consumption issues
    if (!modelAttempts.includes('gemini-1.5-pro')) {
      modelAttempts.push('gemini-1.5-pro');
    }
    if (!modelAttempts.includes('gemini-pro-latest')) {
      modelAttempts.push('gemini-pro-latest'); // Use -latest variant which is available
    }
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
        // Thinking models strictly require v1alpha API
        // Experimental models (exp) also use v1alpha for safety (works in logs)
        // All newer models (2.0, 2.5, 3.0) use v1 API
        // Older models use v1beta
        // Note: gemini-2.5-pro may not be available in all regions/API versions
        // Note: gemini-pro-latest uses v1 API (it's a newer variant)
        let attemptEndpoint = endpoint;
        if (modelAttempt.includes('thinking') || modelAttempt.includes('exp')) {
          attemptEndpoint = 'https://generativelanguage.googleapis.com/v1alpha/models';
        } else if (modelAttempt === 'gemini-pro-latest' || modelAttempt.includes('-latest')) {
          // -latest variants use v1 API
          attemptEndpoint = 'https://generativelanguage.googleapis.com/v1/models';
        } else if (modelAttempt === 'gemini-pro' || (!modelAttempt.includes('2.') && !modelAttempt.includes('3.') && !modelAttempt.includes('-latest'))) {
          attemptEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models';
        } else {
          // Newer models (2.0+, 2.5+, 3.0+) use v1 API
          attemptEndpoint = 'https://generativelanguage.googleapis.com/v1/models';
        }
        
        // Special handling: if trying gemini-2.5-pro and it's not in available models, prefer v1 API
        // but be ready to fallback to gemini-1.5-pro if it fails
        if (modelAttempt.includes('2.5') && supportedModels.length > 0) {
          const isAvailable = supportedModels.some(m => m.shortName.includes('2.5'));
          if (!isAvailable) {
            logger.debug({
              modelAttempt,
              availableModels: supportedModels.map(m => m.shortName),
            }, 'gemini-2.5-pro not in available models list, will try but may fallback');
          }
        }
        
        // Use short model name (without models/ prefix) since endpoint already has /models
        // The endpoint format is: /v1/models/{model_name}:generateContent
        // So we should use just the model name, not models/model_name
        const modelNameForUrl = modelAttempt; // Use short name, endpoint already has /models
        
        // Estimate prompt tokens (rough: ~4 chars per token)
        const promptTokensEstimate = Math.ceil((request.prompt?.length ?? 0) / 4);
        const requestedMaxTokens = request.maxTokens ?? 2048;
        
        // Warn if prompt is very long (might exceed input token limits)
        if (promptTokensEstimate > 100000) {
          logger.warn({
            promptTokensEstimate,
            promptLength: request.prompt?.length ?? 0,
            modelAttempt,
            warning: 'Prompt is very long - may exceed input token limits',
          }, 'Very long prompt detected');
        }
        
        const apiUrl = `${attemptEndpoint}/${modelNameForUrl}:generateContent?key=${this.apiKey}`;
        
        logger.debug({
          attempt: modelAttempt,
          fullModelName: modelInfo?.fullName || 'not found in list',
          endpoint: attemptEndpoint,
          apiVersion: attemptEndpoint.includes('/v1/') ? 'v1' : 'v1beta',
          apiUrl: apiUrl.replace(this.apiKey || '', '***'),
        }, 'Trying Gemini model');
        
        // For models with thoughts (2.5-flash, 2.5-pro), increase maxTokens to compensate
        // Thoughts can consume 50-75% of tokens, so we need more headroom
        const isThoughtsModel = modelAttempt.includes('2.5-flash') || modelAttempt.includes('2.5-pro');
        const baseMaxTokens = request.maxTokens ? Math.min(request.maxTokens, 8192) : 2048;
        const maxOutputTokens = isThoughtsModel 
          ? Math.min(baseMaxTokens * 3, 8192) // Triple for thoughts models to ensure enough output tokens
          : baseMaxTokens;
        
        // Log maxTokens for debugging
        if (request.maxTokens && request.maxTokens > 2048) {
        logger.debug({
          requestedMaxTokens: request.maxTokens,
          actualMaxOutputTokens: maxOutputTokens,
          modelAttempt,
          promptLength: request.prompt?.length ?? 0,
          promptTokensEstimate: Math.ceil((request.prompt?.length ?? 0) / 4),
        }, 'Using high maxTokens for Gemini API (likely critic workflow)');
        }
        
        // For Gemini, prepend systemPrompt to the user prompt if provided
        // Gemini API v1 doesn't have explicit system role, so we inject it into the prompt
        const userPrompt = request.systemPrompt 
          ? `${request.systemPrompt}\n\n${request.prompt}`
          : request.prompt;
        
        const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            temperature: request.temperature ?? 0.2,
            // Gemini API supports up to 8192 output tokens for most models
            // Some models may have lower limits, but 8192 is safe for most
            // Cap at 8192 to avoid API errors
            maxOutputTokens,
            // Note: Gemini 2.5 Flash and newer models use "thoughts" (internal reasoning)
            // which can consume output tokens. For workflows requiring long outputs,
            // consider using gemini-1.5-pro or gemini-pro instead.
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
        
        let outputText = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        
        // Extract JSON from output if it contains JSON structures
        // This handles cases where models (especially thinking/reasoning models) output
        // "thought trace" or other text before the JSON
        // We check if the text contains JSON-like structures and extract only the JSON part
        if (outputText && (outputText.includes('{') || outputText.includes('['))) {
          const originalLength = outputText.length;
          const { extracted, wasExtracted } = this.extractJsonFromText(outputText);
          // Only use extracted JSON if we successfully found and extracted valid JSON
          // This prevents breaking non-JSON responses
          if (wasExtracted) {
            outputText = extracted;
            logger.debug({
              modelAttempt,
              originalLength,
              extractedLength: extracted.length,
            }, 'Extracted JSON from model output (removed non-JSON content)');
          }
        }
        
        const finishReason = payload.candidates?.[0]?.finishReason;
        
        // Check if response was truncated due to MAX_TOKENS
        if (finishReason === 'MAX_TOKENS') {
          const requestedMaxTokens = request.maxTokens ?? 2048;
          // Try multiple fields to get actual token count
          const actualOutputTokens = payload?.usageMetadata?.candidatesTokenCount 
            ?? payload?.usageMetadata?.totalTokenCount 
            ?? payload?.usageMetadata?.completionTokenCount
            ?? undefined;
          const promptTokens = payload?.usageMetadata?.promptTokenCount 
            ?? payload?.usageMetadata?.inputTokenCount
            ?? undefined;
          const totalTokens = payload?.usageMetadata?.totalTokenCount ?? undefined;
          
          // Check if thoughts consumed most tokens (Gemini 2.5 Flash issue)
          const thoughtsTokens = payload?.usageMetadata?.thoughtsTokenCount ?? 0;
          const thoughtsConsumedMost = thoughtsTokens > requestedMaxTokens * 0.5; // More than 50% of tokens
          
          // Log full usage metadata for debugging
          logger.warn({
            finishReason,
            requestedMaxTokens,
            actualOutputTokens,
            promptTokens,
            totalTokens,
            thoughtsTokenCount: thoughtsTokens,
            thoughtsConsumedMost,
            outputLength: outputText.length,
            promptLength: request.prompt?.length ?? 0,
            modelAttempt,
            usageMetadata: payload?.usageMetadata, // Log full metadata for debugging
          }, 'Gemini API response exceeded max tokens - response was truncated');
          
          // If we got some output, return it with a warning (don't throw error)
          // The caller can decide what to do with truncated output
          if (outputText) {
            logger.warn({
              truncatedOutputLength: outputText.length,
              requestedMaxTokens,
              actualOutputTokens: actualOutputTokens ?? 'unknown',
              thoughtsTokenCount: thoughtsTokens,
              recommendation: thoughtsConsumedMost 
                ? `Model ${modelAttempt} used ${thoughtsTokens} tokens for thoughts. Consider using gemini-1.5-pro or gemini-pro for this workflow, or optimize the prompt.`
                : `Consider increasing maxTokens to ${Math.min(requestedMaxTokens * 2, 8192)} or optimizing the prompt`,
            }, 'Gemini API response was truncated but contains partial output - returning truncated result');
            // Don't throw error - return the truncated output
            // The caller can handle it appropriately
          } else {
            // No output at all - this is a real error
            // Log detailed information for debugging
            logger.error({
              finishReason,
              requestedMaxTokens,
              actualOutputTokens,
              promptTokens,
              totalTokens,
              outputLength: 0,
              promptLength: request.prompt?.length ?? 0,
              promptTokensEstimate: Math.ceil((request.prompt?.length ?? 0) / 4),
              modelAttempt,
              usageMetadata: payload?.usageMetadata,
              payloadKeys: payload ? Object.keys(payload) : [],
              candidatesLength: payload?.candidates?.length ?? 0,
            }, 'Gemini API response exceeded max tokens - no output received');
            
            const actualTokensStr = actualOutputTokens !== undefined ? String(actualOutputTokens) : 'unknown';
            const recommendedMaxTokens = Math.min(requestedMaxTokens * 2, 8192);
            
            // Provide specific recommendation if thoughts consumed most tokens
            let recommendation = `Consider increasing maxTokens (current: ${requestedMaxTokens}, recommended: ${recommendedMaxTokens}) or optimizing the prompt.`;
            if (thoughtsConsumedMost) {
              recommendation = `Model ${modelAttempt} used ${thoughtsTokens} tokens for internal thoughts, leaving no room for output. Consider using gemini-1.5-pro or gemini-pro for this workflow (they don't use thoughts), or significantly reduce the prompt length.`;
            }
            
            throw new Error(`Gemini API response exceeded max tokens (requested: ${requestedMaxTokens}, actual: ${actualTokensStr}, thoughts: ${thoughtsTokens}). ${recommendation}`);
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



