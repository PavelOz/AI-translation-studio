import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import * as iconv from 'iconv-lite';

interface CSVRow {
  'Наименование энергопроизводящей организации': string;
  'Сокращенное наименование': string;
  'Наименование на английском'?: string;
}

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

function parseCSVBuffer(csvBuffer: Buffer): CSVRow[] {
  let csvContent: string | null = null;
  const encodings: BufferEncoding[] = ['utf-8', 'latin1', 'utf-16le'];
  
  for (const encoding of encodings) {
    try {
      const testContent = csvBuffer.toString(encoding);
      if (testContent && !testContent.includes('я┐╜') && testContent.length > 0) {
        if (testContent.includes('Наименование') || testContent.includes('Сокращенное') || 
            testContent.includes('энергопроизводящей') || testContent.includes('организации')) {
          csvContent = testContent;
          break;
        }
      }
    } catch (e) {
      continue;
    }
  }
  
  if (!csvContent) {
    try {
      csvContent = iconv.decode(csvBuffer, 'win1251');
    } catch {
      csvContent = csvBuffer.toString('latin1');
    }
  }
  
  const delimiters = [';', ',', '\t'];
  let records: CSVRow[] = [];
  
  for (const delimiter of delimiters) {
    try {
      records = parse(csvContent!, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
        delimiter,
        quote: '"',
        escape: '"',
        relax_quotes: true,
        skip_records_with_error: true,
      }) as CSVRow[];
      
      if (records.length > 0) {
        const firstRecord = records[0];
        const hasRequiredColumns = 
          Object.keys(firstRecord).some(key => 
            key.includes('Наименование') && key.includes('энергопроизводящей')
          ) &&
          Object.keys(firstRecord).some(key => 
            key.includes('Сокращенное') || key.includes('сокращен')
          );
        
        if (hasRequiredColumns) {
          break;
        }
      }
    } catch (error) {
      continue;
    }
  }
  
  const validRecords = records
    .map(row => {
      const ruNameKey = Object.keys(row).find(key => 
        key.toLowerCase().includes('наименование') && 
        (key.toLowerCase().includes('энергопроизводящей') || key.toLowerCase().includes('организации'))
      );
      const shortFormKey = Object.keys(row).find(key => 
        key.toLowerCase().includes('сокращен') || key.toLowerCase().includes('аббревиатура')
      );
      const enNameKey = Object.keys(row).find(key => 
        key.toLowerCase().includes('английск') || key.toLowerCase().includes('english')
      );
      
      if (!ruNameKey || !shortFormKey) {
        return null;
      }
      
      return {
        'Наименование энергопроизводящей организации': String((row as any)[ruNameKey] || '').trim(),
        'Сокращенное наименование': String((row as any)[shortFormKey] || '').trim(),
        'Наименование на английском': enNameKey ? String((row as any)[enNameKey] || '').trim() : undefined,
      } as CSVRow;
    })
    .filter((row): row is CSVRow => 
      row !== null && 
      row['Наименование энергопроизводящей организации'] !== '' &&
      row['Сокращенное наименование'] !== ''
    );

  return validRecords;
}

async function main() {
  const args = process.argv.slice(2);
  const dnaFilePath = args[0] || path.join(__dirname, '..', '..', 'document-dna-en-ru-adapted.json');
  let csvFilePath = args[1];
  
  // Try to find CSV file if not provided
  if (!csvFilePath) {
    const possiblePaths = [
      path.join(__dirname, '..', '..', 'Перечень аттестованных ЭПО 2025.xlsx - Лист1.csv'),
      path.join(__dirname, '..', '..', 'Перечень аттестованных ЭПО 2025.csv'),
      path.join(__dirname, '..', '..', 'data', 'Перечень аттестованных ЭПО 2025.xlsx - Лист1.csv'),
    ];
    
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        csvFilePath = possiblePath;
        break;
      }
    }
  }
  
  if (!csvFilePath) {
    console.error('❌ CSV file not found. Please provide path as second argument:');
    console.error('   npx ts-node scripts/diagnose-dna-enrichment.ts [DNA_FILE] [CSV_FILE]');
    process.exit(1);
  }

  console.log('=== DNA Enrichment Diagnostic Tool ===\n');

  // Read DNA file
  if (!fs.existsSync(dnaFilePath)) {
    console.error(`❌ DNA file not found: ${dnaFilePath}`);
    process.exit(1);
  }

  const dnaContent = fs.readFileSync(dnaFilePath, 'utf-8');
  const dna: DNAFile = JSON.parse(dnaContent);
  const currentLogic = (dna.abbreviationLogic || {}) as Record<string, AbbreviationEntry>;

  console.log(`📄 DNA File: ${dnaFilePath}`);
  console.log(`📊 Current abbreviationLogic entries: ${Object.keys(currentLogic).length}\n`);

  // Read CSV
  if (!fs.existsSync(csvFilePath)) {
    console.error(`❌ CSV file not found: ${csvFilePath}`);
    process.exit(1);
  }

  const csvBuffer = fs.readFileSync(csvFilePath);
  const csvRows = parseCSVBuffer(csvBuffer);

  console.log(`📄 CSV File: ${csvFilePath}`);
  console.log(`📊 Total CSV rows: ${csvRows.length}\n`);

  // Analyze each CSV row
  const existingKeys = new Set(Object.keys(currentLogic).map(normalizeKey));
  const existingShortForms = new Set(
    Object.values(currentLogic)
      .map(entry => entry.shortForm?.trim().toLowerCase())
      .filter(Boolean)
  );

  const analysis = {
    total: csvRows.length,
    found: 0,
    missing: 0,
    identityConflicts: [] as Array<{ row: number; ruName: string; shortForm: string }>,
    skipped: [] as Array<{ row: number; ruName: string; reason: string }>,
    missingEntries: [] as Array<{ row: number; ruName: string; shortForm: string }>,
    row110: null as { ruName: string; shortForm: string; enName?: string; status: string } | null,
  };

  // Check for basic tokens that might be flagged as SUSPICIOUS_ABBREV
  const basicTokens = ['JSC', 'LLP', 'MW', 'SN', 'Pmin', 'GTPP', 'UKGES', 'HPP', 'NPP', 'TPP', 'WPP', 'SPP'];
  const missingBasicTokens: string[] = [];

  for (const token of basicTokens) {
    const tokenLower = token.toLowerCase();
    const foundAsKey = Array.from(existingKeys).some(k => normalizeKey(k) === tokenLower);
    const foundAsShortForm = existingShortForms.has(tokenLower);
    
    if (!foundAsKey && !foundAsShortForm) {
      missingBasicTokens.push(token);
    }
  }

  console.log('=== 1. IDENTITY PROTECTION ANALYSIS ===\n');

  for (let i = 0; i < csvRows.length; i++) {
    const row = csvRows[i];
    const ruName = row['Наименование энергопроизводящей организации']?.trim();
    const shortForm = row['Сокращенное наименование']?.trim();
    const enName = row['Наименование на английском']?.trim();

    if (!ruName || !shortForm) {
      analysis.skipped.push({ row: i + 1, ruName: ruName || 'N/A', reason: 'Missing required fields' });
      continue;
    }

    // Check row 110 specifically
    if (i + 1 === 110) {
      const normalizedKey = normalizeKey(ruName);
      const exists = existingKeys.has(normalizedKey);
      const identityConflict = hasIdentityConflict(ruName, shortForm);
      
      analysis.row110 = {
        ruName,
        shortForm,
        enName,
        status: identityConflict 
          ? 'IDENTITY_CONFLICT' 
          : exists 
            ? 'ALREADY_EXISTS' 
            : 'MISSING',
      };
    }

    const normalizedKey = normalizeKey(ruName);
    const exists = existingKeys.has(normalizedKey);

    if (exists) {
      analysis.found++;
    } else {
      analysis.missing++;
      
      if (hasIdentityConflict(ruName, shortForm)) {
        analysis.identityConflicts.push({ row: i + 1, ruName, shortForm });
      } else {
        analysis.missingEntries.push({ row: i + 1, ruName, shortForm });
      }
    }
  }

  console.log(`✅ Found in DNA: ${analysis.found}`);
  console.log(`❌ Missing from DNA: ${analysis.missing}`);
  console.log(`⚠️  Identity Conflicts: ${analysis.identityConflicts.length}`);
  console.log(`📝 Skipped (invalid): ${analysis.skipped.length}\n`);

  if (analysis.row110) {
    console.log('=== ROW 110 ANALYSIS (АО "Астана - РЭК") ===\n');
    console.log(`RU Name: "${analysis.row110.ruName}"`);
    console.log(`Short Form: "${analysis.row110.shortForm}"`);
    console.log(`EN Name: "${analysis.row110.enName || 'N/A'}"`);
    console.log(`Status: ${analysis.row110.status}`);
    
    if (analysis.row110.status === 'IDENTITY_CONFLICT') {
      console.log(`\n⚠️  IDENTITY CONFLICT DETECTED:`);
      console.log(`   Key: "${analysis.row110.ruName}"`);
      console.log(`   ShortForm: "${analysis.row110.shortForm}"`);
      console.log(`   Normalized: "${normalizeKey(analysis.row110.ruName)}" === "${normalizeKey(analysis.row110.shortForm)}"`);
      console.log(`\n   This row was SKIPPED by Identity Protection rule.`);
    } else if (analysis.row110.status === 'ALREADY_EXISTS') {
      console.log(`\n✅ This entry already exists in DNA (expert edit protection).`);
    } else {
      console.log(`\n❌ This entry is MISSING from DNA and should be added.`);
    }
    console.log('');
  }

  if (analysis.identityConflicts.length > 0) {
    console.log('=== IDENTITY CONFLICTS (First 10) ===\n');
    analysis.identityConflicts.slice(0, 10).forEach(conflict => {
      console.log(`Row ${conflict.row}: "${conflict.ruName}" → "${conflict.shortForm}"`);
    });
    if (analysis.identityConflicts.length > 10) {
      console.log(`... and ${analysis.identityConflicts.length - 10} more`);
    }
    console.log('');
  }

  console.log('=== 2. SUSPICIOUS_ABBREV ANALYSIS ===\n');
  console.log('Basic tokens that should be in abbreviationLogic to avoid SUSPICIOUS_ABBREV flags:\n');
  
  if (missingBasicTokens.length > 0) {
    console.log(`❌ Missing basic tokens (${missingBasicTokens.length}):`);
    missingBasicTokens.forEach(token => {
      console.log(`   - ${token}`);
    });
    console.log('\n💡 RECOMMENDATION: Add these as separate entries in abbreviationLogic:');
    console.log('   Example:');
    missingBasicTokens.slice(0, 3).forEach(token => {
      const mapping: Record<string, { key: string; longForm: string; shortForm: string }> = {
        'JSC': { key: 'АО', longForm: 'Joint Stock Company', shortForm: 'JSC' },
        'LLP': { key: 'ТОО', longForm: 'Limited Liability Partnership', shortForm: 'LLP' },
        'MW': { key: 'МВт', longForm: 'Megawatt', shortForm: 'MW' },
        'SN': { key: 'СН', longForm: 'Auxiliary Power', shortForm: 'SN' },
        'Pmin': { key: 'Рмин', longForm: 'Minimum Power', shortForm: 'Pmin' },
      };
      
      if (mapping[token]) {
        console.log(`   "${mapping[token].key}": { "longForm": "${mapping[token].longForm}", "shortForm": "${mapping[token].shortForm}" }`);
      }
    });
  } else {
    console.log('✅ All basic tokens are present in abbreviationLogic');
  }

  console.log('\n=== 3. WHY SUSPICIOUS_ABBREV STILL APPEARS ===\n');
  console.log('The findSuspiciousAbbrevs function checks:');
  console.log('1. knownKeys - keys from abbreviationLogic');
  console.log('2. knownShortForms - shortForm values from abbreviationLogic');
  console.log('3. whitelist - COMMON_WORDS (the, and, for, etc.)\n');
  
  console.log('If a token like "JSC" appears in text but is only in shortForm of another entry,');
  console.log('it will be flagged as SUSPICIOUS_ABBREV if it appears standalone.\n');
  
  console.log('💡 SOLUTION: Add standalone entries for common abbreviations:');
  console.log('   - "JSC" should be a key (even if it\'s also shortForm for "АО")');
  console.log('   - "MW" should be a key (even if it\'s also shortForm for "МВт")');
  console.log('   - "LLP" should be a key (even if it\'s also shortForm for "ТОО")\n');

  console.log('=== 4. MISSING ENTRIES FROM CSV ===\n');
  console.log(`Total missing entries: ${analysis.missingEntries.length}`);
  console.log(`\nFirst 20 missing entries:\n`);
  analysis.missingEntries.slice(0, 20).forEach(entry => {
    console.log(`Row ${entry.row}: "${entry.ruName}" → "${entry.shortForm}"`);
  });
  if (analysis.missingEntries.length > 20) {
    console.log(`... and ${analysis.missingEntries.length - 20} more`);
  }

  console.log('\n=== SUMMARY ===\n');
  console.log(`📊 CSV Rows: ${analysis.total}`);
  console.log(`✅ In DNA: ${analysis.found}`);
  console.log(`❌ Missing: ${analysis.missing}`);
  console.log(`⚠️  Identity Conflicts: ${analysis.identityConflicts.length}`);
  console.log(`🔧 Missing Basic Tokens: ${missingBasicTokens.length}`);
  console.log(`\n💡 To fix SUSPICIOUS_ABBREV issues, add ${missingBasicTokens.length} basic token entries.`);
}

main().catch((error) => {
  console.error('Diagnostic failed:', error);
  process.exit(1);
});
