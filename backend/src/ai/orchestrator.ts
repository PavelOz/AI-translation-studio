import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
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

  /**
   * Convert formatting tags {{n}} to XML format <t i="n"> for AI-friendly processing
   * Example: {{12}}word{{/12}} -> <t i="12">word</t>
   */
  private convertTagsToXml(text: string): string {
    if (!text) return text;
    return text
      .replace(/\{\{(\d+)\}\}/g, '<t i="$1">')
      .replace(/\{\{\/(\d+)\}\}/g, '</t>');
  }

  /**
   * Convert XML format <t i="n"> back to formatting tags {{n}}
   * Example: <t i="12">word</t> -> {{12}}word{{/12}}
   */
  private convertXmlToTags(text: string): string {
    if (!text) return text;
    
    // Process the string to match opening and closing tags in order
    const tagStack: number[] = [];
    let result = '';
    let i = 0;
    
    while (i < text.length) {
      // Check for opening tag: <t i="n"> or <t i='n'> (handle both single and double quotes)
      const openTagMatch = text.substring(i).match(/^<t i=["'](\d+)["']>/);
      if (openTagMatch) {
        const tagId = parseInt(openTagMatch[1], 10);
        tagStack.push(tagId);
        result += `{{${tagId}}}`;
        i += openTagMatch[0].length;
        continue;
      }
      
      // Check for closing tag: </t>
      const closeTagMatch = text.substring(i).match(/^<\/t>/);
      if (closeTagMatch) {
        const tagId = tagStack.pop();
        if (tagId !== undefined) {
          result += `{{/${tagId}}}`;
        } else {
          result += '{{/0}}'; // Fallback if stack is empty
        }
        i += closeTagMatch[0].length;
        continue;
      }
      
      // Regular character
      result += text[i];
      i++;
    }
    
    return result;
  }

  /**
   * Estimate token count for a given text using simple heuristic
   * Approximation: ~4 characters per token
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Plan token-based batches to prevent token limit exceeded errors
   * Returns array of batch ranges {start, end} where end is exclusive
   */
  private planBatches(segments: OrchestratorSegment[], maxInputTokens: number = 3000): Array<{start: number, end: number}> {
    const batches: Array<{start: number, end: number}> = [];
    let currentStart = 0;
    let currentTokens = 0;
    // Fixed overhead buffer (System prompt + Guidelines ~ 800 tokens)
    const PROMPT_OVERHEAD = 800; 

    for (let i = 0; i < segments.length; i++) {
      const segTokens = this.estimateTokens(segments[i].sourceText) + 100; // +100 for JSON overhead
      
      // If this single segment exceeds limit, create a batch with just this segment
      if (segTokens + PROMPT_OVERHEAD > maxInputTokens) {
        // If we have accumulated segments, save them first
        if (i > currentStart) {
          batches.push({ start: currentStart, end: i });
        }
        // Create a batch with just this oversized segment
        batches.push({ start: i, end: i + 1 });
        currentStart = i + 1;
        currentTokens = 0;
        continue;
      }
      
      // If adding this segment exceeds limit AND we have at least one segment in batch
      if (currentTokens + segTokens + PROMPT_OVERHEAD > maxInputTokens && i > currentStart) {
        batches.push({ start: currentStart, end: i });
        currentStart = i;
        currentTokens = 0;
      }
      currentTokens += segTokens;
    }
    // Add final batch
    if (currentStart < segments.length) {
      batches.push({ start: currentStart, end: segments.length });
    }
    return batches;
  }

  /**
   * Filter guidelines/style rules to prevent "Runglish" formatting issues
   * When translating to English, removes formatting rules (date, number, punctuation, etc.)
   * but keeps semantic rules (tone, terminology, style)
   */
  private filterGuidelinesForTranslation(
    styleRules: Array<{ ruleType: string; pattern: string; description: string | null; examples: any; force?: boolean }>,
    targetLang: string
  ): Array<{ ruleType: string; pattern: string; description: string | null; examples: any; force?: boolean }> {
    // If target language is NOT English, return rules as-is
    if (!targetLang.toLowerCase().startsWith('en')) {
      return styleRules;
    }

    // For English: Filter out formatting rules, keep semantic rules
    const formattingRuleTypes = ['date_format', 'number_format', 'punctuation', 'spacing', 'list_style', 'capitalization'];
    const semanticRuleTypes = ['tone', 'terminology', 'gender_neutrality', 'style'];

    return styleRules.filter((rule) => {
      // Exception: If rule has force: true, always keep it
      if (rule.force === true) {
        return true;
      }

      // Keep semantic rules
      if (semanticRuleTypes.includes(rule.ruleType)) {
        return true;
      }

      // Filter out formatting rules
      if (formattingRuleTypes.includes(rule.ruleType)) {
        return false;
      }

      // For unknown rule types, keep them (safe default)
      return true;
    });
  }

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

  private buildDocumentGlossarySection(documentGlossary?: Array<{ sourceTerm: string; targetTerm: string; status: string; occurrenceCount: number }>) {
    if (!documentGlossary || documentGlossary.length === 0) {
      return '';
    }
    
    // Format document-specific glossary terms
    const formattedTerms = documentGlossary
      .map((entry) => {
        const statusLabel = entry.status === 'PREFERRED' ? '[APPROVED]' : entry.status === 'CANDIDATE' ? '[CANDIDATE]' : '';
        return `- ${entry.sourceTerm} => ${entry.targetTerm} ${statusLabel} (appears ${entry.occurrenceCount}x)`;
      })
      .join('\n');
    
    return formattedTerms;
  }

  private buildDocumentStyleRulesSection(styleRules?: Array<{ ruleType: string; pattern: string; description: string | null; examples: any }>) {
    if (!styleRules || styleRules.length === 0) {
      return '';
    }
    
    const formattedRules = styleRules.map((rule) => {
      const examplesText = rule.examples 
        ? (Array.isArray(rule.examples) ? rule.examples.join(', ') : JSON.stringify(rule.examples))
        : '';
      
      return [
        `Rule Type: ${rule.ruleType}`,
        `Pattern: ${rule.pattern}`,
        rule.description ? `Description: ${rule.description}` : '',
        examplesText ? `Examples: ${examplesText}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');
    
    return formattedRules;
  }

  /**
   * Format combined glossary terms for the new hierarchical prompt structure
   * Combines document-specific glossary and project-level glossary
   */
  private formatGlossaryTermsForHierarchy(
    documentGlossary?: Array<{ sourceTerm: string; targetTerm: string; status: string; occurrenceCount: number }>,
    projectGlossary?: OrchestratorGlossaryEntry[]
  ): string {
    const parts: string[] = [];
    
    // Document-specific glossary (highest priority)
    if (documentGlossary && documentGlossary.length > 0) {
      documentGlossary.forEach((entry) => {
        const statusLabel = entry.status === 'PREFERRED' ? '[APPROVED]' : entry.status === 'CANDIDATE' ? '[CANDIDATE]' : '';
        parts.push(`- ${entry.sourceTerm} => ${entry.targetTerm} ${statusLabel} (appears ${entry.occurrenceCount}x)`);
      });
    }
    
    // Project-level glossary
    if (projectGlossary && projectGlossary.length > 0) {
      projectGlossary.slice(0, 200).forEach((entry) => {
        const forbiddenLabel = entry.forbidden ? ' (FORBIDDEN TERM: do not translate differently)' : '';
        const notesLabel = entry.notes ? ` | Notes: ${entry.notes}` : '';
        parts.push(`- ${entry.term} => ${entry.translation}${forbiddenLabel}${notesLabel}`);
      });
    }
    
    if (parts.length === 0) {
      return 'No glossary terms provided.';
    }
    
    return parts.join('\n');
  }

  /**
   * Format style rules for the new hierarchical prompt structure
   */
  private formatStyleRulesForHierarchy(
    styleRules?: Array<{ ruleType: string; pattern: string; description: string | null; examples: any }>
  ): string {
    if (!styleRules || styleRules.length === 0) {
      return 'No specific style rules provided. Follow standard professional translation practices.';
    }
    
    const formattedRules = styleRules.map((rule) => {
      const examplesText = rule.examples 
        ? (Array.isArray(rule.examples) ? rule.examples.join(', ') : JSON.stringify(rule.examples))
        : '';
      
      return [
        `Rule Type: ${rule.ruleType}`,
        `Pattern: ${rule.pattern}`,
        rule.description ? `Description: ${rule.description}` : '',
        examplesText ? `Examples: ${examplesText}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');
    
    return formattedRules;
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

  private buildBatchPrompt(
    batch: OrchestratorSegment[], 
    options: TranslateSegmentsOptions,
    prevContext?: string | null,
    nextContext?: string | null
  ): string {
    const project = options.project ?? {};
    const guidelineText = this.buildGuidelineSection(options.guidelines);
    const examplesText = this.buildTranslationExamplesSection(options.tmExamples);
    
    // Format combined glossary and style rules for new hierarchical structure
    const formattedGlossaryTerms = this.formatGlossaryTermsForHierarchy(
      options.documentGlossary,
      options.glossary
    );
    
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
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orchestrator.ts:212',message:'buildBatchPrompt: Locale codes determined',data:{optionsSourceLocale:options.sourceLocale,optionsTargetLocale:options.targetLocale,projectSourceLang:project.sourceLang,projectTargetLang:project.targetLang,sourceLangCode,targetLangCode},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    const sourceLang = getLanguageName(sourceLangCode);
    const targetLang = getLanguageName(targetLangCode);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orchestrator.ts:215',message:'buildBatchPrompt: Language names determined',data:{sourceLangCode,sourceLang,targetLangCode,targetLang},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    // Detect if target is UK English for natural language instructions
    const isUKEnglish = targetLangCode.toLowerCase() === 'en-gb' || targetLangCode.toLowerCase() === 'en_gb';
    const isUSEnglish = targetLangCode.toLowerCase() === 'en-us' || targetLangCode.toLowerCase() === 'en_us';
    const isEnglish = targetLangCode.toLowerCase().startsWith('en');

    // Smart Guidelines Filtering: Filter out formatting rules when translating to English
    // This prevents "Runglish" issues (e.g., "Dates are formatted with dots" when target is English)
    const filteredStyleRules = options.documentStyleRules 
      ? this.filterGuidelinesForTranslation(options.documentStyleRules, targetLangCode)
      : undefined;
    
    // Log filtering decision for debugging
    if (options.documentStyleRules && options.documentStyleRules.length > 0) {
      const filteredCount = filteredStyleRules?.length || 0;
      const originalCount = options.documentStyleRules.length;
      const removedCount = originalCount - filteredCount;
      console.log('Guidelines filtering:', {
        targetLang: targetLangCode,
        originalCount,
        filteredCount,
        removedCount,
        isEnglish: isEnglish
      });
    }

    // Check if address formatting rules exist for this language pair
    const hasAddressRules = hasAddressFormattingRule(sourceLangCode, targetLangCode);
    
    // Smart Injection: Detect if batch contains addresses before including address rules
    // Keywords detecting generic address components (RU/EN/KZ context)
    const addressKeywords = /адрес|address|ул\.|st\.|street|просп|пр\.|ave\.|avenue|мкр\.|microdistrict|бц|офис|office|бин|bin|дом\s+\d|house\s+\d|расположен|located|находится|по\s+адресу/i;
    
    // Check if ANY segment in the batch contains address keywords
    const containsAddress = batch.some(seg => addressKeywords.test(seg.sourceText));
    
    // Log the decision for debugging
    console.log('Address rules injection:', { 
      hasRules: hasAddressRules, 
      detected: containsAddress,
      willInject: hasAddressRules && containsAddress,
      batchSize: batch.length
    });
    
    // Build natural language quality instructions
    const naturalLanguageInstructions = this.buildNaturalLanguageInstructions(
      isUKEnglish,
      isUSEnglish,
      isEnglish,
      targetLangCode,
      hasAddressRules && containsAddress, // Only inject if rules exist AND addresses detected
      sourceLangCode,
      targetLangCode
    );

    const document = options.document ?? {};
    
    // Build document context string for System Persona (Top Priority)
    // This ensures the AI understands the document genre and context before translating
    const docContext = document ? [
      document.name ? `DOCUMENT NAME: "${document.name}"` : '',
      document.summary ? `DOCUMENT CONTEXT: ${document.summary}` : '',
      document.clusterSummary ? `SECTION CONTEXT: ${document.clusterSummary}` : ''
    ].filter(Boolean).join('\n') : '';

    // Format style rules using filtered rules (prevents Runglish formatting issues)
    const formattedStyleRules = this.formatStyleRulesForHierarchy(filteredStyleRules);

    // NEW HIERARCHICAL PROMPT STRUCTURE with Context Anchors
    // Ordering follows "Static-First" rule for KV-Caching efficiency:
    // 1. System Persona (Static)
    // 2. Glossary & Style Rules (Semi-Static)
    // 3. TM Examples (Dynamic Context)
    // 4. Source Segments (Highly Dynamic)
    return [
      // 1. SYSTEM PERSONA WITH CONTEXT (Top Priority - AI sees this first)
      `You are a professional technical translator specializing in ${sourceLangCode} to ${targetLangCode}.`,
      docContext ? `\n=== GLOBAL DOCUMENT CONTEXT (CRITICAL) ===\n${docContext}\n` : '',
      `Your goal is to produce a translation that flows naturally in the target language while preserving the original technical meaning.`,
      '',
      '### 👑 CONTEXT HIERARCHY & PRIORITIES:',
      '1. **TERMINOLOGY (NON-NEGOTIABLE):** Strict adherence to the Glossary below is mandatory.',
      '2. **CONSISTENCY (CRITICAL):** Use the provided "Translation Memory Examples" to match the tone and style of previous work.',
      '3. **FLUENCY (HIGH):** If no Glossary/TM match exists, prioritize a natural, native-level reading experience over literal word-for-word translation.',
      '',
      '### 📖 CRITICAL GLOSSARY:',
      formattedGlossaryTerms || '(No specific glossary terms for this segment)',
      '',
      '### ✍️ STYLE & GRAMMAR INSTRUCTIONS:',
      naturalLanguageInstructions,
      formattedStyleRules,
      '',
      '### 🧠 TRANSLATION MEMORY (REFERENCE):',
      'Use these similar past translations to guide your style and terminology:',
      examplesText || '(No similar past translations found for this segment)',
      '',
      '=== FORMATTING PRESERVATION ===',
      'The source text may contain XML formatting tags like <t i="1">word</t>.',
      'CRITICAL: Preserve these XML tags in your translation output. Place them around the corresponding translated words.',
      'Example:',
      '  Source: <t i="1">Hello</t> world',
      '  Output: <t i="1">Привет</t> мир',
      '',
      '=== OUTPUT FORMAT ===',
      'Return ONLY valid JSON array matching this schema:',
      `[{"segment_id":"<id>","target_mt":"<translation>"}]`,
      '',
      // Previous context (if provided)
      ...(prevContext ? [
        '=== PREVIOUS CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===',
        prevContext,
        ''
      ] : []),
      '=== SOURCE SEGMENTS TO TRANSLATE ===',
      ...batch.map((segment) => {
        // Convert formatting tags to XML for AI-friendly processing
        const sourceTextXml = this.convertTagsToXml(segment.sourceText);
        // #region agent log
        // Simple heuristic: check if text contains Cyrillic characters (Russian/Kazakh/etc)
        const hasCyrillic = /[а-яёА-ЯЁҚқҒғҢңҰұҮүӘәІіӨөҺһ]/.test(segment.sourceText);
        const hasLatin = /[a-zA-Z]/.test(segment.sourceText);
        const appearsRussian = hasCyrillic && !hasLatin;
        const appearsEnglish = hasLatin && !hasCyrillic;
        const configuredSourceIsRussian = ['ru', 'kk', 'uk', 'be', 'ky', 'uz', 'tg', 'tk', 'mn'].includes(sourceLangCode.toLowerCase());
        const configuredSourceIsEnglish = sourceLangCode.toLowerCase().startsWith('en');
        const possibleMismatch = (appearsRussian && configuredSourceIsEnglish) || (appearsEnglish && configuredSourceIsRussian);
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orchestrator.ts:317',message:'buildBatchPrompt: Source text language detection',data:{segmentId:segment.segmentId,sourceTextPreview:segment.sourceText.substring(0,100),hasCyrillic,hasLatin,appearsRussian,appearsEnglish,configuredSourceLocale:sourceLangCode,configuredSourceIsRussian,configuredSourceIsEnglish,possibleMismatch},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        return [
          `ID: ${segment.segmentId}`,
          `Source: ${sourceTextXml}`,
          '---'
        ];
      }),
      // Next context (if provided)
      ...(nextContext ? [
        '',
        '=== NEXT CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===',
        nextContext
      ] : []),
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
    shouldIncludeAddressRules: boolean = false, // True only if rules exist AND addresses detected in batch
    sourceLocale: string = '',
    targetLocale: string = ''
  ): string {
    // Build address standardization section dynamically based on language pair
    // Smart Injection: Only include if addresses were detected in the batch
    const addressStandardizationSection = shouldIncludeAddressRules 
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
        
        // Convert XML tags back to formatting tags
        targetText = this.convertXmlToTags(targetText);
        
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
    const retries = options.retries ?? env.aiMaxRetries ?? 3;
    const results: OrchestratorResult[] = [];

    // Extract language codes and names for translation direction
    const project = options.project ?? {};
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orchestrator.ts:649',message:'translateSegments: Input locale values',data:{optionsSourceLocale:options.sourceLocale,optionsTargetLocale:options.targetLocale,projectSourceLang:project.sourceLang,projectTargetLang:project.targetLang},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    const sourceLangCode = options.sourceLocale ?? project.sourceLang ?? 'ru';
    const targetLangCode = options.targetLocale ?? project.targetLang ?? 'en';
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orchestrator.ts:652',message:'translateSegments: Final locale codes after fallback',data:{sourceLangCode,targetLangCode,usedOptionsSource:!!options.sourceLocale,usedProjectSource:!options.sourceLocale&&!!project.sourceLang,usedDefaultSource:!options.sourceLocale&&!project.sourceLang,usedOptionsTarget:!!options.targetLocale,usedProjectTarget:!options.targetLocale&&!!project.targetLang,usedDefaultTarget:!options.targetLocale&&!project.targetLang},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    const sourceLang = getLanguageName(sourceLangCode);
    const targetLang = getLanguageName(targetLangCode);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orchestrator.ts:655',message:'translateSegments: Language names from getLanguageName',data:{sourceLangCode,sourceLang,targetLangCode,targetLang},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion

    // Plan token-based batches to prevent token limit exceeded errors
    const batchRanges = this.planBatches(options.segments, 4000); // 4k token safety limit
    
    // Process each batch
    for (const range of batchRanges) {
      const batchSegments = options.segments.slice(range.start, range.end);
      const chunkId = randomUUID();
      
      // Get neighboring segments for context
      // prevSegment: segment before this batch (range.start - 1)
      // nextSegment: segment after this batch (range.end, since slice is exclusive)
      const prevSegment = range.start > 0 ? options.segments[range.start - 1] : null;
      const nextSegment = range.end < options.segments.length ? options.segments[range.end] : null;
      
      // Extract and truncate context strings
      let prevContextString: string | null = null;
      if (prevSegment) {
        const prevText = prevSegment.sourceText;
        if (prevText.length > 1000) {
          prevContextString = '[...]' + prevText.slice(-1000);
        } else {
          prevContextString = prevText;
        }
        // Convert tags to XML for format consistency
        prevContextString = this.convertTagsToXml(prevContextString);
      } else if (batchSegments.length > 0 && batchSegments[0].previousText) {
        // Fallback: Use segment's previousText property when array neighbor is unavailable
        const prevText = batchSegments[0].previousText;
        if (prevText.length > 1000) {
          prevContextString = '[...]' + prevText.slice(-1000);
        } else {
          prevContextString = prevText;
        }
        // Convert tags to XML for format consistency
        prevContextString = this.convertTagsToXml(prevContextString);
      }
      
      let nextContextString: string | null = null;
      if (nextSegment) {
        const nextText = nextSegment.sourceText;
        if (nextText.length > 1000) {
          nextContextString = nextText.slice(0, 1000) + '[...]';
        } else {
          nextContextString = nextText;
        }
        // Convert tags to XML for format consistency
        nextContextString = this.convertTagsToXml(nextContextString);
      } else if (batchSegments.length > 0) {
        // Fallback: Use segment's nextText property when array neighbor is unavailable
        const lastSegment = batchSegments[batchSegments.length - 1];
        const nextText = lastSegment.nextText;
        if (nextText) {
          if (nextText.length > 1000) {
            nextContextString = nextText.slice(0, 1000) + '[...]';
          } else {
            nextContextString = nextText;
          }
          // Convert tags to XML for format consistency
          nextContextString = this.convertTagsToXml(nextContextString);
        }
      }
      let attempt = 0;
      let success = false;
      while (attempt < retries && !success) {
        try {
          const prompt = this.buildBatchPrompt(batchSegments, options, prevContextString, nextContextString);
          
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
          
          // Calculate dynamic maxTokens for batch if not explicitly set
          let maxTokens = options.maxTokens;
          if (!maxTokens || maxTokens < 2048) {
            // For batch, use the longest segment
            const longestSegment = batchSegments.reduce((longest, seg) => 
              seg.sourceText.length > longest.sourceText.length ? seg : longest,
              batchSegments[0]
            );
            const sourceTextLength = longestSegment.sourceText.length;
            const estimatedInputTokens = Math.ceil(sourceTextLength / 4);
            const calculatedMaxTokens = Math.max(
              Math.ceil(estimatedInputTokens * 2.5) + 1000,
              2048 // Minimum 2048
            );
            maxTokens = Math.min(calculatedMaxTokens, 8192);
            logger.debug({
              batchSize: batchSegments.length,
              longestSegmentLength: sourceTextLength,
              estimatedInputTokens,
              calculatedMaxTokens,
              finalMaxTokens: maxTokens,
            }, 'translateSegments: Calculated dynamic maxTokens for batch');
          }
          
          // Build system persona for explicit injection with clear translation direction
          const systemPersona = `You are an expert linguist. TRANSLATION DIRECTION: ${sourceLangCode} → ${targetLangCode}. You translate FROM ${sourceLangCode} (${sourceLang}, source/input) TO ${targetLangCode} (${targetLang}, target/output). CRITICAL: Your output MUST be in ${targetLangCode} only. Never return text in ${sourceLangCode}. If you see text in ${sourceLangCode}, translate it to ${targetLangCode}. If you see text in ${targetLangCode}, keep it as-is. Your translations must be accurate, natural, and idiomatic. Avoid literal calques and word-for-word translations. Prioritize meaning and fluency while maintaining technical precision.`;
          
          // Debug: Write raw prompt with XML tags to file for inspection
          try {
            // Use workspace root (.cursor) instead of backend/.cursor
            // process.cwd() returns backend directory, so go up one level
            const debugDir = resolve(process.cwd(), '..', '.cursor');
            await fs.mkdir(debugDir, { recursive: true });
            const timestamp = Date.now();
            const debugFilePath = join(debugDir, `debug-xml-prompt-${timestamp}.log`);
            await fs.writeFile(debugFilePath, prompt, 'utf-8');
            logger.info({ 
              debugFilePath, 
              promptLength: prompt.length,
              hasXmlTags: prompt.includes('<t i='),
              timestamp 
            }, 'DEBUG: Wrote raw prompt with XML tags to file');
            console.log(`[DEBUG] XML Prompt written to: ${debugFilePath}`);
          } catch (debugError) {
            const errorMessage = debugError instanceof Error ? debugError.message : String(debugError);
            const errorStack = debugError instanceof Error ? debugError.stack : undefined;
            logger.error({ error: errorMessage, stack: errorStack }, 'Failed to write debug prompt file');
            console.error(`[DEBUG ERROR] Failed to write XML prompt file:`, errorMessage);
          }
          
          const response = await provider.callModel({
            prompt,
            model,
            temperature: options.temperature ?? 0.4, // Increased from 0.2 to 0.4 for better fluency
            maxTokens,
            systemPrompt: systemPersona, // Explicit system prompt injection
            segments: batchSegments.map((segment) => ({ segmentId: segment.segmentId, sourceText: segment.sourceText })),
          });
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orchestrator.ts:710',message:'translateSegments: Provider callModel completed',data:{providerName:provider.name,responseLength:response.outputText?.length||0,responsePreview:response.outputText?.substring(0,100)||'',hasSystemPrompt:!!systemPersona},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          
          // Log response for YandexGPT debugging
          if (provider.name === 'yandex') {
            logger.debug({
              provider: 'yandex',
              model,
              responseLength: response.outputText.length,
              responsePreview: response.outputText.substring(0, 300),
            }, 'YandexGPT translation response');
          }
          
          const parsed = this.parseProviderResponse(response.outputText, batchSegments);
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
          logger.info({ provider: provider.name, chunkId }, 'AI translation chunk completed');
          success = true;
        } catch (error) {
          attempt += 1;
          logger.warn({ provider: provider.name, chunkId, attempt, error: (error as Error).message }, 'AI translation chunk failed');
          if (attempt >= retries) {
            const fallback = this.ruleBasedBatch(batchSegments);
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
    // Calculate dynamic maxTokens for single segment if not explicitly set
    let maxTokens = options.maxTokens;
    if (!maxTokens || maxTokens < 2048) {
      const sourceTextLength = segment.sourceText.length;
      const estimatedInputTokens = Math.ceil(sourceTextLength / 4);
      const calculatedMaxTokens = Math.max(
        Math.ceil(estimatedInputTokens * 2.5) + 1000,
        2048 // Minimum 2048
      );
      maxTokens = Math.min(calculatedMaxTokens, 8192);
      logger.debug({
        sourceTextLength,
        estimatedInputTokens,
        calculatedMaxTokens,
        finalMaxTokens: maxTokens,
      }, 'translateSingleSegment: Calculated dynamic maxTokens');
    }
    
    const [result] = await this.translateSegments({
      ...options,
      maxTokens,
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
    context?: { previous?: string; next?: string },
  ): Promise<{ draftText: string; modelUsed: string; usage?: ProviderUsage }> {
    const provider = getProvider(options.provider, options.apiKey, options.yandexFolderId);
    const model = options.model ?? provider.defaultModel;

    // Calculate dynamic maxTokens for draft generation
    let maxTokens = options.maxTokens;
    if (!maxTokens || maxTokens < 2048) {
      const sourceTextLength = sourceText.length;
      const estimatedInputTokens = Math.ceil(sourceTextLength / 4);
      const calculatedMaxTokens = Math.max(
        Math.ceil(estimatedInputTokens * 2.5) + 1000,
        2048 // Minimum 2048
      );
      maxTokens = Math.min(calculatedMaxTokens, 8192);
      logger.debug({
        sourceTextLength,
        estimatedInputTokens,
        calculatedMaxTokens,
        finalMaxTokens: maxTokens,
      }, 'generateDraft: Calculated dynamic maxTokens');
    }

    logger.info({ sourceLength: sourceText.length, maxTokens }, 'Step 1: Generating Draft');

    const [result] = await this.translateSegments({
      ...options,
      maxTokens,
      segments: [{ 
        segmentId: 'draft', 
        sourceText,
        previousText: context?.previous ?? null,
        nextText: context?.next ?? null,
      }],
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
    modelUsed: string;
    usage?: ProviderUsage;
  }> {
    const provider = getProvider(options.provider, options.apiKey, options.yandexFolderId);
    let model = options.model ?? provider.defaultModel;
    
    logger.debug({
      providerName: provider.name,
      originalModel: model,
      optionsModel: options.model,
      defaultModel: provider.defaultModel,
    }, 'runCritique: Initial model selection');
    
    // For Gemini Flash models and gemini-pro, switch to gemini-2.5-pro for critic workflow
    // to avoid thoughtsTokenCount consuming all output tokens
    // Check for flash models (these use thoughts aggressively)
    const modelLower = (model || '').toLowerCase();
    const isFlashModel = modelLower.includes('flash');
    const isGeminiPro = modelLower === 'gemini-pro' || (modelLower.includes('gemini-pro') && !modelLower.includes('2.5-pro'));
    const isAlready25Pro = modelLower.includes('2.5-pro') && !isFlashModel;
    const hasThoughts = provider.name === 'gemini' && (isFlashModel || isGeminiPro) && !isAlready25Pro;
    
    if (provider.name === 'gemini' && (isFlashModel || isGeminiPro) && !isAlready25Pro) {
      // Use gemini-2.5-pro instead of gemini-1.5-pro because gemini-1.5-pro is not available
      // gemini-2.5-pro may use thoughts but less aggressively than gemini-2.5-flash
      const reason = isFlashModel 
        ? 'Gemini Flash models use thoughts which can consume all output tokens'
        : 'gemini-pro often falls back to gemini-2.5-flash which uses thoughts';
      logger.warn({
        originalModel: model,
        fallbackModel: 'gemini-2.5-pro',
        reason,
        modelLower,
        isFlashModel,
        isGeminiPro,
        isAlready25Pro,
        note: 'Using gemini-2.5-pro (gemini-1.5-pro not available)',
      }, 'Switching to gemini-2.5-pro for critic workflow (gemini-1.5-pro not available)');
      model = 'gemini-2.5-pro';
    } else {
      logger.debug({
        providerName: provider.name,
        model,
        modelLower,
        hasThoughts,
        reason: provider.name !== 'gemini' ? 'Not Gemini provider' : 'Model does not use thoughts',
      }, 'runCritique: No model switch needed');
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
      '=== FORMATTING PRESERVATION ===',
      'The source and draft texts may contain XML formatting tags like <t i="1">word</t>.',
      'These tags preserve formatting information. When checking glossary compliance, ignore these tags and focus on the actual text content.',
      '',
      '=== TEXTS TO CHECK ===',
      `Source (${sourceLang}): "${this.convertTagsToXml(sourceText)}"`,
      `Draft (${targetLang}): "${this.convertTagsToXml(draftText)}"`,
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
    
    // Build system persona for explicit injection with clear translation direction
    const sourceLangCode = sourceLocale || 'en';
    const targetLangCode = targetLocale || 'ru';
    const systemPersona = `You are a Senior QA Linguist. TRANSLATION DIRECTION: ${sourceLangCode} → ${targetLangCode}. You are checking a translation FROM ${sourceLangCode} (${sourceLang}, source/input) TO ${targetLangCode} (${targetLang}, target/output). CRITICAL: The Source text is in ${sourceLangCode} (${sourceLang}). The Draft text is a translation into ${targetLangCode} (${targetLang}). You must verify that the Draft uses the correct ${targetLangCode} terms from the glossary, not ${sourceLangCode} terms. Your analysis must be accurate and focused on glossary compliance and naturalness.`;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orchestrator.ts:1195',message:'runCritique: System persona constructed',data:{sourceLangCode,targetLangCode,sourceLang,targetLang,systemPersonaLength:systemPersona.length,systemPersonaPreview:systemPersona.substring(0,200),providerName:provider.name},timestamp:Date.now(),sessionId:'debug-session',runId:'post-fix',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    
    const response = await provider.callModel({
      prompt,
      model,
      temperature: 0.1, // Keep it cold and logical
      maxTokens: criticMaxTokens,
      systemPrompt: systemPersona, // Explicit system prompt injection
      segments: [{ segmentId: 'critique', sourceText }],
    });
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orchestrator.ts:1207',message:'runCritique: Provider callModel completed',data:{providerName:provider.name,responseLength:response.outputText?.length||0,hasSystemPrompt:!!systemPersona},timestamp:Date.now(),sessionId:'debug-session',runId:'post-fix',hypothesisId:'D'})}).catch(()=>{});
    // #endregion

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

    return { errors, reasoning, modelUsed: model, usage: response.usage };
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
  ): Promise<{ finalText: string; modelUsed: string; usage?: ProviderUsage }> {
    const provider = getProvider(options.provider, options.apiKey, options.yandexFolderId);
    const model = options.model ?? provider.defaultModel;
    
    // Validate errors array
    if (!errors || errors.length === 0) {
      logger.warn('fixTranslation called with empty errors array, returning draft as-is');
      return { finalText: draftText, modelUsed: model };
    }
    
    // Filter out invalid errors
    const validErrors = errors.filter(e => 
      e.term && e.term.trim() !== '' &&
      e.expected && e.expected.trim() !== '' &&
      e.found && e.found.trim() !== ''
    );
    
    if (validErrors.length === 0) {
      logger.warn('fixTranslation: All errors were invalid, returning draft as-is');
      return { finalText: draftText, modelUsed: model };
    }
    
    logger.debug({
      totalErrors: errors.length,
      validErrors: validErrors.length,
      errors: validErrors.map(e => ({ term: e.term, expected: e.expected, found: e.found })),
    }, 'fixTranslation: Starting to fix errors');
    
    // Get language information
    const sourceLocale = options.sourceLocale ?? 'ru';
    const targetLocale = options.targetLocale ?? 'en';
    const sourceLang = getLanguageName(sourceLocale);
    const targetLang = getLanguageName(targetLocale);
    const sourceLangCode = sourceLocale;
    const targetLangCode = targetLocale;
    
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
      this.convertTagsToXml(sourceText),
      '',
      '=== DRAFT TRANSLATION (Current) ===',
      `Language: ${targetLang} (but may contain errors)`,
      this.convertTagsToXml(draftText),
      '',
      '=== GLOSSARY REFERENCE ===',
      glossaryText,
      '',
      '=== ERRORS TO FIX ===',
      errorList,
      '',
      '=== FORMATTING PRESERVATION ===',
      'The source and draft texts may contain XML formatting tags like <t i="1">word</t>.',
      'CRITICAL: Preserve these XML tags in your corrected translation. Place them around the corresponding translated words.',
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
      '- Preserve all XML tags (like <t i="1">word</t>) exactly as they appear in the source',
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
    // Calculate dynamic maxTokens based on total input length
    let editorMaxTokens = options.maxTokens;
    if (!editorMaxTokens || editorMaxTokens < 2048) {
      const sourceTextLength = sourceText.length;
      const draftTextLength = draftText.length;
      const totalLength = sourceTextLength + draftTextLength;
      const estimatedInputTokens = Math.ceil(totalLength / 4);
      const calculatedMaxTokens = Math.max(
        Math.ceil(estimatedInputTokens * 2.5) + 1000, // 2.5x for translation + buffer
        2048 // Minimum 2048
      );
      editorMaxTokens = Math.min(calculatedMaxTokens, 8192);
      logger.debug({
        sourceTextLength,
        draftTextLength,
        totalLength,
        estimatedInputTokens,
        calculatedMaxTokens,
        finalMaxTokens: editorMaxTokens,
      }, 'fixTranslation: Calculated dynamic maxTokens');
    } else {
      // Ensure minimum 2048 even if explicitly set
      editorMaxTokens = Math.max(editorMaxTokens, 2048);
    }
    
    logger.debug({
      promptLength: prompt.length,
      maxTokens: editorMaxTokens,
      errorsCount: validErrors.length,
    }, 'fixTranslation: Calling AI with increased maxTokens');
    
    try {
      // Build system persona for explicit injection with clear translation direction
      const systemPersona = `You are an expert linguist. TRANSLATION DIRECTION: ${sourceLangCode} → ${targetLangCode}. You translate FROM ${sourceLangCode} (${sourceLang}, source/input) TO ${targetLangCode} (${targetLang}, target/output). CRITICAL: Your output MUST be in ${targetLangCode} only. Never return text in ${sourceLangCode}. ALL source text is in ${sourceLangCode} and MUST be translated to ${targetLangCode}. Do not keep source text unchanged - always translate. Your translations must be accurate, natural, and idiomatic. Avoid literal calques and word-for-word translations. Prioritize meaning and fluency while maintaining technical precision.`;
      
      const response = await provider.callModel({
        prompt,
        model,
        temperature: options.temperature ?? 0.4, // Increased from 0.2 to 0.4 for better fluency
        maxTokens: editorMaxTokens,
        systemPrompt: systemPersona, // Explicit system prompt injection
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
      
      // Convert XML tags back to formatting tags
      final = this.convertXmlToTags(final);
      
      if (!final || final.length === 0) {
        logger.warn('fixTranslation: Response is empty after trim, returning draft');
        return { finalText: draftText, modelUsed: model, usage: response.usage };
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
        return { finalText: draftText, modelUsed: model, usage: response.usage };
      }

      logger.debug({
        finalLength: final.length,
        finalPreview: final.substring(0, 100),
        hadMockMarker: response.outputText.includes('synthetic translation'),
      }, 'fixTranslation: Successfully fixed translation');

      return { finalText: final, modelUsed: model, usage: response.usage };
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorsCount: validErrors.length,
      }, 'fixTranslation: Failed to fix translation');
      
      // Return draft as fallback instead of throwing
      logger.warn('fixTranslation: Returning draft as fallback due to error');
      return { finalText: draftText, modelUsed: model };
    }
  }

  /**
   * Auto-Mode: Runs the full Draft -> Critic -> Fix loop internally.
   */
  async translateWithCritic(
    segment: OrchestratorSegment,
    options: Omit<TranslateSegmentsOptions, 'segments'>,
    onProgress?: (stage: 'draft' | 'critic' | 'editor' | 'complete', message?: string) => void,
    context?: { previous?: string; next?: string },
  ): Promise<OrchestratorResult> {
    const provider = getProvider(options.provider, options.apiKey, options.yandexFolderId);
    
    logger.debug({
      providerName: provider.name,
      optionsProvider: options.provider,
      optionsModel: options.model,
      providerDefaultModel: provider.defaultModel,
      source: 'translateWithCritic:start',
    }, 'translateWithCritic: Initial provider and model');
    
    // 1. Draft
    onProgress?.('draft', 'Generating draft translation...');
    // Use context parameter if provided, otherwise fall back to segment properties
    const draftContext = context ?? {
      previous: segment.previousText ?? undefined,
      next: segment.nextText ?? undefined,
    };
    const draft = await this.generateDraft(segment.sourceText, options, draftContext);
    
    // 2. Critic
    onProgress?.('critic', 'Running critique analysis...');
    // Use much higher maxTokens for critic (prompts are very long, responses can be long too)
    // Gemini API supports up to 8192 output tokens
    const criticMaxTokens = options.maxTokens ? Math.max(options.maxTokens, 8192) : 8192;
    
    // Auto-switch Gemini 2.5+ models to gemini-1.5-pro for critic workflow to avoid thoughts token consumption
    let criticModel = options.model ?? provider.defaultModel;
    
    logger.debug({
      providerName: provider.name,
      originalModel: criticModel,
      optionsModel: options.model,
      providerDefaultModel: provider.defaultModel,
      source: 'translateWithCritic:before-switch',
    }, 'translateWithCritic: Before model switch check');
    
    if (provider.name === 'gemini') {
      const modelLower = (criticModel || '').toLowerCase();
      // Check if it's a flash model (these use thoughts aggressively)
      const isFlashModel = modelLower.includes('flash');
      // Check if it's gemini-pro (often falls back to gemini-2.5-flash)
      const isGeminiPro = modelLower === 'gemini-pro' || (modelLower.includes('gemini-pro') && !modelLower.includes('2.5-pro'));
      // Don't switch if already using gemini-2.5-pro (it's the best available option)
      const isAlready25Pro = modelLower.includes('2.5-pro') && !isFlashModel;
      
      logger.debug({
        providerName: provider.name,
        originalModel: criticModel,
        modelLower,
        isFlashModel,
        isGeminiPro,
        isAlready25Pro,
        checks: {
          hasFlash: isFlashModel,
          isPro: isGeminiPro,
          is25Pro: isAlready25Pro,
        },
        source: 'translateWithCritic:switch-check',
      }, 'translateWithCritic: Model switch check details');
      
      if ((isFlashModel || isGeminiPro) && !isAlready25Pro) {
        // Use gemini-2.5-pro instead of gemini-1.5-pro because gemini-1.5-pro is not available
        // gemini-2.5-pro may use thoughts but less aggressively than gemini-2.5-flash
        const reason = isFlashModel 
          ? 'Gemini Flash models use thoughts which can consume all output tokens'
          : 'gemini-pro often falls back to gemini-2.5-flash which uses thoughts';
        logger.warn({
          originalModel: criticModel,
          fallbackModel: 'gemini-2.5-pro',
          reason,
          source: 'translateWithCritic',
          modelLower,
          isFlashModel,
          isGeminiPro,
          isAlready25Pro,
          note: 'Using gemini-2.5-pro (gemini-1.5-pro not available)',
        }, 'Switching to gemini-2.5-pro for translateWithCritic (gemini-1.5-pro not available)');
        criticModel = 'gemini-2.5-pro';
      } else {
        logger.debug({
          providerName: provider.name,
          model: criticModel,
          modelLower,
          isFlashModel,
          isGeminiPro,
          isAlready25Pro,
          reason: isAlready25Pro ? 'Already using gemini-2.5-pro' : 'Model does not need switching',
          source: 'translateWithCritic',
        }, 'translateWithCritic: No model switch needed');
      }
    } else {
      logger.debug({
        providerName: provider.name,
        model: criticModel,
        reason: 'Not Gemini provider',
        source: 'translateWithCritic',
      }, 'translateWithCritic: No model switch needed (not Gemini)');
    }
    
    logger.debug({
      finalModel: criticModel,
      originalModel: options.model,
      source: 'translateWithCritic:after-switch',
    }, 'translateWithCritic: Final model after switch');
    
    logger.info({
      finalModel: criticModel,
      originalModel: options.model,
      provider: options.provider,
      source: 'translateWithCritic:before-runCritique',
    }, 'translateWithCritic: Calling runCritique with model');
    
    const critique = await this.runCritique(
        segment.sourceText, 
        draft.draftText, 
        options.glossary, 
        { 
          provider: options.provider, 
          model: criticModel, 
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
        
        // Calculate dynamic maxTokens for fix step (needs to handle source + draft + errors)
        let fixMaxTokens = options.maxTokens;
        if (!fixMaxTokens || fixMaxTokens < 2048) {
          const sourceTextLength = segment.sourceText.length;
          const draftTextLength = draft.draftText.length;
          const totalLength = sourceTextLength + draftTextLength;
          const estimatedInputTokens = Math.ceil(totalLength / 4);
          const calculatedMaxTokens = Math.max(
            Math.ceil(estimatedInputTokens * 2.5) + 1000,
            2048 // Minimum 2048
          );
          fixMaxTokens = Math.min(calculatedMaxTokens, 8192);
          logger.debug({
            sourceTextLength,
            draftTextLength,
            totalLength,
            estimatedInputTokens,
            calculatedMaxTokens,
            finalMaxTokens: fixMaxTokens,
          }, 'translateWithCritic: Calculated dynamic maxTokens for fix step');
        }
        
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
                maxTokens: fixMaxTokens,
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

  /**
   * Build prompt for a single segment (public method for debug purposes)
   */
  buildPromptForSegment(
    segment: OrchestratorSegment,
    options: TranslateSegmentsOptions,
  ): string {
    return this.buildBatchPrompt([segment], options);
  }
}