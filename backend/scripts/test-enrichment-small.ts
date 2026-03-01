import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import * as iconv from 'iconv-lite';
import { getProvider } from '../src/ai/providers/registry';
import { logger } from '../src/utils/logger';

/**
 * Test enrichment with first 10 rows to show intermediate results
 */

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

async function translateToEnglish(
  ruTerm: string,
  provider: 'gemini' | 'openai' | 'yandex' | 'deepseek' = 'gemini',
): Promise<string> {
  try {
    const aiProvider = getProvider(provider);
    const model = provider === 'gemini' ? 'gemini-2.0-flash' : 
                  provider === 'openai' ? 'gpt-4o-mini' :
                  provider === 'yandex' ? 'yandexgpt-lite' : 'deepseek-chat';

    const prompt = `You are a technical translator specializing in power industry terminology. 
Translate this power plant or energy organization name from Russian to English. 
Return ONLY the English translation, no explanations.

Term: ${ruTerm}

Translation:`;

    const response = await aiProvider.callModel({
      prompt,
      systemPrompt: 'You are a technical translator. Return only the translation, no explanations.',
      model,
      temperature: 0.3,
      maxTokens: 100,
      segments: [{
        segmentId: 'temp',
        sourceText: ruTerm,
      }],
    });

    const translation = (response.outputText || '').trim();
    const cleaned = translation
      .replace(/^["']|["']$/g, '')
      .replace(/^Translation:\s*/i, '')
      .split('\n')[0]
      .trim();

    return cleaned || ruTerm;
  } catch (error) {
    logger.warn({ error, ruTerm }, 'LLM translation failed, using original term');
    return ruTerm;
  }
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
        from_line: 2, // Skip first line (document header), use second line as column headers
      }) as CSVRow[];
      
      if (records.length > 0) {
        const firstRecord = records[0];
        const keys = Object.keys(firstRecord);
        const hasRequiredColumns = 
          keys.some(key => {
            const lowerKey = key.toLowerCase();
            return lowerKey.includes('наименование') && (
              lowerKey.includes('энергопроизводящей') ||
              lowerKey.includes('организации') ||
              lowerKey.includes('эпо') ||
              lowerKey.includes('электрических станций')
            );
          }) &&
          keys.some(key => {
            const lowerKey = key.toLowerCase();
            return lowerKey.includes('сокращен') || 
                   lowerKey.includes('аббревиатура') ||
                   (lowerKey.includes('наименование') && lowerKey.includes('электрических станций'));
          });
        
        if (hasRequiredColumns) {
          console.log(`✅ CSV parsed successfully with delimiter: "${delimiter}"`);
          console.log(`📋 Columns found: ${keys.join(', ')}`);
          break;
        } else {
          console.log(`⚠️  CSV parsed but missing required columns, trying next delimiter`);
          console.log(`   Found columns: ${keys.join(', ')}`);
        }
      }
    } catch (error) {
      continue;
    }
  }
  
  const validRecords = records
    .map(row => {
      // Find columns by partial name match (support multiple variations)
      const ruNameKey = Object.keys(row).find(key => {
        const lowerKey = key.toLowerCase();
        return lowerKey.includes('наименование') && (
          lowerKey.includes('энергопроизводящей') ||
          lowerKey.includes('организации') ||
          lowerKey.includes('эпо') ||
          lowerKey.includes('электрических станций')
        );
      });
      
      const shortFormKey = Object.keys(row).find(key => {
        const lowerKey = key.toLowerCase();
        return lowerKey.includes('сокращен') || 
               lowerKey.includes('аббревиатура') ||
               (lowerKey.includes('наименование') && lowerKey.includes('электрических станций'));
      });
      
      const enNameKey = Object.keys(row).find(key => 
        key.toLowerCase().includes('английск') || key.toLowerCase().includes('english')
      );
      
      if (!ruNameKey || !shortFormKey) {
        console.log(`⚠️  Row missing required columns. Available keys: ${Object.keys(row).join(', ')}`);
        return null;
      }
      
      const ruName = String((row as any)[ruNameKey] || '').trim();
      const shortForm = String((row as any)[shortFormKey] || '').trim();
      
      // Log the row data for debugging
      console.log(`📝 Found row: "${ruName}" → "${shortForm}"`);
      
      return {
        'Наименование энергопроизводящей организации': ruName,
        'Сокращенное наименование': shortForm,
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
  const useLLM = args[2] !== '--no-llm';
  const llmProvider = (args.find(arg => arg.startsWith('--provider='))?.split('=')[1] || 'gemini') as 'gemini' | 'openai' | 'yandex' | 'deepseek';
  const testRows = parseInt(args.find(arg => arg.startsWith('--test-rows='))?.split('=')[1] || '10');

  console.log('=== Test DNA Enrichment (Showing Intermediate Results) ===\n');

  // Read DNA file
  if (!fs.existsSync(dnaFilePath)) {
    console.error(`❌ DNA file not found: ${dnaFilePath}`);
    process.exit(1);
  }

  const dnaContent = fs.readFileSync(dnaFilePath, 'utf-8');
  const dna: DNAFile = JSON.parse(dnaContent);
  const currentLogic = (dna.abbreviationLogic || {}) as Record<string, AbbreviationEntry>;

  console.log(`📄 DNA File: ${dnaFilePath}`);
  console.log(`📊 Current entries: ${Object.keys(currentLogic).length}\n`);

  // Find CSV file
  if (!csvFilePath) {
    const possiblePaths = [
      path.join(__dirname, '..', '..', 'Перечень аттестованных ЭПО 2025.xlsx - Лист1.csv'),
      path.join(__dirname, '..', '..', 'Перечень аттестованных ЭПО 2025.csv'),
      path.join(__dirname, '..', 'data', 'Перечень аттестованных ЭПО 2025.xlsx - Лист1.csv'),
    ];
    
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        csvFilePath = possiblePath;
        break;
      }
    }
  }

  if (!csvFilePath || !fs.existsSync(csvFilePath)) {
    console.error('❌ CSV file not found. Please provide path as second argument.');
    process.exit(1);
  }

  console.log(`📄 CSV File: ${csvFilePath}`);
  const csvBuffer = fs.readFileSync(csvFilePath);
  const allCsvRows = parseCSVBuffer(csvBuffer);
  
  // Take only first N rows for testing
  const csvRows = allCsvRows.slice(0, testRows);
  console.log(`📊 Total CSV rows: ${allCsvRows.length}`);
  console.log(`🧪 Testing with first ${testRows} rows\n`);

  if (csvRows.length === 0) {
    console.error('❌ No valid CSV rows found');
    process.exit(1);
  }

  // Enrich abbreviationLogic
  console.log('🚀 Starting enrichment process...\n');
  const startTime = Date.now();
  
  const enriched: Record<string, AbbreviationEntry> = { ...currentLogic };
  const existingKeys = new Set(Object.keys(enriched).map(normalizeKey));
  
  let added = 0;
  let skipped = 0;
  let conflicts = 0;
  const errors: Array<{ row: number; ruName: string; error: string }> = [];

  // Process rows one by one with detailed output
  for (let i = 0; i < csvRows.length; i++) {
    const row = csvRows[i];
    const rowIndex = i + 1;
    const ruName = row['Наименование энергопроизводящей организации']?.trim();
    const shortForm = row['Сокращенное наименование']?.trim();
    const enName = row['Наименование на английском']?.trim();

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📝 Processing Row ${rowIndex}/${csvRows.length}`);
    console.log(`   RU Name: "${ruName}"`);
    console.log(`   Short Form: "${shortForm}"`);
    console.log(`   EN Name: ${enName || 'N/A (will translate)'}`);

    // Skip invalid rows
    if (!ruName || !shortForm) {
      console.log(`   ❌ SKIPPED: Missing required fields`);
      skipped++;
      continue;
    }

    const normalizedKey = normalizeKey(ruName);

    // Conflict Resolution: Skip if key already exists
    if (existingKeys.has(normalizedKey)) {
      console.log(`   ⏭️  SKIPPED: Key already exists in DNA (expert edit protection)`);
      skipped++;
      continue;
    }

    // Identity Protection: Skip if key === shortForm
    if (hasIdentityConflict(ruName, shortForm)) {
      console.log(`   ⚠️  SKIPPED: Identity conflict (key === shortForm)`);
      conflicts++;
      skipped++;
      continue;
    }

    // Determine longForm
    let longForm: string;
    if (enName) {
      longForm = enName;
      console.log(`   ✅ Using provided EN name: "${longForm}"`);
    } else if (useLLM) {
      try {
        console.log(`   🤖 Translating via LLM (${llmProvider})...`);
        longForm = await translateToEnglish(ruName, llmProvider);
        console.log(`   ✅ Translation: "${longForm}"`);
        await new Promise(resolve => setTimeout(resolve, 600));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ row: rowIndex, ruName, error: errorMsg });
        longForm = ruName;
        console.log(`   ⚠️  Translation failed, using RU name as fallback`);
      }
    } else {
      longForm = ruName;
      console.log(`   ℹ️  Using RU name (LLM disabled)`);
    }

    // Add to enriched logic
    enriched[ruName] = {
      longForm,
      shortForm,
    };
    existingKeys.add(normalizedKey);
    added++;
    
    console.log(`   ✅ ADDED to DNA: "${ruName}" → "${shortForm}" (${longForm})`);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Show intermediate results
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`\n📊 INTERMEDIATE RESULTS (First ${testRows} rows):\n`);
  console.log(`⏱️  Duration: ${duration}s`);
  console.log(`📝 Processed: ${csvRows.length} rows`);
  console.log(`✅ Added: ${added} entries`);
  console.log(`⏭️  Skipped: ${skipped} entries`);
  console.log(`⚠️  Identity Conflicts: ${conflicts}`);
  console.log(`❌ Errors: ${errors.length}`);
  
  if (errors.length > 0) {
    console.log(`\n⚠️  Errors encountered:`);
    errors.forEach(err => {
      console.log(`   Row ${err.row}: "${err.ruName}" - ${err.error}`);
    });
  }

  console.log(`\n📈 DNA Status:`);
  console.log(`   Before: ${Object.keys(currentLogic).length} entries`);
  console.log(`   After: ${Object.keys(enriched).length} entries`);
  console.log(`   New: ${Object.keys(enriched).length - Object.keys(currentLogic).length} entries`);

  // Show sample of added entries
  const newEntries = Object.keys(enriched).filter(key => !currentLogic[key]);
  if (newEntries.length > 0) {
    console.log(`\n✅ Sample of new entries (first 5):`);
    newEntries.slice(0, 5).forEach(key => {
      const entry = enriched[key];
      console.log(`   "${key}": {`);
      console.log(`     "longForm": "${entry.longForm}",`);
      console.log(`     "shortForm": "${entry.shortForm}"`);
      console.log(`   }`);
    });
  }

  console.log(`\n💡 To process all ${allCsvRows.length} rows, run:`);
  console.log(`   npx ts-node scripts/run-final-enrichment.ts ${dnaFilePath} ${csvFilePath}`);
}

main().catch((error) => {
  console.error('❌ Script execution failed:', error);
  process.exit(1);
});
