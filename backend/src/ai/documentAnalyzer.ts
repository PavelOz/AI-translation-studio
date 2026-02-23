/**
 * Document Context Analyzer
 *
 * @deprecated Use Document DNA (generateDocumentDna + summaryFromDna) as the single source of truth for document context.
 * This analyzer used only the first 10k characters and did not use stride sampling or DNA.
 *
 * Analyzes document text to generate a "Translation Context Profile" that helps
 * the AIOrchestrator understand the document's genre, tone, and key terminology
 * for better translation quality.
 *
 * This analyzer uses fast/cheap AI models (Gemini Flash, GPT-4o-mini) since
 * it's a summarization task that doesn't require the highest quality models.
 */

import { logger } from '../utils/logger';
import { env } from '../utils/env';
import { getProvider } from './providers/registry';

export class DocumentAnalyzer {
  private readonly provider;
  private readonly model: string;

  constructor(apiKey?: string, providerName?: string, model?: string) {
    // Prefer fast/cheap models for summarization tasks
    const preferredProvider = providerName?.toLowerCase() || env.defaultAIProvider;
    
    // Get provider first to access defaultModel if needed
    this.provider = getProvider(preferredProvider, apiKey);
    
    // Select fast model based on provider
    let fastModel = model;
    if (!fastModel) {
      switch (preferredProvider) {
        case 'gemini':
          // Prefer Gemini Flash for speed, fallback to default
          fastModel = 'gemini-1.5-flash'; // Fast and cheap for summarization
          break;
        case 'openai':
          // Prefer GPT-4o-mini for cost efficiency
          fastModel = 'gpt-4o-mini';
          break;
        case 'yandex':
          fastModel = 'yandexgpt-lite';
          break;
        default:
          // Use provider's default model
          fastModel = this.provider.defaultModel;
      }
    }

    this.model = fastModel;
    
    logger.debug({
      provider: this.provider.name,
      model: this.model,
      hasApiKey: !!apiKey,
    }, 'DocumentAnalyzer initialized');
  }

  /**
   * Analyzes document context and generates a Translation Context Profile
   * 
   * @param fileName - Name of the document file (for context)
   * @param fullText - Full text content of the document
   * @returns A concise context profile string suitable for document.summary field
   */
  async analyzeContext(fileName: string, fullText: string): Promise<string> {
    try {
      // Truncate to first ~10,000 characters (roughly 3-4 pages)
      // This is enough to understand the genre without excessive token usage
      const truncatedText = fullText.length > 10000 
        ? fullText.substring(0, 10000) + '...' 
        : fullText;

      logger.debug({
        fileName,
        originalLength: fullText.length,
        truncatedLength: truncatedText.length,
      }, 'DocumentAnalyzer: Analyzing context');

      const prompt = this.buildAnalysisPrompt(fileName, truncatedText);

      const response = await this.provider.callModel({
        prompt,
        systemPrompt: 'You are a Senior Translation Strategist. Your role is to analyze documents and create concise Translation Context Profiles that help translators understand the document\'s genre, tone, and key terminology.',
        model: this.model,
        temperature: 0.3, // Lower temperature for more consistent analysis
        maxTokens: 500, // Summary should be concise
        segments: [{ segmentId: 'analysis', sourceText: truncatedText }],
      });

      const analysis = response.outputText.trim();
      
      logger.info({
        fileName,
        analysisLength: analysis.length,
        provider: this.provider.name,
        model: this.model,
      }, 'DocumentAnalyzer: Context analysis completed');

      return analysis;

    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : String(error),
        fileName,
        stack: error instanceof Error ? error.stack : undefined,
      }, 'DocumentAnalyzer: Failed to analyze context, using fallback');

      // Return generic fallback string rather than crashing
      return 'Context analysis failed, treating as general technical text';
    }
  }

  /**
   * Builds the analysis prompt for the AI
   */
  private buildAnalysisPrompt(fileName: string, textSnippet: string): string {
    return `Analyze this text snippet and create a concise "Translation Context Profile".

**Document File:** ${fileName}

**Text Snippet (first ~10,000 characters):**
${textSnippet}

**Required Output Format:**
Create a Translation Context Profile with the following sections:

1. **Genre:** Identify the document type (e.g., Contract, Technical Manual, Marketing Material, Official Report, Legal Document, Academic Paper, User Guide, etc.)

2. **Tone:** Describe the writing style (e.g., Formal, Dry, Persuasive, Neutral, Technical, Conversational, etc.)

3. **Key Terminology:** Identify 3-5 domain-specific themes or subject areas (e.g., "Banking & Finance", "Construction & Engineering", "Medical & Healthcare", "IT & Software", etc.)

4. **Summary:** One sentence describing what this document is about.

**Output Format:**
Return ONLY the profile text in this exact format (no markdown, no code blocks):

Genre: [genre]
Tone: [tone]
Key Terminology: [theme1], [theme2], [theme3]
Summary: [one sentence summary]

**Important:** Keep the output concise and professional. The profile will be used to guide translation quality.`;
  }
}

/**
 * Convenience function to analyze document context.
 * @deprecated Use Document DNA (generateDocumentDna) and summaryFromDna for document summary instead.
 */
export async function analyzeDocumentContext(
  fileName: string,
  fullText: string,
  apiKey?: string,
  providerName?: string,
  model?: string,
): Promise<string> {
  const analyzer = new DocumentAnalyzer(apiKey, providerName, model);
  return analyzer.analyzeContext(fileName, fullText);
}

