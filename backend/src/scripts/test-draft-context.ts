/**
 * Test script to verify Neighboring Context injection in Draft Mode (translateWithCritic)
 * 
 * This script tests that when translateWithCritic is called with a segment that has
 * previousText and nextText properties, those are correctly passed to generateDraft
 * and eventually injected into the prompt.
 * 
 * Usage:
 *   cd backend
 *   npx ts-node src/scripts/test-draft-context.ts
 * 
 * Environment variables:
 *   - GEMINI_API_KEY, OPENAI_API_KEY, or YANDEX_API_KEY (required)
 *   - AI_PROVIDER (optional, defaults to 'gemini')
 *   - AI_MODEL (optional, uses provider default)
 */

import { AIOrchestrator, type OrchestratorSegment } from '../ai/orchestrator';
import { logger } from '../utils/logger';

async function testDraftContext() {
  const orchestrator = new AIOrchestrator();
  
  console.log('🚀 Starting Draft Context Test...');
  console.log('');

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
  console.log('');

  // Имитируем вызов из ai.service.ts
  // Мы передаем сегмент, у которого УЖЕ заполнены свойства previousText/nextText
  const segmentWithContext: OrchestratorSegment = {
    segmentId: 'manual-test-1',
    sourceText: 'She smiled at him.', // Без контекста непонятно, кто "She"
    previousText: 'Maria walked into the room.', // Контекст
    nextText: 'Then she sat down.'
  };

  console.log('Test Segment:');
  console.log(`  Previous: "${segmentWithContext.previousText}"`);
  console.log(`  Current:  "${segmentWithContext.sourceText}"`);
  console.log(`  Next:     "${segmentWithContext.nextText}"`);
  console.log('');
  console.log('Expected behavior:');
  console.log('  - The prompt should contain "=== PREVIOUS CONTEXT ===" with "Maria walked into the room."');
  console.log('  - The prompt should contain "=== NEXT CONTEXT ===" with "Then she sat down."');
  console.log('  - This context should help the AI understand that "She" refers to "Maria"');
  console.log('');

  try {
    // Вызываем метод, который дергает generateDraft
    // Важно: мы не передаем context отдельно, мы полагаемся на свойства внутри segmentWithContext,
    // так как именно так делает ваш ai.service.ts
    await orchestrator.translateWithCritic(
      segmentWithContext, 
      {
        provider: provider as any,
        model: process.env.AI_MODEL,
        apiKey,
        sourceLocale: 'en',
        targetLocale: 'ru'
      }
    );

    console.log('✅ Test finished successfully!');
    console.log('');
    console.log('='.repeat(80));
    console.log('VERIFICATION INSTRUCTIONS:');
    console.log('='.repeat(80));
    console.log('');
    console.log('1. Check the latest debug log file in `.cursor/debug-xml-prompt-*.log`');
    console.log('');
    console.log('2. Find the prompt for the draft generation step.');
    console.log('');
    console.log('3. Verify it contains:');
    console.log('   === PREVIOUS CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===');
    console.log('   Maria walked into the room.');
    console.log('');
    console.log('   === SOURCE SEGMENTS TO TRANSLATE ===');
    console.log('   ID: manual-test-1');
    console.log('   Source: She smiled at him.');
    console.log('');
    console.log('   === NEXT CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===');
    console.log('   Then she sat down.');
    console.log('');
    console.log('4. If you see both PREVIOUS CONTEXT and NEXT CONTEXT sections');
    console.log('   with the correct text, the implementation is working correctly! ✅');
    console.log('');

  } catch (error) {
    logger.error({ error }, 'Error during Draft Context Test');
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testDraftContext().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

