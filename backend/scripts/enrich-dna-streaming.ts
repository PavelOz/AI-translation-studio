import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { getProvider } from '../src/ai/providers/registry';
import { logger } from '../src/utils/logger';
import { env } from '../src/utils/env';

interface CSVRow {
  'Наименование энергопроизводящей организации': string;
  'Сокращенное наименование': string;
  'Наименование на английском'?: string; // Optional EN column
}

interface AbbreviationEntry {
  longForm: string;
  shortForm: string;
}

interface DNAFile {
  abbreviationLogic?: Record<string, AbbreviationEntry>;
  [key: string]: unknown;
}

/**
 * Normalize key for comparison (case-insensitive, trimmed)
 */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Check for identity conflict (key === shortForm)
 */
function hasIdentityConflict(key: string, shortForm: string): boolean {
  return normalizeKey(key) === normalizeKey(shortForm);
}

/**
 * Translate Russian term to English using LLM
 */
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
    
    // Clean up response (remove quotes, explanations, etc.)
    const cleaned = translation
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes
      .replace(/^Translation:\s*/i, '') // Remove "Translation:" prefix
      .split('\n')[0] // Take first line only
      .trim();

    return cleaned || ruTerm; // Fallback to original if translation fails
  } catch (error) {
    logger.warn({ error, ruTerm }, 'LLM translation failed, using original term');
    return ruTerm;
  }
}

/**
 * Process CSV file and extract power plant data
 */
function parseCSVFile(csvPath: string): CSVRow[] {
  try {
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    
    // Parse CSV with headers
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true, // Handle UTF-8 BOM
      relax_column_count: true, // Allow inconsistent column counts
    }) as CSVRow[];

    // Filter out rows with missing required columns
    const validRecords = records.filter(row => 
      row['Наименование энергопроизводящей организации'] && 
      row['Сокращенное наименование']
    );

    logger.info({ 
      total: records.length, 
      valid: validRecords.length 
    }, 'CSV records parsed');
    
    return validRecords;
  } catch (error) {
    logger.error({ error, csvPath }, 'Failed to parse CSV file');
    throw error;
  }
}

/**
 * Enrich abbreviationLogic with CSV data (with batch processing and state saving)
 */
async function enrichAbbreviationLogic(
  currentLogic: Record<string, AbbreviationEntry>,
  csvRows: CSVRow[],
  useLLM: boolean = true,
  llmProvider: 'gemini' | 'openai' | 'yandex' | 'deepseek' = 'gemini',
  stateFile?: string, // Optional state file path for resuming
): Promise<{
  enriched: Record<string, AbbreviationEntry>;
  added: number;
  skipped: number;
  conflicts: number;
  processed: number;
}> {
  const enriched: Record<string, AbbreviationEntry> = { ...currentLogic };
  const existingKeys = new Set(Object.keys(enriched).map(normalizeKey));
  
  let added = 0;
  let skipped = 0;
  let conflicts = 0;
  let startIndex = 0;
  const BATCH_SIZE = 25; // Process 25 rows at a time

  // Load state if resuming
  if (stateFile && fs.existsSync(stateFile)) {
    try {
      const stateContent = fs.readFileSync(stateFile, 'utf-8');
      const state = JSON.parse(stateContent);
      startIndex = state.lastProcessedIndex + 1 || 0;
      logger.info({ startIndex }, 'Resuming from saved state');
    } catch (err) {
      logger.warn({ error: err }, 'Failed to load state, starting from beginning');
    }
  }

  // Process CSV rows in batches
  for (let i = startIndex; i < csvRows.length; i += BATCH_SIZE) {
    const batch = csvRows.slice(i, Math.min(i + BATCH_SIZE, csvRows.length));
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(csvRows.length / BATCH_SIZE);
    
    logger.info({ 
      batch: batchNumber, 
      totalBatches, 
      current: i + 1, 
      total: csvRows.length 
    }, `Processing batch ${batchNumber}/${totalBatches}`);

    for (const row of batch) {
      const rowIndex = csvRows.indexOf(row);
      const ruName = row['Наименование энергопроизводящей организации']?.trim();
      const shortForm = row['Сокращенное наименование']?.trim();
      const enName = row['Наименование на английском']?.trim();

      // Skip invalid rows
      if (!ruName || !shortForm) {
        skipped++;
        continue;
      }

      const normalizedKey = normalizeKey(ruName);

      // Conflict Resolution: Skip if key already exists (protect expert edits)
      if (existingKeys.has(normalizedKey)) {
        logger.debug({ ruName, rowIndex: rowIndex + 1 }, 'Key already exists, skipping (expert edit protection)');
        skipped++;
        continue;
      }

      // Identity Protection: Skip if key === shortForm
      if (hasIdentityConflict(ruName, shortForm)) {
        logger.warn({ ruName, shortForm, rowIndex: rowIndex + 1 }, 'Identity conflict detected, skipping');
        conflicts++;
        skipped++;
        continue;
      }

      // Determine longForm (use EN column if available, otherwise translate)
      let longForm: string;
      if (enName) {
        longForm = enName;
      } else if (useLLM) {
        try {
          logger.info({ ruName, rowIndex: rowIndex + 1 }, 'Translating term using LLM');
          longForm = await translateToEnglish(ruName, llmProvider);
          // Add delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 600));
        } catch (error) {
          logger.error({ error, ruName, rowIndex: rowIndex + 1 }, 'LLM translation failed, using Russian name');
          longForm = ruName;
        }
      } else {
        // Fallback: use Russian name if translation is disabled
        longForm = ruName;
      }

      // Add to enriched logic
      enriched[ruName] = {
        longForm,
        shortForm,
      };
      existingKeys.add(normalizedKey);
      added++;

      logger.debug({ ruName, shortForm, longForm, rowIndex: rowIndex + 1 }, 'Added abbreviation entry');
    }

    // Save state after each batch
    if (stateFile) {
      try {
        const state = {
          lastProcessedIndex: i + batch.length - 1,
          added,
          skipped,
          conflicts,
          timestamp: new Date().toISOString(),
        };
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
        logger.info({ state }, 'State saved');
      } catch (err) {
        logger.warn({ error: err }, 'Failed to save state');
      }
    }

    // Small delay between batches
    if (i + BATCH_SIZE < csvRows.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Clean up state file on completion
  if (stateFile && fs.existsSync(stateFile)) {
    try {
      fs.unlinkSync(stateFile);
      logger.info('State file cleaned up');
    } catch (err) {
      logger.warn({ error: err }, 'Failed to clean up state file');
    }
  }

  return { enriched, added, skipped, conflicts, processed: csvRows.length };
}

/**
 * Main execution function
 */
async function main() {
  const args = process.argv.slice(2);
  
  // Parse command line arguments
  const dnaFilePath = args[0] || path.join(__dirname, '..', '..', 'document-dna-en-ru-adapted.json');
  const csvFilePath = args[1] || path.join(__dirname, '..', '..', 'Перечень аттестованных ЭПО 2025.xlsx - Лист1.csv');
  const useLLM = args[2] !== '--no-llm';
  const llmProvider = (args.find(arg => arg.startsWith('--provider='))?.split('=')[1] || 'gemini') as 'gemini' | 'openai' | 'yandex' | 'deepseek';
  const outputPath = args.find(arg => arg.startsWith('--output='))?.split('=')[1] || dnaFilePath;

  logger.info({ dnaFilePath, csvFilePath, useLLM, llmProvider }, 'Starting DNA enrichment');

  // Read DNA file
  if (!fs.existsSync(dnaFilePath)) {
    logger.error({ dnaFilePath }, 'DNA file not found');
    process.exit(1);
  }

  const dnaContent = fs.readFileSync(dnaFilePath, 'utf-8');
  const dna: DNAFile = JSON.parse(dnaContent);

  // Read and parse CSV
  if (!fs.existsSync(csvFilePath)) {
    logger.warn({ csvFilePath }, 'CSV file not found, using only existing DNA data');
    console.log(JSON.stringify(dna.abbreviationLogic || {}, null, 2));
    process.exit(0);
  }

  const csvRows = parseCSVFile(csvFilePath);
  
  if (csvRows.length === 0) {
    logger.warn('No CSV rows found');
    console.log(JSON.stringify(dna.abbreviationLogic || {}, null, 2));
    process.exit(0);
  }

  // Get current abbreviationLogic
  const currentLogic = (dna.abbreviationLogic || {}) as Record<string, AbbreviationEntry>;

  // Enrich abbreviationLogic
  logger.info('Starting enrichment process...');
  const stateFile = path.join(__dirname, '..', '..', '.enrichment-state.json');
  const { enriched, added, skipped, conflicts, processed } = await enrichAbbreviationLogic(
    currentLogic,
    csvRows,
    useLLM,
    llmProvider,
    stateFile,
  );

  // Update DNA file
  dna.abbreviationLogic = enriched;

  // Write updated DNA file
  fs.writeFileSync(outputPath, JSON.stringify(dna, null, 2), 'utf-8');

  // Output statistics
  logger.info({
    totalBefore: Object.keys(currentLogic).length,
    totalAfter: Object.keys(enriched).length,
    added,
    skipped,
    conflicts,
    processed,
    csvTotal: csvRows.length,
  }, 'Enrichment completed');

  // Output only abbreviationLogic block (as requested)
  console.log(JSON.stringify(enriched, null, 2));
}

// Run script
main().catch((error) => {
  logger.error({ error }, 'Script execution failed');
  process.exit(1);
});
