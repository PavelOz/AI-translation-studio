import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { getProvider } from './providers/registry';
import { env } from '../utils/env';
import { getLanguageName } from '../utils/languages';
import { getAddressFormattingRule, hasAddressFormattingRule } from './translationRules';
import type { 
  TranslateSegmentsOptions, 
  OrchestratorGlossaryEntry, 
  OrchestratorSegment, 
  ProviderUsage,
  TmExample,
  OrchestratorResult,
  TranslationProvider
} from './types';

// Re-export types for external use
export type { OrchestratorGlossaryEntry, OrchestratorSegment, TmExample, TranslateSegmentsOptions, ProviderUsage, OrchestratorResult, TranslationProvider };

type BatchJob = {
  chunkId: string;
  segments: OrchestratorSegment[];
};

// Helper function to chunk segments into batches
const chunkSegments = (segments: OrchestratorSegment[], size: number): BatchJob[] => {
  const jobs: BatchJob[] = [];
  for (let i = 0; i < segments.length; i += size) {
    jobs.push({ chunkId: randomUUID(), segments: segments.slice(i, i + size) });
  }
  return jobs;
};

export class AIOrchestrator {
  
  // ==========================================
  // 1. PROMPT BUILDING HELPERS
  // ==========================================

  private buildGuidelineSection(guidelines?: string[]) {
    if (!guidelines || guidelines.length === 0) {
      return '1. Follow standard professional translation practices.\n2. Preserve formatting, tags, and placeholders.';
    }
    return guidelines.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
  }

  private buildGlossarySection(glossary?: OrchestratorGlossaryEntry[]) {
    if (!glossary || glossary.length === 0) {
      return 'No glossary enforcement required.';
    }
    return glossary
      .slice(0, 200)
      .map(
        (entry) =>
          `- ${entry.term} => ${entry.translation}${entry.forbidden ? ' (FORBIDDEN TERM: do not translate differently)' : ''}${
            entry.notes ? ` | Notes: ${entry.notes}` : ''
          }`,
      )
      .join('\n');
  }

  private buildTranslationExamplesSection(tmExamples?: TmExample[]) {
    if (!tmExamples || tmExamples.length === 0) {
      return 'No translation examples available. Use your best judgment based on the glossary and guidelines.';
    }

    const topExamples = tmExamples.slice(0, 5);
    const examplesText = topExamples
      .map((ex, i) => {
        const methodLabel =
          ex.searchMethod === 'hybrid' ? 'hybrid (semantic + text match)' : ex.searchMethod === 'vector' ? 'semantic match' : 'text match';
        return `Example ${i + 1}:\n  Source: "${ex.sourceText}"\n  Target: "${ex.targetText}"\n  Match Quality: ${ex.fuzzyScore}% (${methodLabel})`;
      })
      .join('\n\n');

    return [
      '=== TRANSLATION EXAMPLES (Learn from these) ===',
      'These are similar translations from your translation memory. Use them to guide your translation style, terminology, and phrasing:',
      '',
      examplesText,
      '',
      'IMPORTANT:',
      '- Use the terminology and phrasing style from these examples',
      '- Match the translation approach shown above',
      '- If the examples use specific terms, use the same terms',
      '- Adapt the examples to fit the current segment context',
    ].join('\n');
  }

  private buildBatchPrompt(batch: OrchestratorSegment[], options: TranslateSegmentsOptions): string {
    const project = options.project ?? {};
    const guidelineText = this.buildGuidelineSection(options.guidelines);
    const glossaryText = this.buildGlossarySection(options.glossary);
    const examplesText = this.buildTranslationExamplesSection(options.tmExamples);
    
    const segmentsPayload = batch.map((segment) => ({
      segment_id: segment.segmentId,
      source: segment.sourceText,
      neighbors: {
        previous: segment.previousText ?? null,
        next: segment.nextText ?? null,
      },
      summary: segment.summary ?? null,
    }));

    const sourceLangCode = options.sourceLocale ?? project.sourceLang ?? 'ru';
    const targetLangCode = options.targetLocale ?? project.targetLang ?? 'en';
    const sourceLang = getLanguageName(sourceLangCode);
    const targetLang = getLanguageName(targetLangCode);
    
    // Detect if target is UK English for natural language instructions
    const isUKEnglish = targetLangCode.toLowerCase() === 'en-gb' || targetLangCode.toLowerCase() === 'en_gb';
    const isUSEnglish = targetLangCode.toLowerCase() === 'en-us' || targetLangCode.toLowerCase() === 'en_us';
    const isEnglish = targetLangCode.toLowerCase().startsWith('en');

    // Check if address formatting rules exist for this language pair
    const hasAddressRules = hasAddressFormattingRule(sourceLangCode, targetLangCode);
    
    // Build natural language quality instructions
    const naturalLanguageInstructions = this.buildNaturalLanguageInstructions(
      isUKEnglish,
      isUSEnglish,
      isEnglish,
      targetLangCode,
      hasAddressRules,
      sourceLangCode,
      targetLangCode
    );

    const document = options.document ?? {};
    
    // Build document context section
    const documentContextParts: string[] = [];
    if (document.name) {
      documentContextParts.push(`Document: ${document.name}`);
    }
    if (document.summary) {
      documentContextParts.push(`Document summary: ${document.summary}`);
    }
    if (document.clusterSummary) {
      documentContextParts.push(`Cluster context: ${document.clusterSummary}`);
    }
    const documentContext = documentContextParts.length > 0 
      ? `\n${documentContextParts.join('\n')}` 
      : '';

    return [
      'You are a professional technical/legal translator.',
      '',
      '=== TRANSLATION TASK (READ CAREFULLY - THIS IS CRITICAL) ===',
      `YOUR TASK: Translate text from ${sourceLang} to ${targetLang}.`,
      '',
      `SOURCE LANGUAGE: ${sourceLang} (code: ${sourceLangCode})`,
      `  - This is the ORIGINAL language of the input text`,
      `  - Input segments are written in ${sourceLang}`,
      '',
      `TARGET LANGUAGE: ${targetLang} (code: ${targetLangCode})`,
      `  - This is the TRANSLATION language for the output`,
      `  - ALL output translations MUST be in ${targetLang}`,
      '',
      `TRANSLATION DIRECTION: ${sourceLang} → ${targetLang}`,
      '',
      naturalLanguageInstructions,
      '',
      `CRITICAL RULES (MUST FOLLOW):`,
      `1. Input text is written in ${sourceLang} (SOURCE language)`,
      `2. You MUST translate it to ${targetLang} (TARGET language)`,
      `3. Output text MUST be written in ${targetLang} ONLY`,
      `4. DO NOT return text in ${sourceLang} - it is WRONG`,
      `5. DO NOT return text in any other language - ONLY ${targetLang}`,
      `6. All translations in the JSON response MUST be in ${targetLang} language only.`,
      `7. If you return text in ${sourceLang}, the translation is INCORRECT and will be rejected.`,
      '',
      '=== PROJECT CONTEXT ===',
      `Project: ${project.name ?? 'AI Translation Studio'} | Client: ${project.client ?? 'N/A'} | Domain: ${project.domain ?? 'general'}`,
      project.summary ? `Project summary/context: ${project.summary}` : 'Project summary/context: not provided.',
      documentContext,
      '',
      examplesText,
      '',
      '=== TRANSLATION GUIDELINES ===',
      'Follow ALL guidelines strictly:',
      guidelineText,
      '',
      '=== GLOSSARY ===',
      'Glossary (must be enforced exactly):',
      glossaryText,
      '',
      '=== OUTPUT FORMAT ===',
      'Translate each segment and return ONLY valid JSON matching this schema:',
      `[{"segment_id":"<id>","target_mt":"<translation>"}]`,
      'Do not include comments or prose outside the JSON array.',
      `IMPORTANT: All translations must be in the target language (${targetLang}).`,
      '',
      '=== SEGMENTS TO TRANSLATE ===',
      JSON.stringify(segmentsPayload, null, 2),
    ].join('\n');
  }

  /**
   * Build address standardization rules dynamically based on language pair
   */
  private buildAddressStandardizationRules(
    sourceLocale: string,
    targetLocale: string
  ): string {
    const rule = getAddressFormattingRule(sourceLocale, targetLocale);
    
    if (!rule) {
      return ''; // No rule for this language pair
    }

    // Build examples from transformations
    const examples = rule.transformations
      .filter(t => t.example)
      .map(t => `- "${t.example!.source}" → "${t.example!.target}"`)
      .join('\n');

    // Build detection keywords section if available
    const detectionKeywordsSection = rule.detectionKeywords && rule.detectionKeywords.length > 0
      ? `ADDRESS DETECTION KEYWORDS:\nLook for these keywords that indicate an address is present:\n${rule.detectionKeywords.map(kw => `- "${kw}"`).join('\n')}\n`
      : '';

    return [
      `=== ADDRESS STANDARDIZATION (${rule.description}) ===`,
      detectionKeywordsSection,
      rule.instructions,
      '',
      examples ? `TRANSFORMATION EXAMPLES:\n${examples}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Build address compliance check instructions for critic
   */
  private buildAddressComplianceCheck(
    sourceLocale: string,
    targetLocale: string
  ): string {
    const rule = getAddressFormattingRule(sourceLocale, targetLocale);
    
    if (!rule) {
      return ''; // No rule for this language pair
    }

    const examples = rule.transformations
      .filter(t => t.example)
      .map(t => `- Source: "${t.example!.source}" → Expected: "${t.example!.target}"`)
      .join('\n');

    const terminologyList = Object.entries(rule.terminology)
      .map(([key, value]) => `- "${key}" → "${value}"`)
      .join('\n');

    return [
      '=== ADDRESS FORMATTING COMPLIANCE ===',
      `Check that addresses follow ${rule.description}:`,
      '',
      `REQUIRED FORMAT: ${rule.format}`,
      '',
      'CHECK FOR COMPLIANCE:',
      '1. Address order: Verify addresses follow the target language format, not source language order',
      '2. House/building number: Must be at the beginning of the address line',
      '3. Terminology: Verify address terms are translated correctly',
      '4. Formatting: Check proper use of abbreviations (St., Ave., Blvd., etc.)',
      '',
      examples ? `TRANSFORMATION EXAMPLES:\n${examples}` : '',
      '',
      terminologyList ? `TERMINOLOGY MAPPINGS:\n${terminologyList}` : '',
      '',
      'FLAG AS ERROR if:',
      '- Address follows source language order instead of target format',
      '- House/building number is not at the beginning',
      '- Address terminology is not translated correctly',
      '- Address format does not match the required format',
      '',
      'FLAG AS WARNING if:',
      '- Address format is mostly correct but has minor formatting issues',
      '- Terminology is correct but formatting could be improved',
      '',
      'Remember: Address formatting compliance is critical for professional translations.',
    ].filter(Boolean).join('\n');
  }

  /**
   * Build naturalness instructions for critique/QA stage
   */
  private buildCritiqueNaturalnessInstructions(
    isUKEnglish: boolean,
    targetLang: string,
    targetLocale?: string,
    hasAddressRules: boolean = false,
    sourceLocale: string = '',
    targetLocaleForAddress: string = ''
  ): string {
    // Build address compliance check section
    const addressComplianceSection = hasAddressRules && sourceLocale && targetLocaleForAddress
      ? this.buildAddressComplianceCheck(sourceLocale, targetLocaleForAddress)
      : '';

    if (isUKEnglish) {
      return [
        '=== NATURALNESS CHECK: UK ENGLISH ===',
        'In addition to glossary checks, verify the translation sounds natural and native-like:',
        '',
        'CHECK FOR:',
        '1. UK spelling: "colour", "organise", "centre", "realise" (not US "color", "organize", "center", "realize")',
        '2. UK vocabulary: "lift", "boot", "pavement", "flat" (not US "elevator", "trunk", "sidewalk", "apartment")',
        '3. Natural phrasing: Avoid literal translations that sound awkward',
        '4. Idiomatic expressions: Use natural UK English idioms where appropriate',
        '',
        addressComplianceSection,
        '',
        'FLAG AS WARNING (not error) if translation:',
        '- Uses US spelling or vocabulary when UK is required',
        '- Sounds overly literal or unnatural',
        '- Contains awkward phrasing that reveals translation origin',
        '',
        'Remember: Naturalness is important but secondary to glossary accuracy.',
      ].filter(Boolean).join('\n');
    }
    
    return [
      '=== NATURALNESS CHECK ===',
      'Verify the translation sounds natural and native-like:',
      '',
      addressComplianceSection,
      '',
      'FLAG AS WARNING (not error) if translation:',
      '- Sounds overly literal or unnatural',
      '- Contains awkward phrasing that reveals translation origin',
      '- Uses inappropriate register for technical/legal content',
      '',
      'Remember: Naturalness is important but secondary to glossary accuracy.',
    ].filter(Boolean).join('\n');
  }

  /**
   * Build natural language quality instructions based on target locale
   * This ensures translations sound natural and native-like
   */
  private buildNaturalLanguageInstructions(
    isUKEnglish: boolean,
    isUSEnglish: boolean,
    isEnglish: boolean,
    targetLangCode: string,
    hasAddressRules: boolean = false,
    sourceLocale: string = '',
    targetLocale: string = ''
  ): string {
    // Build address standardization section dynamically based on language pair
    const addressStandardizationSection = hasAddressRules 
      ? this.buildAddressStandardizationRules(sourceLocale, targetLocale) 
      : '';
    
    if (isUKEnglish) {
      return [
        '=== TRANSLATION QUALITY: NATURAL UK ENGLISH ===',
        'CRITICAL: Your translations must sound natural and fluent, as if written by a native UK English speaker.',
        '',
        'QUALITY REQUIREMENTS:',
        '1. Natural phrasing: Use idiomatic UK English expressions and sentence structures',
        '2. UK spelling: Use British spelling (e.g., "colour", "organise", "centre", "realise")',
        '3. UK vocabulary: Prefer UK English terms (e.g., "lift" not "elevator", "boot" not "trunk", "pavement" not "sidewalk")',
        '4. Natural flow: Avoid literal/word-for-word translations - rewrite for naturalness',
        '5. Professional tone: Maintain formal, professional register appropriate for technical/legal content',
        '6. Native-like: The translation should read as if originally written in UK English, not translated',
        '',
        addressStandardizationSection,
        '',
        'AVOID:',
        '- Literal translations that sound unnatural',
        '- US English spelling or vocabulary',
        '- Awkward phrasing that reveals the source language structure',
        '- Overly formal or stilted language',
        '',
        'EXAMPLE OF GOOD NATURAL TRANSLATION:',
        'Source (Russian): "Необходимо провести анализ данных"',
        'Bad (literal): "It is necessary to conduct an analysis of data"',
        'Good (natural UK): "The data needs to be analysed" or "An analysis of the data is required"',
        '',
        'Remember: Accuracy is essential, but naturalness is equally important. A native UK English speaker should not be able to tell this was translated.',
      ].filter(Boolean).join('\n');
    } else if (isUSEnglish) {
      return [
        '=== TRANSLATION QUALITY: NATURAL US ENGLISH ===',
        'CRITICAL: Your translations must sound natural and fluent, as if written by a native US English speaker.',
        '',
        'QUALITY REQUIREMENTS:',
        '1. Natural phrasing: Use idiomatic US English expressions and sentence structures',
        '2. US spelling: Use American spelling (e.g., "color", "organize", "center", "realize")',
        '3. US vocabulary: Prefer US English terms (e.g., "elevator" not "lift", "trunk" not "boot", "sidewalk" not "pavement")',
        '4. Natural flow: Avoid literal/word-for-word translations - rewrite for naturalness',
        '5. Professional tone: Maintain formal, professional register appropriate for technical/legal content',
        '6. Native-like: The translation should read as if originally written in US English, not translated',
        '',
        addressStandardizationSection,
        '',
        'AVOID:',
        '- Literal translations that sound unnatural',
        '- UK English spelling or vocabulary',
        '- Awkward phrasing that reveals the source language structure',
        '- Overly formal or stilted language',
        '',
        'Remember: Accuracy is essential, but naturalness is equally important. A native US English speaker should not be able to tell this was translated.',
      ].filter(Boolean).join('\n');
    } else if (isEnglish) {
      // Generic English (en without locale)
      return [
        '=== TRANSLATION QUALITY: NATURAL ENGLISH ===',
        'CRITICAL: Your translations must sound natural and fluent, as if written by a native English speaker.',
        '',
        'QUALITY REQUIREMENTS:',
        '1. Natural phrasing: Use idiomatic English expressions and sentence structures',
        '2. Natural flow: Avoid literal/word-for-word translations - rewrite for naturalness',
        '3. Professional tone: Maintain formal, professional register appropriate for technical/legal content',
        '4. Native-like: The translation should read as if originally written in English, not translated',
        '',
        addressStandardizationSection,
        '',
        'AVOID:',
        '- Literal translations that sound unnatural',
        '- Awkward phrasing that reveals the source language structure',
        '- Overly formal or stilted language',
        '',
        'Remember: Accuracy is essential, but naturalness is equally important. A native English speaker should not be able to tell this was translated.',
      ].filter(Boolean).join('\n');
    }
    
    // For non-English languages, still emphasize naturalness
    return [
      '=== TRANSLATION QUALITY: NATURAL LANGUAGE ===',
      'CRITICAL: Your translations must sound natural and fluent, as if written by a native speaker.',
      '',
      'QUALITY REQUIREMENTS:',
      '1. Natural phrasing: Use idiomatic expressions and natural sentence structures',
      '2. Natural flow: Avoid literal/word-for-word translations - rewrite for naturalness',
      '3. Professional tone: Maintain appropriate register for technical/legal content',
      '4. Native-like: The translation should read as if originally written in the target language, not translated',
      '',
      'AVOID:',
      '- Literal translations that sound unnatural',
      '- Awkward phrasing that reveals the source language structure',
      '- Overly formal or stilted language',
      '',
      'Remember: Accuracy is essential, but naturalness is equally important.',
    ].join('\n');
  }

  // ==========================================
  // 2. STANDARD TRANSLATION METHODS
  // ==========================================

  private parseProviderResponse(text: string, fallbackSegments: OrchestratorSegment[]): Array<{ segmentId: string; targetText: string }> {
    // Basic cleanup
    let cleanedText = text.trim();
    if (cleanedText.startsWith('```')) {
       const lines = cleanedText.split('\n');
       if (lines[0].match(/^```(json)?$/i)) lines.shift(); 
       if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop(); 
       cleanedText = lines.join('\n').trim(); 
    }

    const start = cleanedText.indexOf('[');
    const end = cleanedText.lastIndexOf(']');
    
    if (start === -1 || end === -1 || end < start) {
      throw new Error('Provider response did not contain a JSON array');
    }
    
    const sliced = cleanedText.slice(start, end + 1);
    let parsed;
    try {
        parsed = JSON.parse(sliced);
    } catch (e) {
        throw new Error(`JSON Parse Error: ${(e as Error).message}`);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Provider returned empty translation array');
    }

    const map = new Map<string, string>();
    parsed.forEach((entry: any) => {
      if (entry.segment_id && typeof entry.target_mt === 'string') {
        let targetText = entry.target_mt.trim();
        
        // Remove mock/synthetic translation markers
        targetText = targetText.replace(/\s*\[(?:gemini|openai|yandex|gpt|ai)\s+synthetic\s+translation\]\s*/gi, '').trim();
        targetText = targetText.replace(/\s*\[mock\s+translation\]\s*/gi, '').trim();
        targetText = targetText.replace(/\s*\[synthetic\]\s*/gi, '').trim();
        targetText = targetText.replace(/\s*\[\s*\]\s*$/, '').trim();
        
        map.set(entry.segment_id, targetText);
      }
    });

    if (map.size === 0) {
      throw new Error('Provider response missing target text');
    }

    return fallbackSegments.map((segment) => ({
      segmentId: segment.segmentId,
      targetText: map.get(segment.segmentId) ?? segment.sourceText,
    }));
  }

  private ruleBasedBatch(segments: OrchestratorSegment[]): OrchestratorResult[] {
    return segments.map((segment) => ({
      segmentId: segment.segmentId,
      targetText: segment.sourceText,
      provider: 'rule-based',
      model: 'mirror',
      confidence: 0.35,
      fallback: true,
    }));
  }

  async translateSegments(options: TranslateSegmentsOptions): Promise<OrchestratorResult[]> {
    if (!options.segments || options.segments.length === 0) {
      return [];
    }
    const provider = getProvider(options.provider, options.apiKey, options.yandexFolderId);
    const model = options.model ?? provider.defaultModel;
    const batchSize = options.batchSize ?? env.aiBatchSize ?? 20;
    const retries = options.retries ?? env.aiMaxRetries ?? 3;
    const batches = chunkSegments(options.segments, batchSize);
    const results: OrchestratorResult[] = [];

    for (const job of batches) {
      let attempt = 0;
      let success = false;
      while (attempt < retries && !success) {
        try {
          const prompt = this.buildBatchPrompt(job.segments, options);
          
          // Log prompt for YandexGPT debugging
          if (provider.name === 'yandex') {
            logger.debug({
              provider: 'yandex',
              model,
              promptLength: prompt.length,
              promptPreview: prompt.substring(0, 500),
              sourceLocale: options.sourceLocale,
              targetLocale: options.targetLocale,
            }, 'YandexGPT translation request');
          }
          
          const response = await provider.callModel({
            prompt,
            model,
            temperature: options.temperature ?? 0.2,
            maxTokens: options.maxTokens ?? 1024,
            segments: job.segments.map((segment) => ({ segmentId: segment.segmentId, sourceText: segment.sourceText })),
          });
          
          // Log response for YandexGPT debugging
          if (provider.name === 'yandex') {
            logger.debug({
              provider: 'yandex',
              model,
              responseLength: response.outputText.length,
              responsePreview: response.outputText.substring(0, 300),
            }, 'YandexGPT translation response');
          }
          
          const parsed = this.parseProviderResponse(response.outputText, job.segments);
          parsed.forEach((item) =>
            results.push({
              segmentId: item.segmentId,
              targetText: item.targetText,
              provider: provider.name,
              model,
              confidence: 0.9,
              usage: response.usage,
              raw: response.raw,
              fallback: false
            }),
          );
          logger.info({ provider: provider.name, chunkId: job.chunkId }, 'AI translation chunk completed');
          success = true;
        } catch (error) {
          attempt += 1;
          logger.warn({ provider: provider.name, chunkId: job.chunkId, attempt, error: (error as Error).message }, 'AI translation chunk failed');
          if (attempt >= retries) {
            const fallback = this.ruleBasedBatch(job.segments);
            results.push(...fallback);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
          }
        }
      }
    }
    return results;
  }

  /**
   * Translate a single segment (used in non-critic mode)
   */
  async translateSingleSegment(
    segment: OrchestratorSegment,
    options: Omit<TranslateSegmentsOptions, 'segments'>,
  ): Promise<OrchestratorResult> {
    const [result] = await this.translateSegments({
      ...options,
      segments: [segment],
    });
    if (!result) {
      return this.ruleBasedBatch([segment])[0];
    }
    return result;
  }

  // ==========================================
  // 3. AGENTIC WORKFLOW (Draft -> Critic -> Editor)
  // ==========================================

  /**
   * Step 1: Generate Draft
   * Pure AI translation, ignoring TM threshold (TM only used for context).
   */
  async generateDraft(
    sourceText: string,
    options: Omit<TranslateSegmentsOptions, 'segments'>,
  ): Promise<{ draftText: string; modelUsed: string; usage?: ProviderUsage }> {
    const provider = getProvider(options.provider, options.apiKey, options.yandexFolderId);
    const model = options.model ?? provider.defaultModel;

    logger.info({ sourceLength: sourceText.length }, 'Step 1: Generating Draft');

    const [result] = await this.translateSegments({
      ...options,
      segments: [{ segmentId: 'draft', sourceText }],
    });

    // Remove mock/synthetic translation markers from draft
    let draftText = result.targetText;
    draftText = draftText.replace(/\s*\[(?:gemini|openai|yandex|gpt|ai)\s+synthetic\s+translation\]\s*/gi, '').trim();
    draftText = draftText.replace(/\s*\[mock\s+translation\]\s*/gi, '').trim();
    draftText = draftText.replace(/\s*\[synthetic\]\s*/gi, '').trim();
    draftText = draftText.replace(/\s*\[\s*\]\s*$/, '').trim();

    return {
      draftText,
      modelUsed: model,
      usage: result.usage,
    };
  }

  /**
   * Step 2: Run Critique (The QA Agent)
   * Uses "Chain of Thought", "Linguistic Flexibility" AND "Code-Level Safety Filters".
   */
  async runCritique(
    sourceText: string,
    draftText: string,
    glossary: OrchestratorGlossaryEntry[] | undefined,
    options: { provider?: string; model?: string; apiKey?: string; yandexFolderId?: string; sourceLocale?: string; targetLocale?: string; maxTokens?: number },
  ): Promise<{
    errors: Array<{ term: string; expected: string; found: string; severity: string }>;
    reasoning: string;
    usage?: ProviderUsage;
  }> {
    const provider = getProvider(options.provider, options.apiKey, options.yandexFolderId);
    let model = options.model ?? provider.defaultModel;
    
    // For Gemini 2.5 Flash and newer models with thoughts, use gemini-1.5-pro for critic workflow
    // to avoid thoughtsTokenCount consuming all output tokens
    if (provider.name === 'gemini' && (model.includes('2.5') || model.includes('2.0') || model.includes('3.0'))) {
      logger.debug({
        originalModel: model,
        fallbackModel: 'gemini-1.5-pro',
        reason: 'Gemini 2.5+ models use thoughts which can consume all output tokens',
      }, 'Switching to gemini-1.5-pro for critic workflow to avoid thoughts token consumption');
      model = 'gemini-1.5-pro';
    }

        // Log glossary info for debugging (truncate to avoid encoding issues in logs)
        logger.debug({
          glossaryCount: glossary?.length || 0,
          glossarySample: glossary?.slice(0, 5).map(g => g.term?.substring(0, 50) || ''),
          sourceTextLength: sourceText.length,
          sourceTextPreview: sourceText.substring(0, 50),
        }, 'Critic: Starting critique with glossary');

    // 1. Build the Improved Prompt
    const glossaryText = this.buildGlossarySection(glossary);
    
    // Log if glossary is empty
    if (!glossary || glossary.length === 0) {
      logger.warn('Critic: No glossary entries provided');
        } else {
          logger.debug({
            glossaryTextLength: glossaryText.length,
            glossaryEntriesCount: glossary.length,
          }, 'Critic: Glossary section built');
        }
    
    // Determine language direction from options or glossary entries
    const sourceLocale = options.sourceLocale;
    const targetLocale = options.targetLocale;
    const sourceLang = sourceLocale ? getLanguageName(sourceLocale) : 'Source';
    const targetLang = targetLocale ? getLanguageName(targetLocale) : 'Target';
    
    // Detect if target is UK English for naturalness checks
    const isUKEnglish = targetLocale?.toLowerCase() === 'en-gb' || targetLocale?.toLowerCase() === 'en_gb';
    
    // Check if address formatting rules exist for compliance checking
    const hasAddressRules = sourceLocale && targetLocale 
      ? hasAddressFormattingRule(sourceLocale, targetLocale) 
      : false;
    
    const naturalnessCheck = this.buildCritiqueNaturalnessInstructions(
      isUKEnglish, 
      targetLang, 
      targetLocale,
      hasAddressRules,
      sourceLocale || '',
      targetLocale || ''
    );
    
    const prompt = [
      'You are a Senior QA Linguist. Your job is to catch CRITICAL glossary errors and ensure natural, native-sounding translations, but ignore minor grammatical variations.',
      '',
      '=== TRANSLATION DIRECTION (CRITICAL - READ CAREFULLY) ===',
      `Translation direction: ${sourceLang} → ${targetLang}`,
      `Source language: ${sourceLang}`,
      `Target language: ${targetLang}`,
      '',
      'CRITICAL UNDERSTANDING:',
      `- The "Source" text is written in ${sourceLang} (the ORIGINAL language)`,
      `- The "Draft" text is a TRANSLATION into ${targetLang} (the TARGET language)`,
      `- You must check if the Draft (${targetLang}) correctly uses the TARGET language terms from the glossary`,
      '',
      naturalnessCheck,
      '',
      '=== GLOSSARY FORMAT (Source => Target) ===',
      `The glossary shows: ${sourceLang} term => ${targetLang} term`,
      '',
      'EXAMPLE FOR UNDERSTANDING:',
      `If glossary entry is "проект => жоба" (${sourceLang} => ${targetLang}):`,
      `  - "проект" is a ${sourceLang} term (appears in Source text)`,
      `  - "жоба" is the ${targetLang} term (MUST appear in Draft text)`,
      `  - You check: Does the Draft (${targetLang} translation) use "жоба"?`,
      `  - If Draft uses "проект" (${sourceLang} word) → ERROR (wrong language!)`,
      `  - If Draft uses "жоба" (${targetLang} word) → CORRECT`,
      '',
      '=== GLOSSARY ENTRIES ===',
      glossaryText || 'No glossary terms provided.',
      '',
      '=== TEXTS TO CHECK ===',
      `Source (${sourceLang}): "${sourceText}"`,
      `Draft (${targetLang}): "${draftText}"`,
      '',
      '=== CRITICAL: TERM EXTRACTION FROM COMPOUND PHRASES ===',
      'When a glossary entry contains multiple words (e.g., "Отдел строительства и реконструкции ПС" => "substation construction and rehabilitation unit"):',
      '1. EXTRACT the KEY TERM that appears in the source text.',
      '   - Example: Source text has "реконструкция" → Find it in glossary entry "Отдел строительства и реконструкции ПС".',
      '2. IDENTIFY the corresponding target term in the glossary translation.',
      '   - Example: In "substation construction and rehabilitation unit", the term "rehabilitation" corresponds to "реконструкция".',
      '3. CHECK if the draft uses this exact target term (allowing for case/morphology).',
      '   - Example: If draft has "Expansion/reconstruction" but glossary requires "rehabilitation" → ERROR.',
      '',
      '=== CRITICAL EXAMPLE: EXTRACTING TERMS FROM MULTI-WORD GLOSSARY ENTRIES ===',
      '',
      'Example 1 (Russian → Kazakh):',
      'Glossary entry: "Отдел цифровизации и энергоэффективности" => "Цифрландыру және энергия тиімділігі бөлімі"',
      'Source text contains: "энергоэффективности"',
      '',
      'STEP 1: Find "энергоэффективности" in the source glossary term "Отдел цифровизации и энергоэффективности"',
      '  → Found! It is the second part of the compound term.',
      '',
      'STEP 2: Extract the corresponding target term from "Цифрландыру және энергия тиімділігі бөлімі"',
      '  → The target term that corresponds to "энергоэффективности" is "энергия тиімділігі" (the second part)',
      '  → NOT "энергоэффективтік" (this is a wrong translation)',
      '  → NOT the full phrase "Цифрландыру және энергия тиімділігі бөлімі"',
      '',
      'STEP 3: Check if the draft uses "энергия тиімділігі" (or its morphological variant)',
      '  → If draft has "энергия тиімділігі" or "энергия тиімділігін" → CORRECT',
      '  → If draft has "энергоэффективтік" → ERROR (wrong term)',
      '',
      'Example 2 (Russian → English):',
      'Glossary entry: "Отдел строительства и реконструкции ПС" => "substation construction and rehabilitation unit"',
      'Source text contains: "реконструкции"',
      '',
      'STEP 1: Find "реконструкции" in the source glossary term "Отдел строительства и реконструкции ПС"',
      '  → Found! It is the second part.',
      '',
      'STEP 2: Extract the corresponding target term from "substation construction and rehabilitation unit"',
      '  → The target term that corresponds to "реконструкции" is "rehabilitation" (the second part)',
      '  → NOT "reconstruction" (this is a wrong translation)',
      '  → NOT the full phrase "substation construction and rehabilitation unit"',
      '',
      'STEP 3: Check if the draft uses "rehabilitation" (or its morphological variant)',
      '  → If draft has "rehabilitation" or "rehabilitated" → CORRECT',
      '  → If draft has "reconstruction" → ERROR (wrong term)',
      '',
      'RULE: When extracting a term from a multi-word glossary entry:',
      '1. Identify which WORD (or phrase) in the source glossary term appears in the source text',
      '2. Find the CORRESPONDING WORD (or phrase) in the target glossary translation',
      '   - Usually it is in the same position (first part → first part, second part → second part)',
      '   - Or match by semantic meaning (what the word means)',
      '3. Use that SPECIFIC word/phrase as the expected term, NOT a different translation',
      '4. Allow for morphological variants (cases, numbers) but the ROOT must match',
      '5. DO NOT invent new translations - use ONLY what is in the glossary',
      '',
      '=== SEARCHING FOR TERMS IN COMPOUND WORDS ===',
      'When searching for a term in the draft:',
      '1. Look for EXACT matches first (case-insensitive).',
      '2. Look for the term as PART of a compound word or phrase.',
      '   - Example: If looking for "reconstruction" in draft "Expansion/reconstruction of...", find it after the "/".',
      '   - Example: If looking for "rehabilitation" but draft has "reconstruction" → ERROR.',
      '3. Handle special characters like "/", "-", spaces correctly.',
      '   - "Expansion/reconstruction" contains "reconstruction" as a separate word part.',
      '   - "Expansion-reconstruction" also contains "reconstruction".',
      '',
      '=== STRICT RULES FOR "FALSE POSITIVES" ===',
      '1. CASE INSENSITIVE: "Cat" equals "cat". DO NOT report this as an error.',
      '2. IGNORE INFLECTIONS (Morphology):',
      '   - If glossary says "облако" (nominative) but draft has "в облаке" (prepositional) -> IT IS CORRECT.',
      '   - If glossary says "бежать" (infinitive) but draft has "бежит" (verb) -> IT IS CORRECT.',
      '   - CHECK THE ROOT: If the root of the word matches, status is "correct".',
      '3. HANDLE SPECIAL CHARACTERS:',
      '   - "/" separates words: "Expansion/reconstruction" = two words: "Expansion" and "reconstruction".',
      '   - "-" can separate words: "Expansion-reconstruction" = two words.',
      '   - Spaces separate words: "Expansion reconstruction" = two words.',
      '',
      '=== CRITICAL: MORPHOLOGICAL VARIANT DETECTION ===',
      'IMPORTANT: Words can appear in different forms (cases, numbers, tenses).',
      'You MUST find terms even if they appear in different morphological forms:',
      '- "проект" (nominative) = "проекта" (genitive) = "проекты" (plural) = "проектов" (genitive plural)',
      '- "реконструкция" = "реконструкции" = "реконструкцию" = "реконструкций"',
      '- "облако" = "облака" = "облаке" = "облаков"',
      '- "энергоэффективность" = "энергоэффективности" (genitive) = "энергоэффективностью" (instrumental)',
      '- "эффективность" = "эффективности" = "эффективностью" = "эффективностей"',
      '',
      'HOW TO FIND MORPHOLOGICAL VARIANTS:',
      '1. Extract the ROOT of the glossary term (remove endings like -а, -ы, -ов, -ия, -ии, -ости, -остии, etc.)',
      '2. For COMPOUND WORDS (like "энергоэффективности"), extract the KEY PARTS:',
      '   - "энергоэффективности" → roots: "энерго", "эффективн"',
      '   - "энергоэффективность" → roots: "энерго", "эффективн"',
      '   - If Source has "энергоэффективности" and glossary has "энергоэффективность" → TERM FOUND',
      '3. Search for these ROOTS in the Source text (case-insensitive)',
      '4. If ANY root appears (even in a different form), the term is PRESENT in the source',
      '',
      'EXAMPLES:',
      '- Glossary: "проект" → If Source has "проекты" or "проектов" → TERM FOUND (root "проект" matches)',
      '- Glossary: "Отдел по управлению проектами" → If Source has "проекты" → TERM FOUND (contains "проект")',
      '- Glossary: "реконструкция" → If Source has "реконструкции" or "реконструкцию" → TERM FOUND',
      '- Glossary: "Отдел цифровизации и энергоэффективности" → If Source has "энергоэффективности" or "энергоэффективность" → TERM FOUND',
      '- Glossary: "энергоэффективность" → If Source has "энергоэффективности" (genitive) → TERM FOUND',
      '',
      '=== CHAIN OF THOUGHT PROCESS ===',
      'For EACH glossary entry:',
      'STEP 1: Identify if the source term (or its ROOT) appears in the Source text.',
      '   - Extract the ROOT of the glossary term (remove common endings)',
      '   - Search for this ROOT in the Source text (case-insensitive, allowing morphological variants)',
      '   - If glossary entry is "Отдел по управлению проектами и эффективностью":',
      '     * Extract roots: "проект", "эффективн"',
      '     * Check if "проект" root appears in Source (e.g., "проекты", "проектов", "проект")',
      '     * If YES → Proceed to STEP 2.',
      '     * If NO → Skip this entry (term not in source).',
      '   - If glossary entry is "Отдел цифровизации и энергоэффективности":',
      '     * Extract roots: "цифров", "энерго", "эффективн"',
      '     * Check if "энерго" OR "эффективн" appears in Source (e.g., "энергоэффективности", "энергоэффективность")',
      '     * Also check for compound word parts: "энерго" + "эффективн"',
      '     * If YES → Proceed to STEP 2.',
      '     * If NO → Skip this entry (term not in source).',
      '',
      'STEP 2: Extract the target term from the glossary translation.',
      '   - From "substation construction and rehabilitation unit":',
      '     * Identify that "rehabilitation" corresponds to "реконструкция".',
      '     * This is your EXPECTED term.',
      '   - From "Цифрландыру және энергия тиімділігі бөлімі":',
      '     * Identify that "энергия тиімділігі" corresponds to "энергоэффективности" (second part → second part).',
      '     * This is your EXPECTED term: "энергия тиімділігі".',
      '     * DO NOT use "энергоэффективтік" - that is NOT in the glossary.',
      '     * DO NOT use the full phrase "Цифрландыру және энергия тиімділігі бөлімі" - use only the relevant part.',
      '',
      'STEP 3: Search for the target term in the Draft.',
      '   - Look for "rehabilitation" in the draft text.',
      '   - Also check for variations (case, morphology).',
      '   - Check if it appears as part of compound words (e.g., "Expansion/rehabilitation").',
      '',
      'STEP 4: Compare and decide.',
      '   - If found "rehabilitation" (or valid variation) → Status: "correct".',
      '   - If found "reconstruction" (or other wrong term) → Status: "error".',
      '   - If not found at all → Status: "missing".',
      '',
      'STEP 5: Report the error (if any).',
      '   - Quote 3-4 words of context from the draft where the error was found.',
      '   - Specify: term (source), expected (from glossary), found (actual in draft).',
      '',
      '=== OUTPUT FORMAT ===',
      'Return a JSON array of objects. Example:',
      '[',
      '  {',
      '    "term": "реконструкция",',
      '    "expected": "rehabilitation",',
      '    "found": "reconstruction",',
      '    "status": "error",',
      '    "reasoning": "Glossary requires \'rehabilitation\' for \'реконструкция\', but draft uses \'reconstruction\' in \'Expansion/reconstruction of...\'"',
      '  }',
      ']',
      '',
      'IMPORTANT:',
      '- Evaluate EVERY glossary term that appears in the source text.',
      '- Return ONLY valid JSON (no comments, no markdown, no extra text).',
      '- If no errors found, return empty array: [].',
      '- The JSON must be parseable and contain only the array of error objects.',
    ].join('\n');

    // 2. Call AI
    // Critic prompts are very long (detailed instructions + glossary + examples)
    // Responses can also be long (JSON array + reasoning)
    // Use much higher maxTokens to avoid truncation
    // Gemini API supports up to 8192 output tokens for most models
    const criticMaxTokens = options.maxTokens ? Math.max(options.maxTokens, 8192) : 8192; // Default 8192 for critic
    
    logger.debug({
      promptLength: prompt.length,
      promptTokensEstimate: Math.ceil(prompt.length / 4), // Rough estimate: ~4 chars per token
      maxTokens: criticMaxTokens,
      glossaryEntriesCount: glossary?.length || 0,
    }, 'Critic: Calling AI with increased maxTokens');
    
    const response = await provider.callModel({
      prompt,
      model,
      temperature: 0.1, // Keep it cold and logical
      maxTokens: criticMaxTokens,
      segments: [{ segmentId: 'critique', sourceText }],
    });

    const text = response.outputText.trim();
    let errors: any[] = [];
    let reasoning = '';

    // Улучшенная функция normalize - заменяет "/" на пробел
    const normalize = (str: string) => {
      if (!str) return '';
      return str
        .toLowerCase()
        .replace(/\//g, ' ')  // Заменяем "/" на пробел для разделения слов
        .replace(/[.,#!$%^&*;:{}=\-_`~()]/g, '')  // Удаляем другие спецсимволы
        .replace(/\s+/g, ' ')  // Нормализуем пробелы
        .trim();
    };

    // 3. Улучшенный парсинг JSON
    try {
      const { parsed, reasoning: extractedReasoning } = this.parseCriticResponse(text);
      reasoning = extractedReasoning;
      
      // FILTERING LOGIC (The Safety Net)
      errors = parsed
        .filter((item: any) => {
          // Rule A: Status must be error/missing
          if (item.status === 'correct') return false;

          // Rule B: Code-Level Override for Case/Morphology
          if (item.found && item.expected) {
            const cleanFound = normalize(item.found);
            const cleanExpected = normalize(item.expected);
            
            // Exact match (case-insensitive, ignoring special chars) -> Not an error
            if (cleanFound === cleanExpected) return false;
            
            // Substring match (e.g. "в облаке" contains "облак") 
            // We check if the expected root (first 4-5 chars) is inside the found word
            if (cleanExpected.length >= 4 && cleanFound.includes(cleanExpected.substring(0, cleanExpected.length - 1))) {
              return false; 
            }
            
            // Проверка на составные слова: если expected является частью found после нормализации
            // Например: "rehabilitation" в "expansion rehabilitation" или "expansion/rehabilitation"
            const foundWords = cleanFound.split(/\s+/);
            if (foundWords.some(word => word === cleanExpected || cleanExpected.includes(word) || word.includes(cleanExpected))) {
              return false;
            }
          }
          return true;
        })
        .filter((item: any) => {
          // Ensure required fields are present and not empty
          return item.term && typeof item.term === 'string' && item.term.trim() !== '' &&
                 item.expected && typeof item.expected === 'string' && item.expected.trim() !== '' &&
                 item.found && typeof item.found === 'string' && item.found.trim() !== '';
        })
        .map((item: any) => ({
          term: String(item.term || '').trim(),
          expected: String(item.expected || '').trim(),
          found: String(item.found || '').trim(),
          severity: item.status === 'missing' ? 'warning' : 'error',
          reasoning: item.reasoning || ''
        }));
      
      if (!reasoning) reasoning = `Analyzed ${parsed.length} terms. Found ${errors.length} issues.`;

    } catch (e) {
      logger.error({ error: e, text: text.substring(0, 500) }, 'Critic Parsing Error');
      reasoning = "Parsing Error - Manual Review Recommended.";
      errors = [];
    }

    return { errors, reasoning, usage: response.usage };
  }

  /**
   * Вспомогательная функция для парсинга ответа критика
   */
  private parseCriticResponse(text: string): { parsed: any[]; reasoning: string; jsonStr: string } {
    let cleanedText = text.trim();
    let reasoning = '';
    let jsonStr = '';
    
    // Удаляем markdown code blocks если есть
    if (cleanedText.startsWith('```')) {
      const lines = cleanedText.split('\n');
      if (lines[0].match(/^```(json)?$/i)) lines.shift();
      if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop();
      cleanedText = lines.join('\n').trim();
    }
    
    // Находим JSON массив
    const jsonMatch = cleanedText.match(/\[\s*\{/);
    const jsonEnd = cleanedText.lastIndexOf(']');
    
    if (jsonMatch && jsonMatch.index !== undefined && jsonEnd > jsonMatch.index) {
      jsonStr = cleanedText.slice(jsonMatch.index, jsonEnd + 1);
      reasoning = cleanedText.slice(0, jsonMatch.index).trim();
      
      // Очистка JSON от потенциальных проблем
      let cleanedJson = jsonStr
        .replace(/\/\/.*$/gm, '')  // Удаляем однострочные комментарии
        .replace(/\/\*[\s\S]*?\*\//g, '')  // Удаляем многострочные комментарии
        .replace(/,(\s*[}\]])/g, '$1');  // Удаляем trailing commas
      
      try {
        const parsed = JSON.parse(cleanedJson);
        if (!Array.isArray(parsed)) {
          throw new Error('Parsed JSON is not an array');
        }
        return { parsed, reasoning, jsonStr: cleanedJson };
      } catch (parseErr) {
        logger.warn({ 
          originalJson: jsonStr.substring(0, 200),
          cleanedJson: cleanedJson.substring(0, 200),
          error: parseErr 
        }, 'Critic JSON Parse Error - attempting repair');
        
        // Попытка извлечь массив вручную (fallback)
        const arrayMatch = cleanedJson.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          try {
            const parsed = JSON.parse(arrayMatch[0]);
            return { parsed: Array.isArray(parsed) ? parsed : [], reasoning, jsonStr: arrayMatch[0] };
          } catch (e2) {
            throw parseErr;
          }
        }
        throw parseErr;
      }
    } else {
      // Если не нашли JSON массив, проверяем на пустой массив
      if (cleanedText.includes('[]') || cleanedText.trim() === '[]') {
        return { parsed: [], reasoning: 'No glossary errors found.', jsonStr: '[]' };
      }
      throw new Error('Could not identify JSON array in Critic response');
    }
  }

  /**
   * Step 3: Fix Translation (The Editor)
   */
  async fixTranslation(
    sourceText: string,
    draftText: string,
    errors: Array<{ term: string; expected: string; found: string; severity: string }>,
    options: { provider?: string; model?: string; apiKey?: string; yandexFolderId?: string; temperature?: number; maxTokens?: number; glossary?: OrchestratorGlossaryEntry[]; sourceLocale?: string; targetLocale?: string },
  ): Promise<{ finalText: string; usage?: ProviderUsage }> {
    // Validate errors array
    if (!errors || errors.length === 0) {
      logger.warn('fixTranslation called with empty errors array, returning draft as-is');
      return { finalText: draftText };
    }
    
    // Filter out invalid errors
    const validErrors = errors.filter(e => 
      e.term && e.term.trim() !== '' &&
      e.expected && e.expected.trim() !== '' &&
      e.found && e.found.trim() !== ''
    );
    
    if (validErrors.length === 0) {
      logger.warn('fixTranslation: All errors were invalid, returning draft as-is');
      return { finalText: draftText };
    }
    
    logger.debug({
      totalErrors: errors.length,
      validErrors: validErrors.length,
      errors: validErrors.map(e => ({ term: e.term, expected: e.expected, found: e.found })),
    }, 'fixTranslation: Starting to fix errors');
    
    const provider = getProvider(options.provider, options.apiKey, options.yandexFolderId);
    const model = options.model ?? provider.defaultModel;
    
    // Get language information
    const sourceLocale = options.sourceLocale ?? 'ru';
    const targetLocale = options.targetLocale ?? 'en';
    const sourceLang = getLanguageName(sourceLocale);
    const targetLang = getLanguageName(targetLocale);
    
    // Build specific prompt to fix ONLY the errors
    const errorList = validErrors.map((e) => `- Term "${e.term}": Change "${e.found}" to "${e.expected}"`).join('\n');
    const glossaryText = this.buildGlossarySection(options.glossary);
    
    const prompt = [
      'You are a Senior Editor. Fix the following specific errors in the translation.',
      '',
      '=== TRANSLATION DIRECTION (CRITICAL - READ CAREFULLY) ===',
      `Source language: ${sourceLang} (${sourceLocale}) - This is the ORIGINAL language`,
      `Target language: ${targetLang} (${targetLocale}) - This is the TRANSLATION language`,
      `Translation direction: ${sourceLang} → ${targetLang}`,
      '',
      'CRITICAL RULES:',
      `1. The SOURCE text below is written in ${sourceLang} (original language)`,
      `2. The DRAFT text below is a translation into ${targetLang} (target language)`,
      `3. Your output MUST be in ${targetLang} (target language) ONLY`,
      `4. DO NOT return text in ${sourceLang} - ONLY ${targetLang} is allowed`,
      `5. The corrected translation MUST be written in ${targetLang}, NOT in ${sourceLang}.`,
      '',
      '=== SOURCE TEXT (Original) ===',
      `Language: ${sourceLang}`,
      sourceText,
      '',
      '=== DRAFT TRANSLATION (Current) ===',
      `Language: ${targetLang} (but may contain errors)`,
      draftText,
      '',
      '=== GLOSSARY REFERENCE ===',
      glossaryText,
      '',
      '=== ERRORS TO FIX ===',
      errorList,
      '',
      '=== INSTRUCTION ===',
      `Return ONLY the corrected translation in ${targetLang} as a raw text string.`,
      'IMPORTANT:',
      `- The output MUST be in ${targetLang} language`,
      `- Do NOT return text in ${sourceLang} language`,
      '- Do NOT wrap the response in JSON',
      '- Do NOT return an array or object',
      '- Do NOT add quotes around the text',
      '- Return ONLY the translation text itself',
      '- Do not add explanations or comments',
      '- Preserve all tags and formatting exactly',
      '',
      'Example of CORRECT output:',
      'The corrected translation text here',
      '',
      'Example of INCORRECT output (DO NOT DO THIS):',
      '[{"target_mt": "text"}]',
      '{"target_mt": "text"}',
      '"text"',
    ].join('\n');

    // Editor/Fix prompts can be long (source text + draft + glossary + error list)
    // Use higher maxTokens to ensure complete responses
    const editorMaxTokens = options.maxTokens ? Math.max(options.maxTokens, 2048) : 2048;
    
    logger.debug({
      promptLength: prompt.length,
      maxTokens: editorMaxTokens,
      errorsCount: validErrors.length,
    }, 'fixTranslation: Calling AI with increased maxTokens');
    
    try {
      const response = await provider.callModel({
        prompt,
        model,
        temperature: options.temperature ?? 0.2,
        maxTokens: editorMaxTokens,
        segments: [{ segmentId: 'fix', sourceText }],
      });

      if (!response || !response.outputText) {
        logger.error('fixTranslation: AI returned empty response');
        throw new Error('AI returned empty response');
      }

      logger.debug({
        responseLength: response.outputText.length,
        responsePreview: response.outputText.substring(0, 200),
      }, 'fixTranslation: Received AI response');

      // Parse response - AI might return JSON array or plain string
      let final = response.outputText.trim();
      
      if (!final || final.length === 0) {
        logger.warn('fixTranslation: Response is empty after trim, returning draft');
        return { finalText: draftText, usage: response.usage };
      }
      
      // Try to parse as JSON array (AI sometimes returns this format)
      try {
        const jsonStart = final.indexOf('[');
        const jsonEnd = final.lastIndexOf(']');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          const jsonStr = final.slice(jsonStart, jsonEnd + 1);
          const parsed = JSON.parse(jsonStr);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const firstItem = parsed[0];
            if (firstItem && typeof firstItem === 'object' && 'target_mt' in firstItem) {
              final = String(firstItem.target_mt);
            } else if (typeof firstItem === 'string') {
              final = firstItem;
            }
          }
        } else {
          // Try parsing entire response as JSON object
          const parsed = JSON.parse(final);
          if (typeof parsed === 'object' && parsed !== null) {
            if ('target_mt' in parsed && typeof parsed.target_mt === 'string') {
              final = parsed.target_mt;
            } else if ('finalText' in parsed && typeof parsed.finalText === 'string') {
              final = parsed.finalText;
            } else if ('text' in parsed && typeof parsed.text === 'string') {
              final = parsed.text;
            }
          }
        }
      } catch (e) {
        // Not JSON, continue with string processing
        logger.debug('fixTranslation: Response is not JSON, treating as plain text');
      }
      
      // Clean up (sometimes AI adds quotes around the whole string)
      if (final.startsWith('"') && final.endsWith('"')) {
        final = final.slice(1, -1);
      }
      
      // Remove markdown code blocks if present
      if (final.startsWith('```')) {
        const lines = final.split('\n');
        if (lines[0].match(/^```/)) lines.shift();
        if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop();
        final = lines.join('\n').trim();
      }
      
      // Remove mock/synthetic translation markers (e.g., "[gemini synthetic translation]", "[openai synthetic translation]")
      // These are added by the mock response when API keys are missing
      final = final.replace(/\s*\[(?:gemini|openai|yandex|gpt|ai)\s+synthetic\s+translation\]\s*/gi, '').trim();
      
      // Also remove any other common mock markers
      final = final.replace(/\s*\[mock\s+translation\]\s*/gi, '').trim();
      final = final.replace(/\s*\[synthetic\]\s*/gi, '').trim();
      
      // Remove trailing brackets that might be left over
      final = final.replace(/\s*\[\s*\]\s*$/, '').trim();

      if (!final || final.length === 0) {
        logger.warn('fixTranslation: Final text is empty after processing, returning draft');
        return { finalText: draftText, usage: response.usage };
      }

      logger.debug({
        finalLength: final.length,
        finalPreview: final.substring(0, 100),
        hadMockMarker: response.outputText.includes('synthetic translation'),
      }, 'fixTranslation: Successfully fixed translation');

      return { finalText: final, usage: response.usage };
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorsCount: validErrors.length,
      }, 'fixTranslation: Failed to fix translation');
      
      // Return draft as fallback instead of throwing
      logger.warn('fixTranslation: Returning draft as fallback due to error');
      return { finalText: draftText };
    }
  }

  /**
   * Auto-Mode: Runs the full Draft -> Critic -> Fix loop internally.
   */
  async translateWithCritic(
    segment: OrchestratorSegment,
    options: Omit<TranslateSegmentsOptions, 'segments'>,
    onProgress?: (stage: 'draft' | 'critic' | 'editor' | 'complete', message?: string) => void,
  ): Promise<OrchestratorResult> {
    const provider = getProvider(options.provider, options.apiKey, options.yandexFolderId);
    
    // 1. Draft
    onProgress?.('draft', 'Generating draft translation...');
    const draft = await this.generateDraft(segment.sourceText, options);
    
    // 2. Critic
    onProgress?.('critic', 'Running critique analysis...');
    // Use much higher maxTokens for critic (prompts are very long, responses can be long too)
    // Gemini API supports up to 8192 output tokens
    const criticMaxTokens = options.maxTokens ? Math.max(options.maxTokens, 8192) : 8192;
    const critique = await this.runCritique(
        segment.sourceText, 
        draft.draftText, 
        options.glossary, 
        { 
          provider: options.provider, 
          model: options.model, 
          apiKey: options.apiKey,
          yandexFolderId: options.yandexFolderId,
          sourceLocale: options.sourceLocale,
          targetLocale: options.targetLocale,
          maxTokens: criticMaxTokens,
        }
    );

    // 3. Fix (if needed)
    if (critique.errors.length > 0) {
        onProgress?.('editor', `Fixing ${critique.errors.length} error(s)...`);
        const fixed = await this.fixTranslation(
            segment.sourceText, 
            draft.draftText, 
            critique.errors, 
            { 
                provider: options.provider,
                model: options.model,
                apiKey: options.apiKey,
                yandexFolderId: options.yandexFolderId,
                temperature: options.temperature,
                maxTokens: options.maxTokens,
                glossary: options.glossary,
                sourceLocale: options.sourceLocale,
                targetLocale: options.targetLocale,
            }
        );
        
        onProgress?.('complete', 'Translation completed');
        return { 
            segmentId: segment.segmentId, 
            targetText: fixed.finalText, 
            provider: provider.name, 
            model: options.model || provider.defaultModel, 
            confidence: 0.95,
            usage: fixed.usage
        };
    }

    onProgress?.('complete', 'Translation completed - no errors found');
    return { 
        segmentId: segment.segmentId, 
        targetText: draft.draftText, 
        provider: provider.name, 
        model: options.model || provider.defaultModel, 
        confidence: 0.9,
        usage: draft.usage
    };
  }
}