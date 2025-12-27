/**
 * Test script to verify XML tag placement with word order changes
 * 
 * Tests if AI correctly places XML tags around translated words when word order changes
 * (e.g., English "Safety Rules" -> Russian "Правила безопасности")
 * 
 * Usage:
 *   cd backend
 *   npx ts-node src/scripts/test-tag-position.ts
 * 
 * Environment variables:
 *   - GEMINI_API_KEY, OPENAI_API_KEY, or YANDEX_API_KEY (required)
 *   - AI_PROVIDER (optional, defaults to 'gemini')
 *   - AI_MODEL (optional, uses provider default)
 * 
 * The script will:
 * 1. Send "The <t i='1'>Safety</t> Rules are important." to AI
 * 2. Check if the tag moves to "безопасности" (correct) or stays on "Правила" (wrong)
 * 3. Show both the raw XML response and the converted {{n}} format
 */

import { AIOrchestrator } from '../ai/orchestrator';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

async function testTagPosition() {
  console.log('=== XML Tag Position Test ===\n');

  const orchestrator = new AIOrchestrator();

  // Test case: English to Russian with word order change
  // "The Safety Rules" -> "Правила безопасности"
  // The tag should move from "Safety" to "безопасности" (the translated word)
  const testSegment = {
    segmentId: 'test-1',
    sourceText: "The <t i='1'>Safety</t> Rules are important.",
    previousText: undefined,
    nextText: undefined,
    documentName: undefined,
  };

  console.log('Source text:', testSegment.sourceText);
  console.log('Expected behavior: Tag should move to the translated word "безопасности"\n');

  try {
    // Get provider from environment or use default
    const provider = process.env.AI_PROVIDER || 'gemini';
    const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.YANDEX_API_KEY;
    
    if (!apiKey) {
      console.error('ERROR: No API key found. Please set one of:');
      console.error('  - GEMINI_API_KEY');
      console.error('  - OPENAI_API_KEY');
      console.error('  - YANDEX_API_KEY');
      process.exit(1);
    }

    console.log(`Using provider: ${provider}`);
    console.log('Calling translateSegments...\n');

    const results = await orchestrator.translateSegments({
      segments: [testSegment],
      provider,
      apiKey,
      sourceLocale: 'en',
      targetLocale: 'ru',
      model: process.env.AI_MODEL, // Optional: override model
      temperature: 0.4,
    });

    console.log('=== RESULTS ===\n');
    
    if (results.length === 0) {
      console.error('ERROR: No results returned');
      process.exit(1);
    }

    const result = results[0];
    console.log('Segment ID:', result.segmentId);
    console.log('Provider:', result.provider);
    console.log('Model:', result.model);
    
    // Try to extract raw XML response from the raw field
    let rawXmlResponse: string | null = null;
    if (result.raw && typeof result.raw === 'object') {
      const rawObj = result.raw as any;
      if (rawObj.outputText) {
        rawXmlResponse = rawObj.outputText;
      } else if (typeof rawObj === 'string') {
        rawXmlResponse = rawObj;
      }
    }

    console.log('\n--- FINAL RESULT (after XML→{{n}} conversion) ---');
    console.log(result.targetText);
    console.log('\n--- ANALYSIS ---');

    // Check if tag is present in final result ({{n}} format)
    const hasFormattingTag = result.targetText.includes('{{1}}');
    console.log(`Has formatting tag ({{1}}): ${hasFormattingTag}`);

    if (hasFormattingTag) {
      // Extract the tagged word from {{1}}...{{/1}} format
      const tagMatch = result.targetText.match(/\{\{1\}\}([^{]+)\{\{\/1\}\}/);
      if (tagMatch) {
        const taggedWord = tagMatch[1].trim();
        console.log(`Tagged word: "${taggedWord}"`);
        
        // Check if it's the correct word (безопасности)
        if (taggedWord.includes('безопасност')) {
          console.log('✅ CORRECT: Tag is on the translated word "безопасности"');
          console.log('   The AI correctly moved the tag to the translated word position');
        } else if (taggedWord.includes('Правил')) {
          console.log('❌ WRONG: Tag is on "Правила" instead of "безопасности"');
          console.log('   This indicates the AI kept the tag in the original position');
          console.log('   Expected: "Правила {{1}}безопасности{{/1}}"');
          console.log('   Got: "{{1}}Правила{{/1}} безопасности"');
        } else {
          console.log(`⚠️  UNEXPECTED: Tag is on "${taggedWord}"`);
        }
      }
    } else {
      console.log('❌ ERROR: No formatting tags found in response');
      console.log('   The AI may have removed the tags or not preserved them');
    }

    // Show raw XML response if available
    if (rawXmlResponse) {
      console.log('\n--- RAW AI RESPONSE (with XML tags before conversion) ---');
      console.log(rawXmlResponse);
      
      // Check for XML tags in raw response
      const hasXmlTag = rawXmlResponse.includes('<t i=');
      if (hasXmlTag) {
        const xmlTagMatch = rawXmlResponse.match(/<t i=['"]1['"]>([^<]+)<\/t>/);
        if (xmlTagMatch) {
          const xmlTaggedWord = xmlTagMatch[1].trim();
          console.log(`\nRaw XML tagged word: "${xmlTaggedWord}"`);
        }
      }
    } else {
      console.log('\n--- RAW RESPONSE NOT AVAILABLE ---');
      console.log('   Check the debug log file: .cursor/debug-xml-prompt-*.log');
      console.log('   to see the prompt sent to AI and verify XML tag instructions');
    }

    console.log('\n--- NOTE ---');
    console.log('The orchestrator converts XML tags (<t i="1">) to formatting tags ({{1}})');
    console.log('for compatibility with the docx handler. The final result above shows');
    console.log('the converted format that will be used in the document.');

  } catch (error) {
    console.error('\n=== ERROR ===');
    console.error('Failed to translate:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the test
testTagPosition()
  .then(() => {
    console.log('\n=== Test completed ===');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

