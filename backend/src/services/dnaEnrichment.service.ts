import { parse } from 'csv-parse/sync';
import * as iconv from 'iconv-lite';
import { getProvider } from '../ai/providers/registry';
import { logger } from '../utils/logger';
import { getDocumentDna, updateDocumentDna } from './analysis.service';
import type { DocumentDnaPayload } from '../ai/types';
import { createOrUpdateProgress, completeProgress } from './enrichmentProgress';

interface CSVRow {
  'Наименование энергопроизводящей организации': string;
  'Сокращенное наименование': string;
  'Наименование на английском'?: string;
}

interface AbbreviationEntry {
  longForm: string;
  shortForm: string;
}

interface EnrichmentResult {
  enriched: Record<string, AbbreviationEntry>;
  statistics: {
    totalBefore: number;
    totalAfter: number;
    added: number;
    skipped: number;
    conflicts: number;
  };
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
  apiKey?: string,
  yandexFolderId?: string,
  model?: string,
): Promise<string> {
  try {
    const aiProvider = getProvider(provider, apiKey, yandexFolderId);
    const selectedModel = model || (
      provider === 'gemini' ? 'gemini-2.0-flash' : 
      provider === 'openai' ? 'gpt-4o-mini' :
      provider === 'yandex' ? 'yandexgpt-lite' : 'deepseek-chat'
    );

    const prompt = `You are a technical translator specializing in power industry terminology. 
Translate this power plant or energy organization name from Russian to English. 
Return ONLY the English translation, no explanations.

Term: ${ruTerm}

Translation:`;

    const response = await aiProvider.callModel({
      prompt,
      systemPrompt: 'You are a technical translator. Return only the translation, no explanations.',
      model: selectedModel,
      temperature: 0.3,
      maxTokens: 100,
      segments: [{
        segmentId: 'temp',
        sourceText: ruTerm,
      }],
    });

    const translation = (response.outputText || '').trim();
    
    // Clean up response
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

/**
 * Parse CSV buffer and extract power plant data
 */
function parseCSVBuffer(csvBuffer: Buffer): CSVRow[] {
  try {
    // Try multiple encodings
    let csvContent: string | null = null;
    const encodings: BufferEncoding[] = ['utf-8', 'latin1', 'utf-16le'];
    
    for (const encoding of encodings) {
      try {
        const testContent = csvBuffer.toString(encoding);
        // Check if we got valid text (not just question marks or mojibake)
        if (testContent && !testContent.includes('я┐╜') && testContent.length > 0) {
          // Try to find expected column names
          if (testContent.includes('Наименование') || testContent.includes('Сокращенное') || 
              testContent.includes('энергопроизводящей') || testContent.includes('организации') ||
              testContent.includes('ЭПО') || testContent.includes('электрических станций')) {
            csvContent = testContent;
            logger.info({ encoding }, 'CSV encoding detected');
            break;
          }
        }
      } catch (e) {
        // Try next encoding
        continue;
      }
    }
    
    // If no encoding worked, try Windows-1251 via iconv-lite
    if (!csvContent) {
      try {
        csvContent = iconv.decode(csvBuffer, 'win1251');
        // Check if decoding produced valid Cyrillic text
        if (csvContent && (csvContent.includes('Наименование') || csvContent.includes('Сокращенное') ||
            csvContent.includes('ЭПО') || csvContent.includes('электрических станций'))) {
          logger.info({ encoding: 'windows-1251' }, 'CSV encoding detected (via iconv-lite)');
        } else {
          // Try UTF-8 as last resort
          csvContent = csvBuffer.toString('utf-8');
          logger.warn('Using UTF-8 encoding as fallback');
        }
      } catch {
        // Fallback to latin1 (can handle most single-byte encodings)
        csvContent = csvBuffer.toString('latin1');
        logger.warn('Using latin1 encoding as fallback');
      }
    }
    
    // Try different delimiters (semicolon is common in Excel exports)
    const delimiters = [';', ',', '\t'];
    let records: CSVRow[] = [];
    let parseError: Error | null = null;
    
    for (const delimiter of delimiters) {
      try {
        records = parse(csvContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          bom: true,
          relax_column_count: true,
          delimiter,
          quote: '"',
          escape: '"',
          relax_quotes: true, // Allow quotes in unquoted fields
          skip_records_with_error: true, // Skip problematic rows instead of failing
          from_line: 2, // Skip first line (document header), use second line as column headers
        }) as CSVRow[];
        
        // Check if we got valid records with expected columns
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
            logger.info({ delimiter, recordCount: records.length, columns: keys }, 'CSV parsed successfully');
            console.log(`✅ CSV parsed successfully with delimiter: "${delimiter}"`);
            console.log(`📊 Found ${records.length} records`);
            console.log(`📋 Columns found: ${keys.join(', ')}`);
            break;
          } else {
            logger.debug({ delimiter, columns: keys }, 'CSV parsed but missing required columns, trying next delimiter');
          }
        }
      } catch (error) {
        parseError = error as Error;
        continue;
      }
    }
    
    if (records.length === 0 && parseError) {
      throw parseError;
    }

    // Filter and normalize column names (handle variations)
    const validRecords = records
      .map(row => {
        // Find columns by partial name match
        // Support multiple column name variations:
        // - "Наименование энергопроизводящей организации"
        // - "Наименование ЭПО"
        // - "Наименование электрических станций"
        const ruNameKey = Object.keys(row).find(key => {
          const lowerKey = key.toLowerCase();
          return lowerKey.includes('наименование') && (
            lowerKey.includes('энергопроизводящей') || 
            lowerKey.includes('организации') ||
            lowerKey.includes('эпо') ||
            lowerKey.includes('электрических станций')
          );
        });
        
        // Support multiple column name variations for short form:
        // - "Сокращенное наименование"
        // - "Наименование электрических станций" (if it's the short form column)
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
          logger.debug({ 
            availableKeys: Object.keys(row),
            ruNameKey,
            shortFormKey 
          }, 'CSV row missing required columns');
          return null;
        }
        
        return {
          'Наименование энергопроизводящей организации': String(row[ruNameKey] || '').trim(),
          'Сокращенное наименование': String(row[shortFormKey] || '').trim(),
          'Наименование на английском': enNameKey ? String(row[enNameKey] || '').trim() : undefined,
        } as CSVRow;
      })
      .filter((row): row is CSVRow => 
        row !== null && 
        row['Наименование энергопроизводящей организации'] !== '' &&
        row['Сокращенное наименование'] !== ''
      );

    logger.info({ total: records.length, valid: validRecords.length }, 'CSV records parsed and filtered');
    return validRecords;
  } catch (error) {
    logger.error({ error, errorMessage: (error as Error).message }, 'Failed to parse CSV file');
    throw new Error(`Failed to parse CSV: ${(error as Error).message}. Please ensure the file is in UTF-8 or Windows-1251 encoding with semicolon or comma delimiter.`);
  }
}

/**
 * Enrich abbreviationLogic with CSV data
 */
async function enrichAbbreviationLogic(
  currentLogic: Record<string, AbbreviationEntry>,
  csvRows: CSVRow[],
  useLLM: boolean = true,
  llmProvider: 'gemini' | 'openai' | 'yandex' | 'deepseek' = 'gemini',
  onProgress?: (current: number, total: number) => void,
  documentId?: string, // For progress tracking
  apiKey?: string,
  yandexFolderId?: string,
  model?: string,
): Promise<EnrichmentResult> {
  const enriched: Record<string, AbbreviationEntry> = { ...currentLogic };
  const existingKeys = new Set(Object.keys(enriched).map(normalizeKey));
  
  let added = 0;
  let skipped = 0;
  let conflicts = 0;
  const total = csvRows.length;

  // Early return if no rows to process
  if (csvRows.length === 0) {
    return {
      enriched,
      statistics: {
        totalBefore: Object.keys(currentLogic).length,
        totalAfter: Object.keys(enriched).length,
        added: 0,
        skipped: 0,
        conflicts: 0,
      },
    };
  }

  // Process CSV rows in batches (25 rows at a time to avoid timeouts)
  const BATCH_SIZE = 25;
  const totalBatches = Math.ceil(csvRows.length / BATCH_SIZE);
  
  for (let i = 0; i < csvRows.length; i += BATCH_SIZE) {
    const batch = csvRows.slice(i, Math.min(i + BATCH_SIZE, csvRows.length));
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    
    logger.info({ 
      batch: batchNumber, 
      totalBatches, 
      current: i + 1, 
      total: csvRows.length 
    }, `Processing batch ${batchNumber}/${totalBatches}`);

    // Update progress for batch start
    if (documentId) {
      try {
        createOrUpdateProgress(documentId, {
          status: 'processing',
          current: i,
          total: csvRows.length,
          batchNumber,
          totalBatches,
          added: typeof added === 'number' ? added : 0,
          skipped: typeof skipped === 'number' ? skipped : 0,
          conflicts: typeof conflicts === 'number' ? conflicts : 0,
          errors: [],
        });
      } catch (err) {
        logger.warn({ error: err, documentId, batchNumber }, 'Failed to update batch progress');
      }
    }

    for (const row of batch) {
      const rowIndex = csvRows.indexOf(row);
      
      // Log row data before processing
      console.log('Processing row:', row);
      
      const ruName = row['Наименование энергопроизводящей организации']?.trim();
      const shortForm = row['Сокращенное наименование']?.trim();
      const enName = row['Наименование на английском']?.trim();

      // Report progress
      if (onProgress) {
        onProgress(rowIndex + 1, total);
      }

      // Skip invalid rows
      if (!ruName || !shortForm) {
        logger.debug({ rowIndex: rowIndex + 1, ruName, shortForm }, 'Skipping row: missing required fields');
        skipped++;
        continue;
      }

      const normalizedKey = normalizeKey(ruName);

      // Conflict Resolution: Skip if key already exists
      if (existingKeys.has(normalizedKey)) {
        logger.debug({ rowIndex: rowIndex + 1, ruName, normalizedKey }, 'Skipping row: duplicate key');
        skipped++;
        continue;
      }

      // Identity Protection: Skip if key === shortForm
      if (hasIdentityConflict(ruName, shortForm)) {
        conflicts++;
        skipped++;
        continue;
      }

      // Determine longForm
      let longForm: string;
      if (enName) {
        longForm = enName;
      } else if (useLLM) {
        try {
          longForm = await translateToEnglish(ruName, llmProvider, apiKey, yandexFolderId, model);
          // Increased delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 600));
        } catch (error) {
          logger.warn({ error, ruName, rowIndex: rowIndex + 1 }, 'LLM translation failed, using Russian name');
          longForm = ruName;
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

      // Update progress with last added entry
      if (documentId) {
        try {
          createOrUpdateProgress(documentId, {
            status: 'processing',
            current: rowIndex + 1,
            total: csvRows.length,
            batchNumber,
            totalBatches,
            added: typeof added === 'number' ? added : 0,
            skipped: typeof skipped === 'number' ? skipped : 0,
            conflicts: typeof conflicts === 'number' ? conflicts : 0,
            lastAdded: {
              ruName,
              shortForm,
              longForm,
            },
          });
        } catch (err) {
          logger.warn({ error: err, documentId, rowIndex }, 'Failed to update row progress');
        }
      }
    }

    // Delay between batches to avoid overwhelming the API
    if (i + BATCH_SIZE < csvRows.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return {
    enriched,
    statistics: {
      totalBefore: Object.keys(currentLogic).length,
      totalAfter: Object.keys(enriched).length,
      added,
      skipped,
      conflicts,
    },
  };
}

/**
 * Enrich document DNA abbreviationLogic from CSV file
 */
export async function enrichDocumentDnaFromCSV(
  documentId: string,
  csvBuffer: Buffer,
  options: {
    useLLM?: boolean;
    llmProvider?: 'gemini' | 'openai' | 'yandex' | 'deepseek';
    onProgress?: (current: number, total: number) => void;
  } = {},
): Promise<EnrichmentResult> {
  // Get project AI settings for API keys and model
  let apiKey: string | undefined;
  let yandexFolderId: string | undefined;
  let model: string | undefined;
  
  try {
    const { prisma } = await import('../db/prisma');
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { projectId: true },
    });
    
    if (document?.projectId) {
      const { getProjectAISettings } = await import('./ai.service');
      const aiSettings = await getProjectAISettings(document.projectId);
      const providerName = (options.llmProvider ?? aiSettings?.provider ?? 'gemini')?.toLowerCase();
      
      // Extract API key from config
      if (aiSettings?.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)) {
        const config = aiSettings.config as Record<string, unknown>;
        const keyName = providerName ? `${providerName}ApiKey` : null;
        if (keyName && keyName in config) {
          apiKey = config[keyName] as string;
        } else if ('apiKey' in config) {
          apiKey = config.apiKey as string;
        }
        if ('yandexFolderId' in config) {
          yandexFolderId = config.yandexFolderId as string;
        }
      }
      
      // Get model from settings or use default
      model = aiSettings?.model;
      if (!model && providerName) {
        const provider = getProvider(providerName as 'gemini' | 'openai' | 'yandex' | 'deepseek', apiKey, yandexFolderId);
        model = provider.defaultModel;
      }
    }
  } catch (err) {
    logger.warn({ error: err, documentId }, 'Failed to load project AI settings for enrichment, using defaults');
  }

  // Initialize progress with explicit values
  try {
    createOrUpdateProgress(documentId, {
      status: 'processing',
      current: 0,
      total: 0,
      batchNumber: 0,
      totalBatches: 0,
      added: 0,
      skipped: 0,
      conflicts: 0,
      errors: [],
    });
  } catch (err) {
    logger.error({ error: err, documentId }, 'Failed to initialize enrichment progress');
  }

  try {
    // Get current DNA
    const currentDna = await getDocumentDna(documentId);
    if (!currentDna) {
      try {
        createOrUpdateProgress(documentId, {
          status: 'error',
          error: 'Document has no DNA. Please generate DNA first.',
        });
      } catch (err) {
        logger.error({ error: err, documentId }, 'Failed to update error progress');
      }
      throw new Error('Document has no DNA. Please generate DNA first.');
    }

    const currentLogic = (currentDna.abbreviationLogic || {}) as Record<string, AbbreviationEntry>;

    // Parse CSV
    const csvRows = parseCSVBuffer(csvBuffer);

    if (csvRows.length === 0) {
      // Update progress with final state before completing
      try {
        createOrUpdateProgress(documentId, {
          status: 'completed',
          current: 0,
          total: 0,
          added: 0,
          skipped: 0,
          conflicts: 0,
        });
      } catch (err) {
        logger.warn({ error: err, documentId }, 'Failed to update empty CSV progress');
      }
      completeProgress(documentId);
      return {
        enriched: currentLogic,
        statistics: {
          totalBefore: Object.keys(currentLogic).length,
          totalAfter: Object.keys(currentLogic).length,
          added: 0,
          skipped: 0,
          conflicts: 0,
        },
      };
    }

    // Enrich abbreviationLogic
    const result = await enrichAbbreviationLogic(
      currentLogic,
      csvRows,
      options.useLLM ?? true,
      options.llmProvider ?? 'gemini',
      options.onProgress,
      documentId, // Pass documentId for progress tracking
      apiKey,
      yandexFolderId,
      model,
    );

    // Validate result
    if (!result || !result.enriched || !result.statistics) {
      const errorMsg = 'Enrichment returned invalid result';
      try {
        createOrUpdateProgress(documentId, {
          status: 'error',
          error: errorMsg,
        });
      } catch (err) {
        logger.error({ error: err, documentId }, 'Failed to update error progress');
      }
      throw new Error(errorMsg);
    }

    // Ensure statistics has all required fields
    const statistics = result.statistics || {};
    const finalStats = {
      added: (typeof statistics.added === 'number' ? statistics.added : 0),
      skipped: (typeof statistics.skipped === 'number' ? statistics.skipped : 0),
      conflicts: (typeof statistics.conflicts === 'number' ? statistics.conflicts : 0),
      totalBefore: (typeof statistics.totalBefore === 'number' ? statistics.totalBefore : Object.keys(currentLogic).length),
      totalAfter: (typeof statistics.totalAfter === 'number' ? statistics.totalAfter : Object.keys(result.enriched || {}).length),
    };

    // Update DNA
    const updatedDna: DocumentDnaPayload = {
      ...currentDna,
      abbreviationLogic: result.enriched,
    };

    await updateDocumentDna(documentId, updatedDna);

    // Update progress with final statistics before completing
    try {
      createOrUpdateProgress(documentId, {
        status: 'completed',
        current: csvRows.length,
        total: csvRows.length,
        added: typeof finalStats.added === 'number' ? finalStats.added : 0,
        skipped: typeof finalStats.skipped === 'number' ? finalStats.skipped : 0,
        conflicts: typeof finalStats.conflicts === 'number' ? finalStats.conflicts : 0,
      });
    } catch (err) {
      logger.warn({ error: err, documentId }, 'Failed to update final progress');
    }
    
    // Mark as completed (will auto-cleanup after 5 minutes)
    completeProgress(documentId);

    logger.info({ documentId, statistics: finalStats }, 'DNA enrichment completed');

    // Ensure we return a valid result with all required fields
    const returnResult: EnrichmentResult = {
      enriched: result.enriched || currentLogic,
      statistics: {
        totalBefore: finalStats.totalBefore,
        totalAfter: finalStats.totalAfter,
        added: finalStats.added,
        skipped: finalStats.skipped,
        conflicts: finalStats.conflicts,
      },
    };

    return returnResult;
  } catch (error) {
    // Mark progress as error
    const errorMessage = error instanceof Error ? error.message : String(error);
    try {
      createOrUpdateProgress(documentId, {
        status: 'error',
        error: errorMessage,
      });
    } catch (progressError) {
      logger.error({ error: progressError, documentId }, 'Failed to update error progress');
    }
    logger.error({ error, documentId }, 'DNA enrichment failed');
    throw error;
  }
}
