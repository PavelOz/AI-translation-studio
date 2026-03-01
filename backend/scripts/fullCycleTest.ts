/**
 * FullCycleTest: Сквозной тест всей системы AI Translation Studio V2
 * 
 * Сценарий:
 * 1. DNA Synthesis - синтез DNA из документа
 * 2. Massive Translation - массовый перевод с использованием DNA
 * 3. Universal Audit - проверка перевода через UniversalJanitor
 * 
 * Запуск:
 * npx ts-node backend/scripts/fullCycleTest.ts <documentId> [options]
 */

import { prisma } from '../src/db/prisma';
import { DnaSynthesisService } from '../src/services/dnaSynthesis.service';
import { TranslationOrchestrator } from '../src/ai/translationOrchestrator';
import { UniversalJanitor } from '../src/services/universalJanitor';
import { logger } from '../src/utils/logger';
import { env } from '../src/utils/env';
import type { OrchestratorSegment } from '../src/ai/types';
import type { DocumentDnaPayload } from '../src/ai/types';

/**
 * Конфигурация теста
 */
interface TestConfig {
  documentId: string;
  tags: string[];
  synthesisProvider: 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude';
  synthesisModel?: string;
  translationProvider: 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude';
  translationModel?: string;
  maxSegments?: number; // Ограничение количества сегментов для теста
  autoFix: boolean;
  strictMode: boolean;
  dryRun: boolean;
}

/**
 * Результаты теста
 */
interface TestResults {
  documentId: string;
  documentName: string;
  direction: string;
  
  // Step 1: DNA Synthesis
  synthesis: {
    completed: boolean;
    totalTerms: number;
    validationRules: number;
    errors?: string[];
  };
  
  // Step 2: Translation
  translation: {
    completed: boolean;
    totalSegments: number;
    translated: number;
    batches: number;
    errors: number;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  };
  
  // Step 3: Audit
  audit: {
    completed: boolean;
    validated: number;
    autoFixed: number;
    requiresReview: number;
    totalErrors: number;
    errorsByType: Record<string, number>;
  };
  
  // Final Statistics
  finalStats: {
    dnaTermsUsed: number;
    segmentsProcessed: number;
    segmentsValidated: number;
    segmentsRequiringReview: number;
    overallQuality: 'excellent' | 'good' | 'needs_review' | 'poor';
  };
  
  timestamp: Date;
  duration: number; // milliseconds
}

/**
 * Главная функция теста
 */
async function runFullCycleTest(config: TestConfig): Promise<TestResults> {
  const startTime = Date.now();
  
  logger.info(
    {
      documentId: config.documentId,
      tags: config.tags,
      synthesisProvider: config.synthesisProvider,
      translationProvider: config.translationProvider,
    },
    '🚀 Starting Full Cycle Test',
  );

  // Загружаем документ
  const document = await prisma.document.findUnique({
    where: { id: config.documentId },
    select: {
      id: true,
      name: true,
      sourceLocale: true,
      targetLocale: true,
      projectId: true,
    },
  });

  if (!document) {
    throw new Error(`Document ${config.documentId} not found`);
  }

  logger.info(
    {
      documentName: document.name,
      direction: `${document.sourceLocale} → ${document.targetLocale}`,
    },
    '📄 Document loaded',
  );

  // ============================================
  // STEP 1: DNA SYNTHESIS
  // ============================================
  logger.info({}, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info({}, 'STEP 1: DNA SYNTHESIS');
  logger.info({}, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const synthesisService = new DnaSynthesisService();
  let synthesisResult;
  let synthesisErrors: string[] = [];

  try {
    synthesisResult = await synthesisService.synthesize(
      {
        type: 'document',
        documentId: config.documentId,
        tags: config.tags,
      },
      null, // Master DNA будет автоматически подобран по тегам
      config.documentId,
      {
        useLLM: true,
        llmProvider: config.synthesisProvider,
        llmModel: config.synthesisModel || (config.synthesisProvider === 'gemini' ? 'gemini-1.5-pro' : undefined),
        apiKey: getApiKey(config.synthesisProvider),
        autoResolveMasterDna: true, // Автоматический подбор Master DNA по тегам
        enableGlossaryExtraction: true,
        glossaryMode: 'deep',
        conflictStrategy: 'master_priority',
        maxMasterDnaTerms: 50,
      },
    );

    logger.info(
      {
        totalTerms: Object.keys(synthesisResult.synthesized.abbreviationLogic || {}).length,
        validationRules: synthesisResult.synthesized.validationHints?.rules?.length || 0,
        extracted: synthesisResult.statistics.extracted,
        fromMaster: synthesisResult.statistics.fromMaster,
        llmEnriched: synthesisResult.statistics.llmEnriched,
      },
      '✅ DNA Synthesis completed',
    );
  } catch (error) {
    synthesisErrors.push(error instanceof Error ? error.message : String(error));
    logger.error({ error }, '❌ DNA Synthesis failed');
    throw error;
  }

  // ============================================
  // STEP 2: MASSIVE TRANSLATION
  // ============================================
  logger.info({}, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info({}, 'STEP 2: MASSIVE TRANSLATION');
  logger.info({}, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Загружаем сегменты для перевода
  const segments = await prisma.segment.findMany({
    where: {
      documentId: config.documentId,
      targetMt: null, // Только непереведенные сегменты
    },
    select: {
      id: true,
      segmentIndex: true,
      sourceText: true,
      targetMt: true,
      targetFinal: true,
    },
    orderBy: {
      segmentIndex: 'asc',
    },
    take: config.maxSegments || 1000, // Ограничение для теста
  });

  if (segments.length === 0) {
    logger.warn({}, '⚠️ No segments to translate (all segments already have translations)');
  }

  logger.info(
    {
      segmentsCount: segments.length,
    },
    '📝 Segments loaded for translation',
  );

  // Конвертируем в OrchestratorSegment
  const orchestratorSegments: OrchestratorSegment[] = segments.map((seg, index) => ({
    segmentId: seg.id,
    sourceText: seg.sourceText,
    previousText: index > 0 ? segments[index - 1].sourceText : null,
    nextText: index < segments.length - 1 ? segments[index + 1].sourceText : null,
  }));

  const translationOrchestrator = new TranslationOrchestrator();
  let translationResult;
  let translationErrors = 0;

  try {
    translationResult = await translationOrchestrator.translateAll(
      orchestratorSegments,
      {
        provider: config.translationProvider,
        model: config.translationModel || (config.translationProvider === 'gemini' ? 'gemini-1.5-flash' : undefined),
        apiKey: getApiKey(config.translationProvider),
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
        dna: synthesisResult.synthesized,
        documentName: document.name,
        onProgress: (progress) => {
          logger.info(
            {
              current: progress.current,
              total: progress.total,
              batch: `${progress.batch}/${progress.totalBatches}`,
            },
            '🔄 Translation progress',
          );
        },
      },
    );

    // Сохраняем переводы в БД
    if (!config.dryRun) {
      for (const translated of translationResult.results) {
        await prisma.segment.update({
          where: { id: translated.id },
          data: {
            targetMt: translated.target,
          },
        });
      }
    }

    translationErrors = translationResult.errors.length;

    logger.info(
      {
        translated: translationResult.results.length,
        totalBatches: translationResult.totalBatches,
        errors: translationErrors,
      },
      '✅ Translation completed',
    );
  } catch (error) {
    logger.error({ error }, '❌ Translation failed');
    throw error;
  }

  // ============================================
  // STEP 3: UNIVERSAL AUDIT
  // ============================================
  logger.info({}, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info({}, 'STEP 3: UNIVERSAL AUDIT');
  logger.info({}, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const universalJanitor = new UniversalJanitor();
  let auditReport;

  try {
    auditReport = await universalJanitor.auditSegments(config.documentId, {
      autoFix: config.autoFix,
      strictMode: config.strictMode,
      dryRun: config.dryRun,
    });

    logger.info(
      {
        validated: auditReport.statistics.validated,
        autoFixed: auditReport.statistics.autoFixed,
        requiresReview: auditReport.statistics.requiresReview,
        totalErrors: auditReport.statistics.totalErrors,
      },
      '✅ Audit completed',
    );
  } catch (error) {
    logger.error({ error }, '❌ Audit failed');
    throw error;
  }

  // ============================================
  // FINAL REPORT
  // ============================================
  const duration = Date.now() - startTime;
  const dnaTermsCount = Object.keys(synthesisResult.synthesized.abbreviationLogic || {}).length;
  const segmentsRequiringReview = auditReport.statistics.requiresReview;
  const totalSegments = auditReport.statistics.totalSegments;
  const validatedSegments = auditReport.statistics.validated;

  // Определяем общее качество
  const qualityRatio = validatedSegments / totalSegments;
  let overallQuality: 'excellent' | 'good' | 'needs_review' | 'poor';
  if (qualityRatio >= 0.95) {
    overallQuality = 'excellent';
  } else if (qualityRatio >= 0.85) {
    overallQuality = 'good';
  } else if (qualityRatio >= 0.70) {
    overallQuality = 'needs_review';
  } else {
    overallQuality = 'poor';
  }

  const finalResults: TestResults = {
    documentId: config.documentId,
    documentName: document.name,
    direction: `${document.sourceLocale} → ${document.targetLocale}`,
    
    synthesis: {
      completed: true,
      totalTerms: dnaTermsCount,
      validationRules: synthesisResult.synthesized.validationHints?.rules?.length || 0,
      errors: synthesisErrors.length > 0 ? synthesisErrors : undefined,
    },
    
    translation: {
      completed: true,
      totalSegments: segments.length,
      translated: translationResult.results.length,
      batches: translationResult.totalBatches,
      errors: translationErrors,
    },
    
    audit: {
      completed: true,
      validated: auditReport.statistics.validated,
      autoFixed: auditReport.statistics.autoFixed,
      requiresReview: auditReport.statistics.requiresReview,
      totalErrors: auditReport.statistics.totalErrors,
      errorsByType: auditReport.statistics.errorsByType,
    },
    
    finalStats: {
      dnaTermsUsed: dnaTermsCount,
      segmentsProcessed: totalSegments,
      segmentsValidated: validatedSegments,
      segmentsRequiringReview,
      overallQuality,
    },
    
    timestamp: new Date(),
    duration,
  };

  // Выводим финальный отчет
  printFinalReport(finalResults, auditReport);

  return finalResults;
}

/**
 * Вывод финального отчета
 */
function printFinalReport(results: TestResults, auditReport: any): void {
  logger.info({}, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info({}, '📊 FINAL REPORT');
  logger.info({}, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    AI TRANSLATION STUDIO V2 - FULL CYCLE TEST                ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');
  console.log('\n');
  
  console.log('📄 Document Information:');
  console.log(`   Name: ${results.documentName}`);
  console.log(`   Direction: ${results.direction}`);
  console.log(`   Document ID: ${results.documentId}`);
  console.log('\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 1: DNA SYNTHESIS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   ✅ Status: ${results.synthesis.completed ? 'COMPLETED' : 'FAILED'}`);
  console.log(`   📚 Total DNA Terms: ${results.synthesis.totalTerms}`);
  console.log(`   📋 Validation Rules: ${results.synthesis.validationRules}`);
  if (results.synthesis.errors) {
    console.log(`   ❌ Errors: ${results.synthesis.errors.length}`);
  }
  console.log('\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 2: MASSIVE TRANSLATION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   ✅ Status: ${results.translation.completed ? 'COMPLETED' : 'FAILED'}`);
  console.log(`   📝 Total Segments: ${results.translation.totalSegments}`);
  console.log(`   ✅ Translated: ${results.translation.translated}`);
  console.log(`   📦 Batches: ${results.translation.batches}`);
  console.log(`   ❌ Errors: ${results.translation.errors}`);
  console.log('\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 3: UNIVERSAL AUDIT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   ✅ Status: ${results.audit.completed ? 'COMPLETED' : 'FAILED'}`);
  console.log(`   ✅ Validated: ${results.audit.validated}`);
  console.log(`   🔧 Auto-fixed: ${results.audit.autoFixed}`);
  console.log(`   ⚠️  Requires Review: ${results.audit.requiresReview}`);
  console.log(`   ❌ Total Errors: ${results.audit.totalErrors}`);
  console.log('\n');
  
  console.log('   Error Breakdown:');
  for (const [type, count] of Object.entries(results.audit.errorsByType)) {
    if (count > 0) {
      console.log(`      - ${type}: ${count}`);
    }
  }
  console.log('\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 FINAL STATISTICS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   📚 DNA Terms Used: ${results.finalStats.dnaTermsUsed}`);
  console.log(`   📝 Segments Processed: ${results.finalStats.segmentsProcessed}`);
  console.log(`   ✅ Segments Validated: ${results.finalStats.segmentsValidated}`);
  console.log(`   ⚠️  Segments Requiring Review: ${results.finalStats.segmentsRequiringReview}`);
  console.log(`   🎯 Overall Quality: ${results.finalStats.overallQuality.toUpperCase()}`);
  console.log(`   ⏱️  Total Duration: ${(results.duration / 1000).toFixed(2)}s`);
  console.log('\n');
  
  // Показываем примеры сегментов, требующих проверки
  if (results.audit.requiresReview > 0) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚠️  SEGMENTS REQUIRING REVIEW (Sample)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const requiresReviewSegments = auditReport.segments
      .filter((s: any) => s.status === 'REQUIRES_REVIEW')
      .slice(0, 5);
    
    for (const segment of requiresReviewSegments) {
      console.log(`\n   Segment #${segment.segmentIndex}:`);
      console.log(`   Comment: ${segment.janitorComment}`);
      console.log(`   Errors: ${segment.errors.length}`);
      for (const error of segment.errors.slice(0, 3)) {
        console.log(`      - ${error.message}`);
      }
    }
    console.log('\n');
  }
  
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                              TEST COMPLETED                                   ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');
  console.log('\n');
}

/**
 * Получение API ключа для провайдера
 */
function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'gemini':
      return env.geminiApiKey;
    case 'openai':
      return env.openAiApiKey;
    case 'yandex':
      return env.yandexApiKey;
    case 'deepseek':
      return env.deepseekApiKey;
    case 'claude':
      return env.claudeApiKey;
    default:
      return undefined;
  }
}

/**
 * Главная функция
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: npx ts-node backend/scripts/fullCycleTest.ts <documentId> [options]');
    console.error('\nOptions:');
    console.error('  --tags <tag1,tag2,...>     Document tags (default: energy,KEGOC)');
    console.error('  --synthesis-provider <p>   Provider for synthesis (default: gemini)');
    console.error('  --synthesis-model <m>      Model for synthesis (default: gemini-1.5-pro)');
    console.error('  --translation-provider <p> Provider for translation (default: gemini)');
    console.error('  --translation-model <m>    Model for translation (default: gemini-1.5-flash)');
    console.error('  --max-segments <n>          Max segments to process (default: 1000)');
    console.error('  --no-auto-fix              Disable auto-fix in audit');
    console.error('  --strict-mode               Enable strict mode in audit');
    console.error('  --dry-run                   Don\'t save changes to database');
    process.exit(1);
  }

  const documentId = args[0];
  
  // Парсим опции
  const tagsIndex = args.indexOf('--tags');
  const tags = tagsIndex >= 0 && args[tagsIndex + 1]
    ? args[tagsIndex + 1].split(',')
    : ['energy', 'KEGOC'];

  const synthesisProvider = (args.indexOf('--synthesis-provider') >= 0
    ? args[args.indexOf('--synthesis-provider') + 1]
    : 'gemini') as 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude';

  const synthesisModel = args.indexOf('--synthesis-model') >= 0
    ? args[args.indexOf('--synthesis-model') + 1]
    : undefined;

  const translationProvider = (args.indexOf('--translation-provider') >= 0
    ? args[args.indexOf('--translation-provider') + 1]
    : 'gemini') as 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude';

  const translationModel = args.indexOf('--translation-model') >= 0
    ? args[args.indexOf('--translation-model') + 1]
    : undefined;

  const maxSegments = args.indexOf('--max-segments') >= 0
    ? parseInt(args[args.indexOf('--max-segments') + 1], 10)
    : undefined;

  const autoFix = args.indexOf('--no-auto-fix') === -1;
  const strictMode = args.indexOf('--strict-mode') >= 0;
  const dryRun = args.indexOf('--dry-run') >= 0;

  const config: TestConfig = {
    documentId,
    tags,
    synthesisProvider,
    synthesisModel,
    translationProvider,
    translationModel,
    maxSegments,
    autoFix,
    strictMode,
    dryRun,
  };

  try {
    const results = await runFullCycleTest(config);
    
    // Сохраняем результаты в JSON файл
    const fs = await import('fs');
    const path = await import('path');
    const outputPath = path.join(process.cwd(), `full-cycle-test-${documentId}-${Date.now()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    
    logger.info({ outputPath }, '📄 Test results saved to file');
    
    process.exit(0);
  } catch (error) {
    logger.error({ error }, '❌ Full cycle test failed');
    process.exit(1);
  }
}

// Запуск
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { runFullCycleTest, TestConfig, TestResults };
