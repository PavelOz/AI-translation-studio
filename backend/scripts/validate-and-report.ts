import * as fs from 'fs';
import * as path from 'path';
import { validateDnaContract, formatValidationReport } from '../src/services/validate-dna';
import { getTranslationDirection } from '../src/services/dnaPrompts';

interface AbbreviationEntry {
  longForm: string;
  shortForm: string;
}

interface DNAFile {
  abbreviationLogic?: Record<string, AbbreviationEntry>;
  [key: string]: unknown;
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function hasIdentityConflict(key: string, shortForm: string): boolean {
  return normalizeKey(key) === normalizeKey(shortForm);
}

async function main() {
  const args = process.argv.slice(2);
  const dnaFilePath = args[0] || path.join(__dirname, '..', '..', 'document-dna-en-ru-adapted.json');
  const sourceLocale = args[1] || 'ru';
  const targetLocale = args[2] || 'en';

  console.log('=== DNA Validation & Final Report ===\n');

  if (!fs.existsSync(dnaFilePath)) {
    console.error(`❌ DNA file not found: ${dnaFilePath}`);
    process.exit(1);
  }

  const dnaContent = fs.readFileSync(dnaFilePath, 'utf-8');
  const dna: DNAFile = JSON.parse(dnaContent);
  const abbreviationLogic = (dna.abbreviationLogic || {}) as Record<string, AbbreviationEntry>;

  console.log(`📄 DNA File: ${dnaFilePath}`);
  console.log(`📊 Total entries: ${Object.keys(abbreviationLogic).length}\n`);

  // Check Identity Conflicts
  console.log('=== 1. IDENTITY PROTECTION CHECK ===\n');
  const identityConflicts: Array<{ key: string; shortForm: string }> = [];
  Object.entries(abbreviationLogic).forEach(([key, entry]) => {
    if (hasIdentityConflict(key, entry.shortForm)) {
      identityConflicts.push({ key, shortForm: entry.shortForm });
    }
  });

  if (identityConflicts.length > 0) {
    console.log(`⚠️  Found ${identityConflicts.length} identity conflicts:\n`);
    identityConflicts.forEach(conflict => {
      console.log(`   "${conflict.key}" → "${conflict.shortForm}"`);
    });
  } else {
    console.log('✅ No identity conflicts found');
  }
  console.log('');

  // Check basic tokens
  console.log('=== 2. BASIC TOKENS CHECK ===\n');
  const basicTokens = ['JSC', 'LLP', 'MW', 'SN', 'Pmin', 'GTPP', 'UKGES', 'HPP', 'NPP', 'TPP', 'WPP', 'SPP'];
  const missingTokens: string[] = [];
  const foundTokens: string[] = [];

  for (const token of basicTokens) {
    const tokenLower = token.toLowerCase();
    const found = Object.keys(abbreviationLogic).some(key => {
      const keyNorm = normalizeKey(key);
      const shortForm = abbreviationLogic[key].shortForm?.toLowerCase();
      return keyNorm === tokenLower || shortForm === tokenLower;
    });

    if (found) {
      foundTokens.push(token);
    } else {
      missingTokens.push(token);
    }
  }

  console.log(`✅ Found: ${foundTokens.length}/${basicTokens.length} basic tokens`);
  if (foundTokens.length > 0) {
    console.log(`   ${foundTokens.join(', ')}`);
  }
  
  if (missingTokens.length > 0) {
    console.log(`\n❌ Missing: ${missingTokens.length}/${basicTokens.length} basic tokens`);
    console.log(`   ${missingTokens.join(', ')}`);
  } else {
    console.log('\n✅ All basic tokens are present!');
  }
  console.log('');

  // DNA Contract Validation
  console.log('=== 3. DNA CONTRACT VALIDATION ===\n');
  const direction = getTranslationDirection(sourceLocale, targetLocale);
  const validation = validateDnaContract(dna as any, direction);

  console.log(`Status: ${validation.status}`);
  console.log(`Issues: ${validation.issues.length}`);
  console.log(`Suggestions: ${validation.suggestions.length}\n`);

  if (validation.issues.length > 0) {
    console.log('Issues:');
    validation.issues.forEach((issue, i) => {
      console.log(`  ${i + 1}. [${issue.type.toUpperCase()}] ${issue.message}`);
      if ('path' in issue && issue.path) {
        console.log(`     Path: ${issue.path}`);
      }
    });
    console.log('');
  }

  if (validation.suggestions.length > 0) {
    console.log('Suggestions:');
    validation.suggestions.forEach((suggestion, i) => {
      console.log(`  ${i + 1}. ${suggestion}`);
    });
    console.log('');
  }

  // Full report
  console.log('=== 4. FULL VALIDATION REPORT ===\n');
  console.log(formatValidationReport(validation));
  console.log('');

  // Summary
  console.log('=== SUMMARY ===\n');
  console.log(`📊 Total Entries: ${Object.keys(abbreviationLogic).length}`);
  console.log(`⚠️  Identity Conflicts: ${identityConflicts.length}`);
  console.log(`✅ Basic Tokens: ${foundTokens.length}/${basicTokens.length}`);
  console.log(`📋 Validation Status: ${validation.status}`);
  console.log(`❌ Errors: ${validation.issues.filter(i => i.type === 'error').length}`);
  console.log(`⚠️  Warnings: ${validation.issues.filter(i => i.type === 'warning').length}`);
  console.log(`💡 Suggestions: ${validation.suggestions.length}`);

  if (identityConflicts.length === 0 && missingTokens.length === 0 && validation.status === 'OK') {
    console.log('\n✅ DNA is ready for production!');
  } else {
    console.log('\n⚠️  DNA needs attention before production use.');
  }
}

main().catch((error) => {
  console.error('Validation failed:', error);
  process.exit(1);
});
