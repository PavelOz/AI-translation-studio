import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import type { AIProvider, ProviderPromptRequest, ProviderPromptResponse } from './types';

export abstract class BaseProvider implements AIProvider {
  abstract readonly name: string;
  abstract readonly defaultModel: string;

  protected constructor(protected readonly apiKey?: string) {}

  abstract callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse>;

  protected ensureModel(requested?: string) {
    return requested ?? this.defaultModel;
  }

  protected logFallback(reason: string) {
    logger.warn({ provider: this.name, reason }, 'Falling back to mock AI response');
  }

  protected mockResponse(request: ProviderPromptRequest): ProviderPromptResponse {
    // Safely handle segments - use provided segments or create a default one
    const segments = request.segments && Array.isArray(request.segments) && request.segments.length > 0
      ? request.segments
      : [{ segmentId: 'mock', sourceText: request.prompt || 'Test' }];
    
    // Try to extract target language from prompt for better mock response
    let targetLangHint = '';
    const prompt = request.prompt || '';
    
    // Look for target language hints in the prompt
    const targetLangMatch = prompt.match(/TARGET LANGUAGE[:\s]+(\w+)/i) || 
                           prompt.match(/Target language[:\s]+(\w+)/i) ||
                           prompt.match(/translate.*to\s+(\w+)/i);
    
    if (targetLangMatch) {
      targetLangHint = targetLangMatch[1].toLowerCase();
    }
    
    // For mock responses, we can't actually translate, but we can indicate the target language
    // This helps with debugging and shows that the direction is understood
    const items = segments.map((segment) => {
      let mockTranslation = segment.sourceText;
      
      // If we detected a target language hint, add it to the mock marker
      if (targetLangHint) {
        mockTranslation = `${segment.sourceText} [${this.name} synthetic translation to ${targetLangHint}]`;
      } else {
        mockTranslation = `${segment.sourceText} [${this.name} synthetic translation]`;
      }
      
      return {
        segment_id: segment.segmentId ?? randomUUID(),
        target_mt: mockTranslation,
      };
    });
    
    return {
      outputText: JSON.stringify(items),
      usage: {
        inputTokens: Math.round((request.prompt?.length || 0) / 4),
        outputTokens: Math.round(items.reduce((acc, item) => acc + item.target_mt.length, 0) / 4),
        metadata: { mock: true },
      },
    };
  }
}









