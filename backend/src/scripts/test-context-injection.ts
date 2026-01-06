/**
 * Test script to verify Neighboring Context injection into prompts
 * 
 * This script tests that when translating segments with batchSize: 1,
 * each segment receives the previous and next segments as context.
 * 
 * Specifically, when Seg 2 ("Target segment.") is processed:
 * - It should have Seg 1 ("Context before.") as prevContext
 * - It should have Seg 3 ("Context after.") as nextContext
 * 
 * The context should appear in the debug log file (debug-xml-prompt-*.log)
 * with sections:
 *   === PREVIOUS CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===
 *   === NEXT CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===
 * 
 * Usage:
 *   cd backend
 *   npx ts-node src/scripts/test-context-injection.ts
 * 
 * Environment variables:
 *   - GEMINI_API_KEY, OPENAI_API_KEY, or YANDEX_API_KEY (required)
 *   - AI_PROVIDER (optional, defaults to 'gemini')
 *   - AI_MODEL (optional, uses provider default)
 */

import { AIOrchestrator, type OrchestratorSegment } from '../ai/orchestrator';
import { logger } from '../utils/logger';

async function testContextInjection() {
  console.log('='.repeat(80));
  console.log('NEIGHBORING CONTEXT INJECTION TEST');
  console.log('='.repeat(80));
  console.log('');

  const orchestrator = new AIOrchestrator();

  // Get provider from environment or use default
  const provider = process.env.AI_PROVIDER || 'gemini';
  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.YANDEX_API_KEY;
  
  if (!apiKey) {
    console.error('❌ ERROR: No API key found. Please set one of:');
    console.error('   - GEMINI_API_KEY');
    console.error('   - OPENAI_API_KEY');
    console.error('   - YANDEX_API_KEY');
    process.exit(1);
  }

  console.log(`Provider: ${provider}`);
  console.log(`Source Locale: en`);
  console.log(`Target Locale: ru`);
  console.log(`Batch Size: 1 (forces each segment into separate batch)`);
  console.log('');

  // Create 3 mock segments
  const segments: OrchestratorSegment[] = [
    {
      segmentId: 'seg-1',
      sourceText: 'Context before.',
    },
    {
      segmentId: 'seg-2',
      sourceText: 'Target segment.',
    },
    {
      segmentId: 'seg-3',
      sourceText: 'Context after.',
    },
  ];

  console.log('Test Segments:');
  console.log(`  1. "${segments[0].sourceText}" (should be prevContext for seg-2)`);
  console.log(`  2. "${segments[1].sourceText}" (TARGET - should have prev and next context)`);
  console.log(`  3. "${segments[2].sourceText}" (should be nextContext for seg-2)`);
  console.log('');

  console.log('Running translation with batchSize: 1...');
  console.log('This will create 3 separate batches:');
  console.log('  - Batch 1: seg-1 (no prevContext, seg-2 as nextContext)');
  console.log('  - Batch 2: seg-2 (seg-1 as prevContext, seg-3 as nextContext) ← KEY TEST');
  console.log('  - Batch 3: seg-3 (seg-2 as prevContext, no nextContext)');
  console.log('');

  try {
    const results = await orchestrator.translateSegments({
      segments,
      sourceLocale: 'en',
      targetLocale: 'ru',
      provider: provider as any,
      apiKey,
      model: process.env.AI_MODEL,
      batchSize: 1, // Force each segment into separate batch
    });

    console.log('✅ Translation completed successfully!');
    console.log('');
    console.log('Results:');
    results.forEach((result, index) => {
      console.log(`  ${index + 1}. ${result.segmentId}: "${result.targetText}"`);
    });
    console.log('');

    console.log('='.repeat(80));
    console.log('VERIFICATION INSTRUCTIONS:');
    console.log('='.repeat(80));
    console.log('');
    console.log('1. Check the latest debug log file in `.cursor/debug-xml-prompt-*.log`');
    console.log('');
    console.log('2. Find the prompt for seg-2 (the middle segment).');
    console.log('');
    console.log('3. Verify it contains:');
    console.log('   === PREVIOUS CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===');
    console.log('   Context before.');
    console.log('');
    console.log('   === SOURCE SEGMENTS TO TRANSLATE ===');
    console.log('   ID: seg-2');
    console.log('   Source: Target segment.');
    console.log('');
    console.log('   === NEXT CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===');
    console.log('   Context after.');
    console.log('');
    console.log('4. If you see both PREVIOUS CONTEXT and NEXT CONTEXT sections');
    console.log('   with the correct text, the implementation is working correctly! ✅');
    console.log('');

  } catch (error) {
    logger.error({ error }, 'Error during Context Injection Test');
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testContextInjection().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});


