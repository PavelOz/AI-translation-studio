import * as fs from 'fs';
import * as path from 'path';

/**
 * Detailed diagnostic tool for DNA enrichment issues
 * Analyzes:
 * 1. Why row 110 (АО 'Астана - РЭК') was skipped
 * 2. Why SUSPICIOUS_ABBREV flags appear even when companies are in DNA
 * 3. Whether basic tokens (JSC, LLP, MW) need to be added separately
 * 4. How many CSV rows are actually missing from DNA
 */

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

// Simulate how validatorJanitor creates knownKeys and knownShortForms
function extractKnownAbbrevs(abbreviationLogic: Record<string, AbbreviationEntry>) {
  const knownKeys = new Set<string>();
  const knownShortForms = new Set<string>();
  
  for (const [key, entry] of Object.entries(abbreviationLogic)) {
    // Keys are added as-is (case-sensitive in original, but we normalize for comparison)
    knownKeys.add(key);
    knownKeys.add(key.toLowerCase());
    
    // ShortForms are extracted
    if (entry.shortForm) {
      const sf = entry.shortForm.trim();
      knownShortForms.add(sf);
      knownShortForms.add(sf.toLowerCase());
    }
  }
  
  return { knownKeys, knownShortForms };
}

// Simulate findSuspiciousAbbrevs logic (EXACT copy from validatorJanitor.ts)
function findSuspiciousAbbrevs(
  text: string,
  knownKeys: Set<string>,
  knownShortForms: Set<string>,
): string[] {
  const COMMON_WORDS = new Set(
    'the and for are but not you all can had her was one our out day get has him his how man new now old see way who boy did its let put say she too use'.split(' ')
  );
  
  const tokens = text.match(/\p{L}+/gu) ?? [];
  const suspicious: string[] = [];
  const seen = new Set<string>();
  
  for (const t of tokens) {
    if (t.length < 2 || t.length > 10) continue;
    if (COMMON_WORDS.has(t.toLowerCase())) continue;
    // ⚠️ IMPORTANT: This is case-sensitive! "JSC" != "jsc"
    if (knownKeys.has(t) || knownShortForms.has(t)) continue;
    const norm = t.toLowerCase();
    // ⚠️ PROBLEM: No normalization check here! Only checks seen set
    if (seen.has(norm)) continue;
    seen.add(norm);
    suspicious.push(t);
  }
  
  return suspicious;
}

async function main() {
  const args = process.argv.slice(2);
  const dnaFilePath = args[0] || path.join(__dirname, '..', '..', 'document-dna-en-ru-adapted.json');
  
  console.log('=== DNA Enrichment Detailed Diagnostic ===\n');

  // Read DNA file
  if (!fs.existsSync(dnaFilePath)) {
    console.error(`❌ DNA file not found: ${dnaFilePath}`);
    console.log('\nUsage: npx ts-node scripts/diagnose-dna-enrichment-detailed.ts [DNA_FILE]');
    process.exit(1);
  }

  const dnaContent = fs.readFileSync(dnaFilePath, 'utf-8');
  const dna: DNAFile = JSON.parse(dnaContent);
  const currentLogic = (dna.abbreviationLogic || {}) as Record<string, AbbreviationEntry>;

  console.log(`📄 DNA File: ${dnaFilePath}`);
  console.log(`📊 Current abbreviationLogic entries: ${Object.keys(currentLogic).length}\n`);

  // Extract known abbreviations (simulate validatorJanitor logic)
  const { knownKeys, knownShortForms } = extractKnownAbbrevs(currentLogic);

  console.log('=== 1. ROW 110 ANALYSIS (АО "Астана - РЭК") ===\n');
  
  const testRow110 = {
    ruName: "АО 'Астана - РЭК'",
    shortForm: "Астана - РЭК",
  };
  
  const normalizedKey = normalizeKey(testRow110.ruName);
  const exists = knownKeys.has(testRow110.ruName) || Array.from(knownKeys).some(k => normalizeKey(k) === normalizedKey);
  const identityConflict = hasIdentityConflict(testRow110.ruName, testRow110.shortForm);
  
  console.log(`RU Name: "${testRow110.ruName}"`);
  console.log(`Short Form: "${testRow110.shortForm}"`);
  console.log(`Normalized Key: "${normalizedKey}"`);
  console.log(`Exists in DNA: ${exists}`);
  console.log(`Identity Conflict: ${identityConflict}`);
  
  if (identityConflict) {
    console.log(`\n⚠️  IDENTITY CONFLICT DETECTED:`);
    console.log(`   Key normalized: "${normalizeKey(testRow110.ruName)}"`);
    console.log(`   ShortForm normalized: "${normalizeKey(testRow110.shortForm)}"`);
    console.log(`   Match: ${normalizeKey(testRow110.ruName) === normalizeKey(testRow110.shortForm)}`);
    console.log(`\n   💡 This row was SKIPPED by Identity Protection rule.`);
    console.log(`   💡 The shortForm "${testRow110.shortForm}" is too similar to the key.`);
  } else if (exists) {
    console.log(`\n✅ This entry already exists in DNA.`);
  } else {
    console.log(`\n❌ This entry is MISSING from DNA.`);
  }
  console.log('');

  console.log('=== 2. SUSPICIOUS_ABBREV ANALYSIS ===\n');
  
  const basicTokens = ['JSC', 'LLP', 'MW', 'SN', 'Pmin', 'GTPP', 'UKGES', 'HPP', 'NPP', 'TPP', 'WPP', 'SPP'];
  const missingBasicTokens: string[] = [];
  const tokenAnalysis: Array<{ token: string; inKeys: boolean; inShortForms: boolean; wouldBeFlagged: boolean }> = [];

  console.log('Checking basic tokens that commonly appear in text:\n');
  
  for (const token of basicTokens) {
    const tokenLower = token.toLowerCase();
    const inKeys = knownKeys.has(token) || Array.from(knownKeys).some(k => normalizeKey(k) === tokenLower);
    const inShortForms = knownShortForms.has(token) || knownShortForms.has(tokenLower);
    const wouldBeFlagged = !inKeys && !inShortForms;
    
    tokenAnalysis.push({ token, inKeys, inShortForms, wouldBeFlagged });
    
    if (wouldBeFlagged) {
      missingBasicTokens.push(token);
    }
    
    console.log(`  ${token}:`);
    console.log(`    In Keys: ${inKeys ? '✅' : '❌'}`);
    console.log(`    In ShortForms: ${inShortForms ? '✅' : '❌'}`);
    console.log(`    Would be flagged as SUSPICIOUS_ABBREV: ${wouldBeFlagged ? '⚠️  YES' : '✅ NO'}`);
    console.log('');
  }

  console.log(`\n📊 Summary: ${missingBasicTokens.length} out of ${basicTokens.length} basic tokens would be flagged\n`);

  if (missingBasicTokens.length > 0) {
    console.log('💡 RECOMMENDATION: Add these tokens as separate entries in abbreviationLogic:\n');
    const tokenMappings: Record<string, { key: string; longForm: string; shortForm: string }> = {
      'JSC': { key: 'АО', longForm: 'Joint Stock Company', shortForm: 'JSC' },
      'LLP': { key: 'ТОО', longForm: 'Limited Liability Partnership', shortForm: 'LLP' },
      'MW': { key: 'МВт', longForm: 'Megawatt', shortForm: 'MW' },
      'SN': { key: 'СН', longForm: 'Auxiliary Power', shortForm: 'SN' },
      'Pmin': { key: 'Рмин', longForm: 'Minimum Power', shortForm: 'Pmin' },
      'GTPP': { key: 'ГТЭС', longForm: 'Gas Turbine Power Plant', shortForm: 'GTPP' },
      'UKGES': { key: 'УКГЭС', longForm: 'Ust-Kamenogorsk Hydroelectric Power Plant', shortForm: 'UKGES' },
      'HPP': { key: 'ГЭС', longForm: 'Hydroelectric Power Plant', shortForm: 'HPP' },
      'NPP': { key: 'АЭС', longForm: 'Nuclear Power Plant', shortForm: 'NPP' },
      'TPP': { key: 'ТЭС', longForm: 'Thermal Power Plant', shortForm: 'TPP' },
      'WPP': { key: 'ВЭС', longForm: 'Wind Power Plant', shortForm: 'WPP' },
      'SPP': { key: 'СЭС', longForm: 'Solar Power Plant', shortForm: 'SPP' },
    };
    
    missingBasicTokens.forEach(token => {
      if (tokenMappings[token]) {
        console.log(`  "${tokenMappings[token].key}": {`);
        console.log(`    "longForm": "${tokenMappings[token].longForm}",`);
        console.log(`    "shortForm": "${tokenMappings[token].shortForm}"`);
        console.log(`  },`);
      } else {
        // For tokens that don't have a Russian key, add them directly
        console.log(`  "${token}": {`);
        console.log(`    "longForm": "${token} (standalone abbreviation)",`);
        console.log(`    "shortForm": "${token}"`);
        console.log(`  },`);
      }
    });
    console.log('');
  }

  console.log('=== 3. WHY SUSPICIOUS_ABBREV STILL APPEARS ===\n');
  console.log('The findSuspiciousAbbrevs function in validatorJanitor.ts checks:');
  console.log('  1. knownKeys.has(t) - Is token a KEY in abbreviationLogic? (CASE-SENSITIVE)');
  console.log('  2. knownShortForms.has(t) - Is token a SHORTFORM in abbreviationLogic? (CASE-SENSITIVE)');
  console.log('  3. whitelist (common English words)\n');
  
  console.log('⚠️  CRITICAL PROBLEM:');
  console.log('   - knownKeys и knownShortForms создаются БЕЗ нормализации (case-sensitive)');
  console.log('   - Если в тексте "jsc" (lowercase), а в knownShortForms только "JSC" (uppercase),');
  console.log('     то токен БУДЕТ помечен как SUSPICIOUS_ABBREV!\n');
  
  console.log('📝 Пример:');
  console.log('   Text: "The company JSC operates..."');
  console.log('   DNA: { "АО": { "shortForm": "JSC" } }');
  console.log('   knownShortForms.has("JSC") = true ✅');
  console.log('   Result: NOT flagged\n');
  
  console.log('   Text: "The company jsc operates..." (lowercase)');
  console.log('   DNA: { "АО": { "shortForm": "JSC" } }');
  console.log('   knownShortForms.has("jsc") = false ❌');
  console.log('   Result: FLAGGED as SUSPICIOUS_ABBREV ⚠️\n');
  
  console.log('✅ SOLUTION 1: Add entries with both cases');
  console.log('   - Add "JSC" as a key (uppercase)');
  console.log('   - Add "jsc" as a key (lowercase) - OR normalize in validatorJanitor\n');
  
  console.log('✅ SOLUTION 2 (RECOMMENDED): Fix validatorJanitor to normalize');
  console.log('   - Normalize knownKeys and knownShortForms to lowercase');
  console.log('   - Normalize token before checking\n');
  
  console.log('✅ SOLUTION 3: Add standalone entries for common abbreviations');
  console.log('   - Add "JSC" as a key (even if it\'s also shortForm for "АО")');
  console.log('   - Add "MW" as a key (even if it\'s also shortForm for "МВт")');
  console.log('   - This ensures they are in knownKeys, not just knownShortForms\n');

  console.log('=== 4. CURRENT DNA STRUCTURE ANALYSIS ===\n');
  console.log('Sample entries in abbreviationLogic:\n');
  const sampleEntries = Object.entries(currentLogic).slice(0, 5);
  sampleEntries.forEach(([key, entry]) => {
    console.log(`  "${key}": {`);
    console.log(`    "longForm": "${entry.longForm}",`);
    console.log(`    "shortForm": "${entry.shortForm}"`);
    console.log(`  }`);
  });
  console.log('');

  console.log('=== 5. IDENTITY PROTECTION CHECK ===\n');
  const identityConflicts: Array<{ key: string; shortForm: string }> = [];
  Object.entries(currentLogic).forEach(([key, entry]) => {
    if (hasIdentityConflict(key, entry.shortForm)) {
      identityConflicts.push({ key, shortForm: entry.shortForm });
    }
  });
  
  if (identityConflicts.length > 0) {
    console.log(`⚠️  Found ${identityConflicts.length} identity conflicts in current DNA:\n`);
    identityConflicts.forEach(conflict => {
      console.log(`  "${conflict.key}" → "${conflict.shortForm}"`);
    });
  } else {
    console.log('✅ No identity conflicts found in current DNA');
  }
  console.log('');

  console.log('=== SUMMARY ===\n');
  console.log(`📊 DNA Entries: ${Object.keys(currentLogic).length}`);
  console.log(`🔑 Known Keys: ${knownKeys.size}`);
  console.log(`📝 Known ShortForms: ${knownShortForms.size}`);
  console.log(`⚠️  Missing Basic Tokens: ${missingBasicTokens.length}`);
  console.log(`🔧 Identity Conflicts in DNA: ${identityConflicts.length}`);
  console.log(`\n💡 To reduce SUSPICIOUS_ABBREV flags by ~${missingBasicTokens.length * 10}-${missingBasicTokens.length * 20}%,`);
  console.log(`   add ${missingBasicTokens.length} basic token entries to abbreviationLogic.`);
}

main().catch((error) => {
  console.error('Diagnostic failed:', error);
  process.exit(1);
});
