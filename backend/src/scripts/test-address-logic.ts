/**
 * Test script to verify Address Standardization logic for RU->EN translation
 * 
 * Tests if the address formatting rules correctly:
 * - Invert address order (Country, City, Street, Building → Building, Street, City, Country)
 * - Handle abbreviations (ул., пр., бул., мкр., зд., д., etc.)
 * - Format addresses embedded in sentences
 * - Preserve XML tags when present
 * 
 * Usage:
 *   cd backend
 *   npx ts-node src/scripts/test-address-logic.ts
 * 
 * Environment variables:
 *   - GEMINI_API_KEY, OPENAI_API_KEY, or YANDEX_API_KEY (required)
 *   - AI_PROVIDER (optional, defaults to 'gemini')
 *   - AI_MODEL (optional, uses provider default)
 */

import { AIOrchestrator } from '../ai/orchestrator';
import { logger } from '../utils/logger';

async function testAddressLogic() {
  console.log('='.repeat(80));
  console.log('ADDRESS STANDARDIZATION TEST (RU → EN)');
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
  console.log(`Source Locale: ru`);
  console.log(`Target Locale: en`);
  console.log('');

  // Test cases
  const testCases = [
    {
      id: 'case-1',
      name: 'Simple Inversion',
      description: 'Basic address with street and building number inversion',
      sourceText: 'Наш офис находится по адресу: г. Астана, ул. Достык, д. 18.',
      expectedPattern: '18 Dostyk St., Astana',
      notes: 'Should invert: City, Street, Building → Building, Street, City'
    },
    {
      id: 'case-2',
      name: 'Complex Abbreviations',
      description: 'Address with multiple abbreviations (мкр., зд., офис)',
      sourceText: 'Адрес: Казахстан, г. Алматы, мкр. Самал-2, зд. 55, офис 4.',
      expectedPattern: 'Office 4, 55 Samal-2 Microdistrict, Almaty, Kazakhstan',
      notes: 'Should handle: мкр. → Microdistrict, зд. → building number, офис → Office'
    },
    {
      id: 'case-3',
      name: 'Embedded in Legal Text',
      description: 'Address embedded in sentence with company info',
      sourceText: 'Компания АО «KEGOC» (БИН 12345678, Казахстан, г. Астана, пр. Тәуелсіздік, д. 59) сообщает следующее.',
      expectedPattern: '59 Tauelsizdik Ave., Astana, Kazakhstan',
      notes: 'Should extract and format address from parentheses, preserve other info (BIN)'
    },
    {
      id: 'case-4',
      name: 'With XML Tags',
      description: 'Address with XML formatting tags to verify tag preservation',
      sourceText: 'Наш <t i="1">офис находится по адресу: г. Астана, ул. Достык, д. 18</t>.',
      expectedPattern: '18 Dostyk St., Astana',
      notes: 'Should format address AND preserve XML tags around the translated address'
    }
  ];

  console.log(`Running ${testCases.length} test cases...\n`);

  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    console.log('-'.repeat(80));
    console.log(`TEST CASE ${i + 1}: ${testCase.name}`);
    console.log('-'.repeat(80));
    console.log(`Description: ${testCase.description}`);
    console.log(`Notes: ${testCase.notes}`);
    console.log('');
    console.log('SOURCE TEXT:');
    console.log(`  "${testCase.sourceText}"`);
    console.log('');
    console.log('EXPECTED PATTERN:');
    console.log(`  Should contain: "${testCase.expectedPattern}"`);
    console.log('');

    try {
      const testSegment = {
        segmentId: testCase.id,
        sourceText: testCase.sourceText,
        previousText: undefined,
        nextText: undefined,
        documentName: undefined,
      };

      console.log('Calling translateSegments...');
      const results = await orchestrator.translateSegments({
        segments: [testSegment],
        provider,
        apiKey,
        sourceLocale: 'ru',
        targetLocale: 'en',
        model: process.env.AI_MODEL,
        temperature: 0.4,
      });

      if (results.length === 0) {
        console.error('❌ ERROR: No results returned');
        continue;
      }

      const result = results[0];
      const translatedText = result.targetText;

      console.log('');
      console.log('TRANSLATED OUTPUT:');
      console.log(`  "${translatedText}"`);
      console.log('');

      // Check for expected pattern
      const containsExpected = translatedText.toLowerCase().includes(testCase.expectedPattern.toLowerCase());
      if (containsExpected) {
        console.log('✅ PASS: Contains expected address pattern');
      } else {
        console.log('⚠️  WARNING: Expected pattern not found in translation');
        console.log(`   Looking for: "${testCase.expectedPattern}"`);
      }

      // Check for XML tags (for case-4)
      if (testCase.id === 'case-4') {
        const hasXmlTags = translatedText.includes('<t i=') || translatedText.includes('{{1}}');
        if (hasXmlTags) {
          console.log('✅ PASS: XML tags preserved');
          if (translatedText.includes('<t i=')) {
            console.log('   Format: XML tags (<t i="1">)');
          } else if (translatedText.includes('{{1}}')) {
            console.log('   Format: Formatting tags ({{1}})');
          }
        } else {
          console.log('❌ FAIL: XML tags not preserved');
        }
      }

      // Check for common address formatting issues
      console.log('');
      console.log('ADDRESS FORMATTING CHECKS:');
      
      // Check if building number is at the beginning
      const hasNumberAtStart = /^\d+\s+[A-Z]/.test(translatedText.trim()) || 
                               /Office \d+,\s*\d+/.test(translatedText) ||
                               /\d+\s+[A-Z][a-z]+ (St\.|Ave\.|Blvd\.)/.test(translatedText);
      if (hasNumberAtStart) {
        console.log('✅ Building/house number appears at start of address');
      } else {
        console.log('⚠️  Building/house number may not be at start');
      }

      // Check for proper abbreviations
      const hasProperAbbrev = /(St\.|Ave\.|Blvd\.|Microdistrict|District)/.test(translatedText);
      if (hasProperAbbrev) {
        console.log('✅ Uses proper English address abbreviations');
      } else {
        console.log('⚠️  May not use proper abbreviations');
      }

      // Check for inversion (not Russian order)
      const hasRussianOrder = /(Kazakhstan|Astana|Almaty).*?(St\.|Ave\.|Blvd\.|Microdistrict)/.test(translatedText);
      if (hasRussianOrder) {
        console.log('⚠️  WARNING: May still have Russian address order (Country/City before Street)');
      } else {
        console.log('✅ Address order appears inverted (Western format)');
      }

      console.log('');
      console.log(`Provider: ${result.provider}, Model: ${result.model}`);
      console.log('');

    } catch (error) {
      console.error('');
      console.error('❌ ERROR:');
      console.error('  ' + (error instanceof Error ? error.message : String(error)));
      if (error instanceof Error && error.stack) {
        console.error('');
        console.error('Stack trace:');
        console.error(error.stack);
      }
      console.log('');
    }

    // Add delay between requests to avoid rate limiting
    if (i < testCases.length - 1) {
      console.log('Waiting 2 seconds before next test...\n');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log('='.repeat(80));
  console.log('TEST COMPLETED');
  console.log('='.repeat(80));
}

// Run the test
testAddressLogic()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

