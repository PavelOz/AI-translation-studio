import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import type { AIProvider, ProviderPromptRequest, ProviderPromptResponse, ModelCapabilities } from './types';

export abstract class BaseProvider implements AIProvider {
  abstract readonly name: string;
  abstract readonly defaultModel: string;

  protected constructor(protected readonly apiKey?: string) {}

  abstract callModel(request: ProviderPromptRequest): Promise<ProviderPromptResponse>;
  
  /**
   * Получить возможности модели (должен быть переопределен в наследниках)
   */
  abstract getCapabilities(model?: string): ModelCapabilities;

  /**
   * Retry configuration
   */
  protected getRetryConfig(): {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    retryableErrors: string[];
  } {
    return {
      maxRetries: 3,
      baseDelay: 1000, // 1 second
      maxDelay: 16000, // 16 seconds
      retryableErrors: [
        'rate limit',
        'rate_limit',
        'too many requests',
        '429',
        'quota exceeded',
        'service unavailable',
        '503',
        'timeout',
        'network',
      ],
    };
  }

  /**
   * Check if error is retryable
   */
  protected isRetryableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const errorMessage = error.message.toLowerCase();
    const retryableErrors = this.getRetryConfig().retryableErrors;
    return retryableErrors.some(pattern => errorMessage.includes(pattern));
  }

  /**
   * Calculate exponential backoff delay
   */
  protected calculateBackoffDelay(attempt: number): number {
    const { baseDelay, maxDelay } = this.getRetryConfig();
    const delay = baseDelay * Math.pow(2, attempt);
    return Math.min(delay, maxDelay);
  }

  /**
   * Call model with automatic retry and exponential backoff
   */
  async callModelWithRetry(
    request: ProviderPromptRequest,
    options?: {
      maxRetries?: number;
      onRetry?: (attempt: number, delay: number, error: Error) => void;
    },
  ): Promise<ProviderPromptResponse> {
    const config = this.getRetryConfig();
    const maxRetries = options?.maxRetries ?? config.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.callModel(request);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Check if error is retryable
        if (!this.isRetryableError(lastError)) {
          throw lastError; // Non-retryable error, throw immediately
        }

        // If this is the last attempt, throw
        if (attempt === maxRetries - 1) {
          throw lastError;
        }

        // Calculate delay and wait
        const delay = this.calculateBackoffDelay(attempt);
        if (options?.onRetry) {
          options.onRetry(attempt + 1, delay, lastError);
        }
        
        logger.warn(
          {
            provider: this.name,
            attempt: attempt + 1,
            maxRetries,
            delay,
            error: lastError.message,
          },
          'Retrying LLM call after error',
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError || new Error('All retries exhausted');
  }

  protected ensureModel(requested?: string) {
    return requested ?? this.defaultModel;
  }

  protected logFallback(reason: string) {
    logger.warn({ provider: this.name, reason }, 'Falling back to mock AI response');
  }

  protected mockResponse(request: ProviderPromptRequest): ProviderPromptResponse {
    const prompt = request.prompt || '';
    const systemPrompt = request.systemPrompt || '';
    const fullPrompt = `${systemPrompt}\n${prompt}`.toLowerCase();
    
    // Detect request type from prompt content
    const isStyleRuleRequest = /extract.*style.*rule|formatting.*style.*rule|return.*json.*array.*style/i.test(fullPrompt);
    const isGlossaryRequest = /extract.*term|glossary.*term|return.*json.*array.*term/i.test(fullPrompt);
    const isSingleTermTranslation = /translate.*following.*technical.*term|return.*only.*translation/i.test(fullPrompt);
    
    if (isStyleRuleRequest) {
      // Return mock style rules format (multiple rules to avoid "no rules extracted" error)
      const mockStyleRules = [
        {
          ruleType: 'capitalization',
          pattern: 'Title Case for Headings',
          description: 'Headings use title case formatting',
          examples: ['Sample Heading', 'Another Heading']
        },
        {
          ruleType: 'date_format',
          pattern: 'DD.MM.YYYY',
          description: 'Dates are formatted with dots, day first',
          examples: ['12.01.2023', '30.05.2024']
        },
        {
          ruleType: 'spacing',
          pattern: 'Single space after periods',
          description: 'Single space is used after sentence-ending punctuation',
          examples: ['Sentence one. Sentence two.']
        }
      ];
      return {
        outputText: JSON.stringify(mockStyleRules),
        usage: {
          inputTokens: Math.round(prompt.length / 4),
          outputTokens: Math.round(JSON.stringify(mockStyleRules).length / 4),
          metadata: { mock: true, type: 'style_rules' },
        },
      };
    }
    
    if (isGlossaryRequest) {
      // Return mock glossary terms format (multiple terms to avoid "no terms extracted" error)
      const mockTerms = [
        { term: 'sample term', frequency: 3 },
        { term: 'another term', frequency: 2 },
        { term: 'technical term', frequency: 1 }
      ];
      return {
        outputText: JSON.stringify(mockTerms),
        usage: {
          inputTokens: Math.round(prompt.length / 4),
          outputTokens: Math.round(JSON.stringify(mockTerms).length / 4),
          metadata: { mock: true, type: 'glossary_terms' },
        },
      };
    }
    
    if (isSingleTermTranslation) {
      // For single term translation, extract the term from prompt and return simple text (not JSON)
      const termMatch = prompt.match(/Term:\s*(.+?)(?:\n|$)/i) || prompt.match(/term:\s*(.+?)(?:\n|$)/i);
      const sourceTerm = termMatch ? termMatch[1].trim() : 'term';
      
      // Extract target language from prompt
      const targetLangMatch = prompt.match(/to\s+(\w+)/i) || prompt.match(/from\s+\w+\s+to\s+(\w+)/i);
      const targetLang = targetLangMatch ? targetLangMatch[1].toLowerCase() : '';
      
      // Return simple text translation (not JSON array)
      const mockTranslation = targetLang 
        ? `${sourceTerm} [${this.name} mock translation to ${targetLang}]`
        : `${sourceTerm} [${this.name} mock translation]`;
      
      return {
        outputText: mockTranslation,
        usage: {
          inputTokens: Math.round(prompt.length / 4),
          outputTokens: Math.round(mockTranslation.length / 4),
          metadata: { mock: true, type: 'single_term_translation' },
        },
      };
    }
    
    // Default: translation format for segment-based translations (for backward compatibility)
    const segments = request.segments && Array.isArray(request.segments) && request.segments.length > 0
      ? request.segments
      : [{ segmentId: 'mock', sourceText: request.prompt || 'Test' }];
    
    let targetLangHint = '';
    const targetLangMatch = prompt.match(/TARGET LANGUAGE[:\s]+(\w+)/i) || 
                           prompt.match(/Target language[:\s]+(\w+)/i) ||
                           prompt.match(/translate.*to\s+(\w+)/i);
    
    if (targetLangMatch) {
      targetLangHint = targetLangMatch[1].toLowerCase();
    }
    
    const items = segments.map((segment) => {
      let mockTranslation = segment.sourceText;
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
        inputTokens: Math.round(prompt.length / 4),
        outputTokens: Math.round(items.reduce((acc, item) => acc + item.target_mt.length, 0) / 4),
        metadata: { mock: true, type: 'translation' },
      },
    };
  }
}









