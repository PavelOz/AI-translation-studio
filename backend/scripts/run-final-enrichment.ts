import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import * as iconv from 'iconv-lite';
import { getProvider } from '../src/ai/providers/registry';
import { logger } from '../src/utils/logger';

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

async function enrichAbbreviationLogic(
  currentLogic: Record<string, AbbreviationEntry>,
  csvRows: CSVRow[],
  useLLM: boolean = true,
  llmProvider: 'gemini' | 'openai' | 'yandex' | 'deepseek' = 'gemini',
): Promise<{
  enriched: Record<string, AbbreviationEntry>;
  added: number;
  skipped: number;
  conflicts: number;
  errors: Array<{ row: number; ruName: string; error: string }>;
}> {
  const enriched: Record<string, AbbreviationEntry> = { ...currentLogic };
  const existingKeys = new Set(Object.keys(enriched).map(normalizeKey));
  
  let added = 0;
  let skipped = 0;
  let conflicts = 0;
  const errors: Array<{ row: number; ruName: string; error: string }> = [];
  const BATCH_SIZE = 25;

  // Process CSV rows in batches
  for (let i = 0; i < csvRows.length; i += BATCH_SIZE) {
    const batch = csvRows.slice(i, Math.min(i + BATCH_SIZE, csvRows.length));
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(csvRows.length / BATCH_SIZE);
    
    console.log(`\n📦 Processing batch ${batchNumber}/${totalBatches} (rows ${i + 1}-${Math.min(i + BATCH_SIZE, csvRows.length)})`);

    const batchResults: Array<{
      row: number;
      ruName: string;
      shortForm: string;
      longForm: string;
      status: 'added' | 'skipped' | 'conflict' | 'error';
    }> = [];

    for (const row of batch) {
      const rowIndex = csvRows.indexOf(row) + 1;
      const ruName = row['Наименование энергопроизводящей организации']?.trim();
      const shortForm = row['Сокращенное наименование']?.trim();
      const enName = row['Наименование на английском']?.trim();

      // Skip invalid rows
      if (!ruName || !shortForm) {
        skipped++;
        batchResults.push({ row: rowIndex, ruName: ruName || 'N/A', shortForm: shortForm || 'N/A', longForm: '', status: 'skipped' });
        continue;
      }

      const normalizedKey = normalizeKey(ruName);

      // Conflict Resolution: Skip if key already exists
      if (existingKeys.has(normalizedKey)) {
        skipped++;
        batchResults.push({ row: rowIndex, ruName, shortForm, longForm: '', status: 'skipped' });
        continue;
      }

      // Identity Protection: Skip if key === shortForm
      if (hasIdentityConflict(ruName, shortForm)) {
        conflicts++;
        skipped++;
        batchResults.push({ row: rowIndex, ruName, shortForm, longForm: '', status: 'conflict' });
        continue;
      }

      // Determine longForm
      let longForm: string;
      let status: 'added' | 'error' = 'added';
      
      if (enName) {
        longForm = enName;
      } else if (useLLM) {
        try {
          longForm = await translateToEnglish(ruName, llmProvider);
          await new Promise(resolve => setTimeout(resolve, 600));
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push({ row: rowIndex, ruName, error: errorMsg });
          longForm = ruName; // Fallback
          status = 'error';
        }
      } else {
        longForm = ruName;
      }

      // Add to enriched logic
      enriched[ruName] = {
        longForm,
        shortForm,
      };
      existingKeys.add(normalizedKey);
      added++;
      
      batchResults.push({ row: rowIndex, ruName, shortForm, longForm, status });
    }

    // Show intermediate results after each batch
    console.log(`\n📊 Batch ${batchNumber} Results:`);
    console.log(`   Added: ${batchResults.filter(r => r.status === 'added').length}`);
    console.log(`   Skipped: ${batchResults.filter(r => r.status === 'skipped').length}`);
    console.log(`   Conflicts: ${batchResults.filter(r => r.status === 'conflict').length}`);
    console.log(`   Errors: ${batchResults.filter(r => r.status === 'error').length}`);
    
    if (batchResults.filter(r => r.status === 'added').length > 0) {
      console.log(`\n   ✅ Added entries (first 5):`);
      batchResults
        .filter(r => r.status === 'added')
        .slice(0, 5)
        .forEach(r => {
          console.log(`      Row ${r.row}: "${r.ruName}" → "${r.shortForm}" (${r.longForm})`);
        });
    }
    
    if (batchResults.filter(r => r.status === 'conflict').length > 0) {
      console.log(`\n   ⚠️  Identity Conflicts:`);
      batchResults
        .filter(r => r.status === 'conflict')
        .forEach(r => {
          console.log(`      Row ${r.row}: "${r.ruName}" → "${r.shortForm}" (key === shortForm)`);
        });
    }
    
    console.log(`\n   📈 Running totals: Added: ${added}, Skipped: ${skipped}, Conflicts: ${conflicts}, Errors: ${errors.length}`);

    // Delay between batches
    if (i + BATCH_SIZE < csvRows.length) {
      console.log(`   ⏳ Waiting 1s before next batch...\n`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return { enriched, added, skipped, conflicts, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const dnaFilePath = args[0] || path.join(__dirname, '..', '..', 'document-dna-en-ru-adapted.json');
  let csvFilePath = args[1];
  const useLLM = args[2] !== '--no-llm';
  const llmProvider = (args.find(arg => arg.startsWith('--provider='))?.split('=')[1] || 'gemini') as 'gemini' | 'openai' | 'yandex' | 'deepseek';
  const outputPath = args.find(arg => arg.startsWith('--output='))?.split('=')[1] || dnaFilePath;

  console.log('=== Final DNA Enrichment with Batch Processing ===\n');

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
  const csvRows = parseCSVBuffer(csvBuffer);
  console.log(`📊 CSV rows: ${csvRows.length}\n`);

  if (csvRows.length === 0) {
    console.error('❌ No valid CSV rows found');
    process.exit(1);
  }

  // Enrich abbreviationLogic
  console.log('🚀 Starting enrichment process...\n');
  const startTime = Date.now();
  
  const { enriched, added, skipped, conflicts, errors } = await enrichAbbreviationLogic(
    currentLogic,
    csvRows,
    useLLM,
    llmProvider,
  );

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Update DNA file
  dna.abbreviationLogic = enriched;
  fs.writeFileSync(outputPath, JSON.stringify(dna, null, 2), 'utf-8');

  // Final statistics
  console.log('\n=== FINAL STATISTICS ===\n');
  console.log(`⏱️  Duration: ${duration}s`);
  console.log(`📊 CSV Total: ${csvRows.length} rows`);
  console.log(`📝 DNA Before: ${Object.keys(currentLogic).length} entries`);
  console.log(`📝 DNA After: ${Object.keys(enriched).length} entries`);
  console.log(`✅ Added: ${added} entries`);
  console.log(`⏭️  Skipped: ${skipped} entries`);
  console.log(`⚠️  Identity Conflicts: ${conflicts}`);
  console.log(`❌ Errors: ${errors.length}`);
  
  if (errors.length > 0) {
    console.log('\n⚠️  Errors encountered:');
    errors.slice(0, 10).forEach(err => {
      console.log(`   Row ${err.row}: "${err.ruName}" - ${err.error}`);
    });
    if (errors.length > 10) {
      console.log(`   ... and ${errors.length - 10} more`);
    }
  }

  console.log('\n✅ Enrichment completed!');
  console.log(`📄 Updated DNA saved to: ${outputPath}`);
}

main().catch((error) => {
  console.error('❌ Script execution failed:', error);
  process.exit(1);
});
