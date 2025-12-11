import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import type { GlossaryEntry as PrismaGlossaryEntry } from '@prisma/client';

// Type for context rules
export type ContextRules = {
  useOnlyIn?: string[]; // Only use in these contexts/domains
  excludeFrom?: string[]; // Never use in these contexts/domains
  documentTypes?: string[]; // Only use in these document types
  requires?: string[]; // Only when these conditions are met
};

// Helper function to map Prisma GlossaryEntry to API GlossaryEntry format
function mapPrismaToApi(entry: PrismaGlossaryEntry): {
  id: string;
  projectId?: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLocale: string;
  targetLocale: string;
  description?: string;
  status: 'PREFERRED' | 'DEPRECATED';
  forbidden: boolean;
  notes?: string;
  contextRules?: ContextRules;
  createdAt: string;
  updatedAt: string;
} {
  // Split notes back into description and notes if they were combined
  const notesText = entry.notes || '';
  let description: string | undefined = undefined;
  let notes: string | undefined = undefined;
  
  if (notesText.includes('\n\n---\n\n')) {
    const parts = notesText.split('\n\n---\n\n');
    description = parts[0] || undefined;
    notes = parts[1] || undefined;
  } else if (notesText) {
    // If no separator, use as description
    description = notesText;
    notes = undefined;
  }
  
  // Map Prisma GlossaryStatus enum to API status
  // Prisma has: CANDIDATE, PREFERRED, DEPRECATED
  // API returns: PREFERRED, DEPRECATED (CANDIDATE is mapped to PREFERRED for backward compatibility)
  let apiStatus: 'PREFERRED' | 'DEPRECATED' = 'PREFERRED';
  if (entry.status === 'DEPRECATED') {
    apiStatus = 'DEPRECATED';
  } else if (entry.status === 'PREFERRED') {
    apiStatus = 'PREFERRED';
  } else {
    // CANDIDATE or any other value defaults to PREFERRED
    apiStatus = 'PREFERRED';
  }
  
  return {
    id: entry.id,
    projectId: entry.projectId || undefined,
    sourceTerm: entry.sourceTerm,
    targetTerm: entry.targetTerm,
    sourceLocale: entry.sourceLocale,
    targetLocale: entry.targetLocale,
    description,
    status: apiStatus,
    forbidden: entry.isForbidden,
    notes,
    contextRules: entry.contextRules as ContextRules | undefined,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export const listGlossaryEntries = async (
  projectId?: string,
  sourceLocale?: string,
  targetLocale?: string,
) => {
  const whereClause: any = {};
  
  if (projectId) {
    whereClause.projectId = projectId;
  }
  
  if (sourceLocale) {
    whereClause.sourceLocale = sourceLocale;
  }
  
  if (targetLocale) {
    whereClause.targetLocale = targetLocale;
  }
  
  const entries = await prisma.glossaryEntry.findMany({
    where: Object.keys(whereClause).length > 0 ? whereClause : undefined,
    orderBy: { sourceTerm: 'asc' },
  });

  // Map Prisma schema to API response format
  return entries.map(mapPrismaToApi);
};

export const upsertGlossaryEntry = async (data: {
  id?: string;
  projectId?: string;
  sourceTerm?: string;
  targetTerm?: string;
  sourceLocale?: string;
  targetLocale?: string;
  description?: string;
  status?: 'PREFERRED' | 'DEPRECATED';
  forbidden?: boolean;
  notes?: string;
  contextRules?: ContextRules | null;
}) => {
  // Map 'forbidden' to 'isForbidden' for Prisma schema
  // Normalize terms by trimming whitespace
  // Generate direction from sourceLocale and targetLocale
  const { 
    forbidden, 
    status, 
    description, 
    notes, 
    contextRules: rawContextRules,
    sourceTerm,
    targetTerm,
    sourceLocale,
    targetLocale,
    projectId,
    id,
  } = data;
  
  // Convert null contextRules to undefined
  const contextRules = rawContextRules === null ? undefined : rawContextRules;
  
  // Validate required fields for new entries
  if (!id && (!sourceTerm || !targetTerm || !sourceLocale || !targetLocale)) {
    throw ApiError.badRequest('sourceTerm, targetTerm, sourceLocale, and targetLocale are required for new entries');
  }
  
  // Generate direction string (e.g., "ru-en", "en-ru")
  // Only generate if both locales are provided (for new entries or full updates)
  const direction = (sourceLocale && targetLocale) 
    ? `${sourceLocale}-${targetLocale}` 
    : undefined;
  
  // Combine description and notes into notes field (Prisma schema only has notes, not description)
  // Format: "DESCRIPTION\n\n---\n\nNOTES" or just one of them
  let combinedNotes: string | undefined = undefined;
  if (description && notes) {
    combinedNotes = `${description}\n\n---\n\n${notes}`;
  } else if (description) {
    combinedNotes = description;
  } else if (notes) {
    combinedNotes = notes;
  }
  
  // Map status: API accepts 'PREFERRED' | 'DEPRECATED', Prisma uses GlossaryStatus enum (CANDIDATE, PREFERRED, DEPRECATED)
  // If status is provided, use it; otherwise for updates, don't include it (preserve existing), for creates default to CANDIDATE
  let statusToSave: 'CANDIDATE' | 'PREFERRED' | 'DEPRECATED' | undefined = undefined;
  if (status !== undefined) {
    statusToSave = status === 'PREFERRED' 
      ? 'PREFERRED' 
      : status === 'DEPRECATED' 
      ? 'DEPRECATED' 
      : 'CANDIDATE';
  } else if (!id) {
    // For new entries, default to CANDIDATE if status not provided
    statusToSave = 'CANDIDATE';
  }
  
  // Build prismaData - only include fields that are provided
  const prismaData: any = {};
  
  // Only include these fields if they're provided
  if (sourceTerm !== undefined) {
    prismaData.sourceTerm = sourceTerm.trim();
  }
  if (targetTerm !== undefined) {
    prismaData.targetTerm = targetTerm.trim();
  }
  if (sourceLocale !== undefined && targetLocale !== undefined) {
    prismaData.direction = `${sourceLocale}-${targetLocale}`;
  } else if (!id) {
    // For new entries, direction is required
    prismaData.direction = `${sourceLocale}-${targetLocale}`;
  }
  
  if (projectId !== undefined) {
    prismaData.projectId = projectId;
  }
  
  if (forbidden !== undefined) {
    prismaData.isForbidden = forbidden;
  } else if (!id) {
    prismaData.isForbidden = false; // Default for new entries
  }
  
  if (combinedNotes !== undefined) {
    prismaData.notes = combinedNotes;
  }
  
  if (contextRules !== undefined) {
    prismaData.contextRules = contextRules ? (contextRules as any) : undefined;
  }
  
  // Only include status if it's provided or it's a new entry
  // CRITICAL: Always include status if provided, even for updates
  if (status !== undefined) {
    // Status was explicitly provided - always include it
    prismaData.status = statusToSave!; // statusToSave is guaranteed to be set if status !== undefined
    logger.info(
      { entryId: id, status, statusToSave, willIncludeInUpdate: !!id, prismaDataStatus: prismaData.status },
      'Status explicitly provided - will be included in prismaData',
    );
  } else if (statusToSave !== undefined) {
    // For new entries, include status (defaults to CANDIDATE)
    prismaData.status = statusToSave;
    logger.debug(
      { entryId: id, statusToSave, isNewEntry: !id },
      'Status included for new entry',
    );
  }

  // If updating existing entry by ID
  if (id) {
    // Log what we're updating
    logger.info(
      { 
        entryId: id, 
        sourceTerm: sourceTerm || 'N/A', 
        status: status !== undefined ? statusToSave : 'not provided',
        statusProvided: status !== undefined,
        statusToSave,
        projectId: projectId, 
        prismaDataKeys: Object.keys(prismaData), 
        prismaData,
        prismaDataHasStatus: 'status' in prismaData,
      },
      'Updating glossary entry',
    );
    
    // Ensure we have at least one field to update
    if (Object.keys(prismaData).length === 0) {
      logger.warn({ entryId: id }, 'No fields to update in prismaData - this should not happen');
      throw ApiError.badRequest('No fields provided for update');
    }
    
    const updated = await prisma.glossaryEntry.update({
      where: { id },
      data: prismaData,
    });
    
    // Verify the update actually changed the status
    logger.info(
      { 
        entryId: id, 
        requestedStatus: prismaData.status,
        actualUpdatedStatus: updated.status,
        updatedKeys: Object.keys(prismaData),
        statusWasIncluded: 'status' in prismaData,
        statusWasUpdated: prismaData.status === updated.status,
      },
      'Glossary entry updated successfully',
    );
    
    // Double-check: if status was supposed to be updated but wasn't, log a warning
    if ('status' in prismaData && prismaData.status !== updated.status) {
      logger.error(
        { 
          entryId: id,
          requestedStatus: prismaData.status,
          actualStatus: updated.status,
          prismaData,
        },
        'CRITICAL: Status update failed - requested status does not match updated status',
      );
    }
    
    // Regenerate embedding if sourceTerm changed (in background)
    if (sourceTerm) {
      const oldEntry = await prisma.glossaryEntry.findUnique({
        where: { id },
        select: { sourceTerm: true },
      });
      
      if (oldEntry && oldEntry.sourceTerm !== sourceTerm.trim()) {
        // Source term changed, regenerate embedding
        (async () => {
          try {
            // First, clear existing embedding
            await prisma.$executeRawUnsafe(
              `UPDATE "GlossaryEntry" SET "sourceEmbedding" = NULL, "embeddingUpdatedAt" = NULL WHERE id = $1`,
              id,
            );
            
            const { generateEmbeddingForGlossaryEntry } = await import('./embedding-generation.service');
            await generateEmbeddingForGlossaryEntry(id);
            logger.debug({ entryId: id }, 'Background glossary embedding regenerated successfully');
          } catch (error: any) {
            logger.debug(
              {
                entryId: id,
                error: error.message,
              },
              'Background glossary embedding regeneration failed (non-critical)',
            );
          }
        })();
      }
    }
    
    // Map Prisma schema to API response format
    return mapPrismaToApi(updated);
  }

  // For new entries, check for duplicates first
  // A duplicate is defined as: same sourceTerm, targetTerm, sourceLocale, targetLocale, and projectId
  // Normalize terms by trimming whitespace for comparison
  const normalizedSourceTerm = (sourceTerm || '').trim();
  const normalizedTargetTerm = (targetTerm || '').trim();
  
  // Build where clause for duplicate check
  // Handle projectId: null and undefined both mean "global entry"
  const duplicateWhere: any = {
    sourceTerm: normalizedSourceTerm,
    targetTerm: normalizedTargetTerm,
    sourceLocale: sourceLocale!,
    targetLocale: targetLocale!,
  };
  
  // For global entries (no projectId), check for entries with null projectId
  if (projectId) {
    duplicateWhere.projectId = projectId;
  } else {
    duplicateWhere.projectId = null;
  }
  
  const existingEntry = await prisma.glossaryEntry.findFirst({
    where: duplicateWhere,
  });

  if (existingEntry) {
    // Update existing entry instead of creating duplicate
    const updated = await prisma.glossaryEntry.update({
      where: { id: existingEntry.id },
      data: prismaData,
    });
    
    // Map Prisma schema to API response format
    return mapPrismaToApi(updated);
  }

  // No duplicate found, create new entry
  // Log status when creating new entry
  if (status !== undefined) {
    logger.info(
      { sourceTerm: sourceTerm || 'N/A', status: statusToSave, projectId: projectId },
      'Creating new glossary entry with status',
    );
  }
  const created = await prisma.glossaryEntry.create({ data: prismaData });
  
  // Generate embedding in background (non-blocking)
  (async () => {
    try {
      const { generateEmbeddingForGlossaryEntry } = await import('./embedding-generation.service');
      await generateEmbeddingForGlossaryEntry(created.id);
      logger.debug({ entryId: created.id }, 'Background glossary embedding generated successfully');
    } catch (error: any) {
      logger.debug(
        {
          entryId: created.id,
          error: error.message,
        },
        'Background glossary embedding generation failed (non-critical)',
      );
    }
  })();
  
  // Map Prisma schema to API response format
  return mapPrismaToApi(created);
};

export const getGlossaryEntry = async (entryId: string) => {
  const entry = await prisma.glossaryEntry.findUnique({ where: { id: entryId } });
  if (!entry) {
    throw ApiError.notFound('Glossary entry not found');
  }
  
  // Map Prisma schema to API response format
  return mapPrismaToApi(entry);
};

export const deleteGlossaryEntry = async (entryId: string) => {
  const entry = await prisma.glossaryEntry.findUnique({ where: { id: entryId } });
  if (!entry) {
    throw ApiError.notFound('Glossary entry not found');
  }
  return prisma.glossaryEntry.delete({ where: { id: entryId } });
};

/**
 * Detect CSV delimiter (comma or semicolon)
 * Returns the most common delimiter in the first few rows
 */
function detectDelimiter(content: string): string {
  const sampleRows = content.split(/\r?\n/).slice(0, 5).filter((line) => line.trim().length > 0);
  
  let commaCount = 0;
  let semicolonCount = 0;
  
  for (const row of sampleRows) {
    // Count delimiters (excluding those inside quotes)
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const char = row[i];
      const nextChar = row[i + 1];
      
      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          i++; // Skip escaped quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (!inQuotes) {
        if (char === ',') commaCount++;
        if (char === ';') semicolonCount++;
      }
    }
  }
  
  // Prefer semicolon if it's used, otherwise default to comma
  return semicolonCount > commaCount ? ';' : ',';
}

/**
 * Parse CSV row handling quoted values (simple implementation)
 * Handles: "value,with,commas","another value" or "value;with;semicolons";"another value"
 */
function parseCsvRow(row: string, delimiter: string = ','): string[] {
  const columns: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    const nextChar = row[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote ("")
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      // End of column
      columns.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Add last column
  columns.push(current.trim());
  return columns;
}

export const importGlossaryCsv = async (buffer: Buffer, projectId?: string) => {
  const content = buffer.toString('utf-8');
  
  // Detect delimiter (comma or semicolon)
  const delimiter = detectDelimiter(content);
  
  const rows = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rows.length <= 1) {
    throw ApiError.badRequest('CSV must contain at least one data row');
  }

  // Parse header row
  const header = parseCsvRow(rows[0], delimiter).map((value) => value.replace(/^"|"$/g, '').trim().toLowerCase());
  const getIndex = (key: string) => header.indexOf(key);
  const sourceIdx = getIndex('term_source');
  const targetIdx = getIndex('term_target');
  
  // Also check for alternative column names (for backward compatibility)
  const sourceIdxAlt = sourceIdx === -1 ? getIndex('sourceterm') : -1;
  const targetIdxAlt = targetIdx === -1 ? getIndex('targetterm') : -1;
  
  const finalSourceIdx = sourceIdx !== -1 ? sourceIdx : sourceIdxAlt;
  const finalTargetIdx = targetIdx !== -1 ? targetIdx : targetIdxAlt;
  
  if (finalSourceIdx === -1 || finalTargetIdx === -1) {
    throw ApiError.badRequest('CSV must include term_source and term_target columns (or sourceTerm and targetTerm)');
  }
  
  const notesIdx = getIndex('notes');
  const forbiddenIdx = getIndex('forbidden');

  const entries = rows.slice(1)
    .map((row) => {
      const columns = parseCsvRow(row, delimiter).map((value) => value.replace(/^"|"$/g, '').trim());
      
      // Skip empty rows or rows where source/target are empty
      if (!columns[finalSourceIdx] || !columns[finalTargetIdx] || 
          columns[finalSourceIdx].length === 0 || columns[finalTargetIdx].length === 0) {
        return null;
      }
      
      // Generate direction from sourceLocale and targetLocale
      const sourceLocale = 'source'; // TODO: Should be provided in CSV or request
      const targetLocale = 'target'; // TODO: Should be provided in CSV or request
      const direction = `${sourceLocale}-${targetLocale}`;
      
      return {
        projectId,
        sourceTerm: columns[finalSourceIdx],
        targetTerm: columns[finalTargetIdx],
        sourceLocale,
        targetLocale,
        direction, // Required field in Prisma schema
        notes: notesIdx >= 0 && columns[notesIdx] ? columns[notesIdx] : undefined,
        isForbidden:
          forbiddenIdx >= 0 ? ['true', '1', 'yes'].includes(columns[forbiddenIdx]?.toLowerCase()) : false,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  // Use skipDuplicates to prevent duplicate entries during import
  // This will skip entries that have the same combination of:
  // sourceTerm, targetTerm, sourceLocale, targetLocale, and projectId
  const result = await prisma.glossaryEntry.createMany({
    data: entries,
    skipDuplicates: true, // Skip duplicates instead of throwing error
  });

  return { imported: result.count };
};

/**
 * Generate glossary terms from a document using AI
 * Extracts terminology pairs from source and target text segments
 */
export const generateGlossary = async (documentId: string): Promise<{ count: number }> => {
  // Get document with segments
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: {
        where: {
          sourceText: { not: '' },
          OR: [
            { targetMt: { not: null } },
            { targetFinal: { not: null } },
          ],
        },
        orderBy: { segmentIndex: 'asc' },
        select: {
          sourceText: true,
          targetMt: true,
          targetFinal: true,
        },
      },
    },
  });

  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  if (document.segments.length === 0) {
    throw ApiError.badRequest('Document has no segments with translations to extract glossary from');
  }

  // Build document content: combine source and target text pairs
  const documentContent = document.segments
    .map((segment) => {
      const targetText = segment.targetFinal || segment.targetMt || '';
      if (!targetText) return null;
      return `Source: ${segment.sourceText}\nTarget: ${targetText}`;
    })
    .filter((pair): pair is string => pair !== null)
    .join('\n\n');

  if (!documentContent.trim()) {
    throw ApiError.badRequest('No translated segments found in document');
  }

  // Define specialized AI prompt for glossary extraction
  const systemPrompt = `You are a glossary extraction expert. Your task is to analyze translation pairs and extract terminology pairs (source term → target term) that represent important domain-specific terms, technical terms, proper nouns, or key phrases that should be consistently translated.

Extract only significant terminology pairs that:
1. Are domain-specific or technical terms
2. Are proper nouns (names, places, organizations)
3. Are key phrases that should be translated consistently
4. Have clear source-to-target mappings

Do NOT extract:
- Common words or phrases
- Generic translations
- Complete sentences (only extract key terms/phrases)

Return ONLY a valid JSON array of objects with this exact structure:
[
  {"sourceTerm": "term in source language", "targetTerm": "term in target language"},
  {"sourceTerm": "another term", "targetTerm": "another translation"}
]

Important:
- Return ONLY the JSON array, no additional text
- Each object must have exactly "sourceTerm" and "targetTerm" fields
- Terms should be trimmed of extra whitespace
- Do not include duplicate entries`;

  const userPrompt = `Extract terminology pairs from the following translation pairs:

${documentContent}

Return a JSON array of terminology pairs.`;

  // Get AI provider and settings
  const { getProvider } = await import('../ai/providers/registry');
  const { getProjectAISettings } = await import('./ai.service');
  
  const aiSettings = await getProjectAISettings(document.projectId);
  
  // Extract API key from project settings config (same pattern as buildAiContext)
  let apiKey: string | undefined;
  let yandexFolderId: string | undefined;
  
  if (aiSettings?.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)) {
    const config = aiSettings.config as Record<string, unknown>;
    const providerName = aiSettings.provider?.toLowerCase();
    
    // Try provider-specific key first (e.g., geminiApiKey, openaiApiKey, yandexApiKey)
    const providerKeyName = providerName ? `${providerName}ApiKey` : null;
    if (providerKeyName && providerKeyName in config) {
      apiKey = config[providerKeyName] as string;
    }
    // Fallback to legacy apiKey field
    else if ('apiKey' in config) {
      apiKey = config.apiKey as string;
    }
    
    // Extract Yandex Folder ID if available
    if ('yandexFolderId' in config) {
      yandexFolderId = config.yandexFolderId as string;
    }
  }
  
  const provider = getProvider(aiSettings?.provider, apiKey, yandexFolderId);
  const model = aiSettings?.model ?? provider.defaultModel;

  logger.info(
    {
      documentId,
      segmentsCount: document.segments.length,
      provider: provider.name,
      model,
    },
    'Generating glossary from document',
  );

  // Call AI with custom systemPrompt and low temperature
  let aiResponse;
  let responseText: string;
  try {
    aiResponse = await provider.callModel({
      prompt: userPrompt,
      systemPrompt,
      model,
      temperature: 0.1, // Low temperature for consistent extraction
      maxTokens: 4096, // Allow for large glossaries
      segments: [], // Not needed for glossary extraction
    });

    responseText = aiResponse.outputText.trim();
  } catch (error: any) {
    logger.error(
      {
        documentId,
        provider: provider.name,
        model,
        error: error.message,
        errorStack: error.stack,
      },
      'AI provider call failed during glossary generation',
    );

    // Provide user-friendly error messages
    if (error.message?.includes('API key not valid') || error.message?.includes('API_KEY_INVALID')) {
      throw ApiError.badRequest(
        `Invalid ${provider.name} API key. Please check your AI settings and ensure a valid API key is configured.`,
      );
    }
    if (error.message?.includes('API key')) {
      throw ApiError.badRequest(
        `API key error: ${error.message}. Please check your AI settings.`,
      );
    }
    if (error.message?.includes('quota') || error.message?.includes('rate limit')) {
      throw ApiError.badRequest(
        `API quota or rate limit exceeded. Please try again later or check your ${provider.name} account limits.`,
      );
    }

    // Generic error fallback
    throw ApiError.badRequest(
      `Failed to generate glossary: ${error.message || 'Unknown error occurred'}. Please check your AI provider settings.`,
    );
  }

  // Parse JSON response
  let extractedTerms: Array<{ sourceTerm: string; targetTerm: string }>;
  try {
    // Remove markdown code block markers if present (```json ... ``` or ``` ... ```)
    let cleanedText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    
    // Try to extract JSON array from response (in case AI adds extra text)
    let jsonText = cleanedText.trim();
    
    // Find the start of the array
    const arrayStart = jsonText.indexOf('[');
    if (arrayStart === -1) {
      throw new Error('No JSON array found in response');
    }
    
    // Find the end of the array - need to balance brackets
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;
    let arrayEnd = -1;
    
    for (let i = arrayStart; i < jsonText.length; i++) {
      const char = jsonText[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '[') {
          bracketCount++;
        } else if (char === ']') {
          bracketCount--;
          if (bracketCount === 0) {
            arrayEnd = i;
            break;
          }
        }
      }
    }
    
    // If array is not properly closed, try to fix it
    if (arrayEnd === -1 || bracketCount !== 0) {
      logger.warn(
        {
          documentId,
          bracketCount,
          arrayStart,
          arrayEnd,
          jsonTextLength: jsonText.length,
        },
        'JSON array appears incomplete, attempting to fix',
      );
      
      // Find all complete objects by parsing forward
      // This is more reliable than working backwards
      inString = false;
      escapeNext = false;
      let braceDepth = 0;
      let objectStart = -1;
      const completeObjects: Array<{ start: number; end: number }> = [];
      
      // Parse forward to find all complete objects
      for (let i = arrayStart + 1; i < jsonText.length; i++) {
        const char = jsonText[i];
        
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        
        if (char === '"' && !escapeNext) {
          inString = !inString;
          continue;
        }
        
        if (!inString) {
          if (char === '{') {
            if (braceDepth === 0) {
              objectStart = i;
            }
            braceDepth++;
          } else if (char === '}') {
            braceDepth--;
            if (braceDepth === 0 && objectStart >= 0) {
              // Found a complete object
              completeObjects.push({ start: objectStart, end: i });
              objectStart = -1;
            }
          }
        }
      }
      
      if (completeObjects.length > 0) {
        // Reconstruct JSON array from complete objects
        const objectStrings = completeObjects.map((obj) => jsonText.substring(obj.start, obj.end + 1));
        jsonText = '[' + objectStrings.join(',\n') + '\n]';
        logger.info(
          {
            documentId,
            completeObjectsCount: completeObjects.length,
            fixedLength: jsonText.length,
            sampleObjects: objectStrings.slice(0, 2),
          },
          'Fixed incomplete JSON by reconstructing array from complete objects',
        );
      } else {
        // Fallback: try to find any } that might be an object end
        const simpleLastBrace = jsonText.lastIndexOf('}');
        if (simpleLastBrace > arrayStart) {
          let fixedJson = jsonText.substring(arrayStart, simpleLastBrace + 1);
          fixedJson = fixedJson.trim().replace(/,\s*$/, '') + '\n]';
          jsonText = fixedJson;
          logger.warn(
            { documentId, simpleLastBrace },
            'Using fallback method to fix incomplete JSON',
          );
        } else {
          throw new Error('JSON array is incomplete and cannot be fixed - no complete objects found');
        }
      }
    } else {
      // Extract the complete array
      jsonText = jsonText.substring(arrayStart, arrayEnd + 1);
    }
    
    const parsed = JSON.parse(jsonText);
    
    if (!Array.isArray(parsed)) {
      throw new Error('Response is not an array');
    }

    // Validate and normalize terms
    // Handle both "sourceTerm"/"targetTerm" and "source"/"target" field names
    logger.debug(
      {
        documentId,
        parsedArrayLength: parsed.length,
        firstItem: parsed[0],
        sampleItems: parsed.slice(0, 3),
      },
      'Parsed JSON array from AI response',
    );

    extractedTerms = parsed
      .map((item: any, index: number) => {
        if (!item || typeof item !== 'object') {
          logger.debug({ documentId, index, item }, 'Skipping invalid item (not an object)');
          return null;
        }
        
        // Support both field name formats
        const sourceTerm = String(
          item.sourceTerm || item.source || ''
        ).trim();
        const targetTerm = String(
          item.targetTerm || item.target || ''
        ).trim();
        
        if (!sourceTerm || !targetTerm) {
          logger.debug(
            { documentId, index, item, sourceTerm, targetTerm },
            'Skipping item with empty source or target term',
          );
          return null;
        }
        
        return { sourceTerm, targetTerm };
      })
      .filter((term): term is { sourceTerm: string; targetTerm: string } => term !== null);

    logger.info(
      {
        documentId,
        parsedArrayLength: parsed.length,
        extractedTermsCount: extractedTerms.length,
        sampleTerms: extractedTerms.slice(0, 3),
      },
      'Extracted glossary terms from AI response',
    );
  } catch (error: any) {
    logger.error(
      {
        documentId,
        error: error.message,
        responsePreview: responseText.substring(0, 500),
        fullResponse: responseText.length < 2000 ? responseText : responseText.substring(0, 2000) + '...',
      },
      'Failed to parse AI response as JSON',
    );
    throw ApiError.badRequest(`Failed to parse glossary extraction response: ${error.message}`);
  }

  if (extractedTerms.length === 0) {
    logger.warn(
      {
        documentId,
        responsePreview: responseText.substring(0, 500),
        parsedArrayLength: parsed?.length,
      },
      'No glossary terms extracted from document',
    );
    return { count: 0 };
  }

  // Remove duplicates (same sourceTerm and targetTerm combination)
  const uniqueTerms = Array.from(
    new Map(
      extractedTerms.map((term) => [
        `${term.sourceTerm.toLowerCase()}|${term.targetTerm.toLowerCase()}`,
        term,
      ]),
    ).values(),
  );

  // Prepare data for DocumentGlossaryEntry
  const entriesToCreate = uniqueTerms.map((term) => ({
    documentId,
    sourceTerm: term.sourceTerm,
    targetTerm: term.targetTerm,
  }));

  // Check for existing entries to avoid duplicates
  const existingEntries = await prisma.documentGlossaryEntry.findMany({
    where: {
      documentId,
      OR: uniqueTerms.map((term) => ({
        sourceTerm: term.sourceTerm,
        targetTerm: term.targetTerm,
      })),
    },
    select: { sourceTerm: true, targetTerm: true },
  });

  // Create a set of existing term pairs for quick lookup
  const existingPairs = new Set(
    existingEntries.map((e) => `${e.sourceTerm.toLowerCase()}|${e.targetTerm.toLowerCase()}`),
  );

  // Filter out existing entries
  const newEntries = entriesToCreate.filter(
    (entry) => !existingPairs.has(`${entry.sourceTerm.toLowerCase()}|${entry.targetTerm.toLowerCase()}`),
  );

  if (newEntries.length === 0) {
    logger.info({ documentId, totalExtracted: uniqueTerms.length }, 'All extracted terms already exist in glossary');
    return { count: 0 };
  }

  // Save to DocumentGlossaryEntry using createMany
  const result = await prisma.documentGlossaryEntry.createMany({
    data: newEntries,
    skipDuplicates: true, // Extra safety
  });

  logger.info(
    {
      documentId,
      extracted: uniqueTerms.length,
      newEntries: result.count,
      skipped: uniqueTerms.length - result.count,
    },
    'Glossary generation completed',
  );

  return { count: result.count };
};

/**
 * List glossary entries for a specific document with status lookup
 */
// Helper function to normalize locale for matching (handles "ru" vs "ru-RU" variations)
const normalizeLocaleForMatching = (locale: string): string => {
  // Convert to lowercase and remove any whitespace
  return locale.toLowerCase().trim();
};

// Helper function to check if two locales match (handles "ru" vs "ru-RU" variations)
const localesMatch = (locale1: string, locale2: string): boolean => {
  const norm1 = normalizeLocaleForMatching(locale1);
  const norm2 = normalizeLocaleForMatching(locale2);
  
  // Exact match
  if (norm1 === norm2) return true;
  
  // Check if one is a prefix of the other (e.g., "ru" matches "ru-ru" or "ru-us")
  if (norm1.startsWith(norm2 + '-') || norm2.startsWith(norm1 + '-')) return true;
  
  // Check if they share the same base language (e.g., "ru" matches "ru-ru")
  const base1 = norm1.split('-')[0];
  const base2 = norm2.split('-')[0];
  if (base1 === base2 && (norm1.length <= 3 || norm2.length <= 3)) return true;
  
  return false;
};

export const listDocumentGlossary = async (documentId: string) => {
  try {
    // Get document to access sourceLocale and targetLocale
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        sourceLocale: true,
        targetLocale: true,
        projectId: true,
      },
    });

    if (!document) {
      throw ApiError.notFound('Document not found');
    }

    // Fetch all DocumentGlossaryEntry records for this document
    const documentEntries = await prisma.documentGlossaryEntry.findMany({
      where: { documentId },
      orderBy: { sourceTerm: 'asc' },
    });

    // If no entries, return empty array
    if (documentEntries.length === 0) {
      return [];
    }

    // For each entry, lookup the matching GlossaryEntry to get status
    const entriesWithStatus = await Promise.all(
      documentEntries.map(async (entry) => {
        // Try to find matching GlossaryEntry (first check global, then project)
        let glossaryStatus: string | undefined = undefined;
        
        try {
          // First, try exact match with case-insensitive locales
          let glossaryEntry = await prisma.glossaryEntry.findFirst({
            where: {
              projectId: null, // Global first
              sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
              sourceLocale: { equals: document.sourceLocale, mode: 'insensitive' },
              targetLocale: { equals: document.targetLocale, mode: 'insensitive' },
            },
            select: {
              status: true,
              sourceLocale: true,
              targetLocale: true,
            },
          });

          // If not found with exact locale match, try flexible locale matching
          if (!glossaryEntry) {
            // Fetch all global entries with matching source term
            const candidateEntries = await prisma.glossaryEntry.findMany({
              where: {
                projectId: null,
                sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
              },
              select: {
                status: true,
                sourceLocale: true,
                targetLocale: true,
              },
            });
            
            // Find entry with matching locales (flexible matching)
            glossaryEntry = candidateEntries.find(
              (candidate) =>
                localesMatch(candidate.sourceLocale, document.sourceLocale) &&
                localesMatch(candidate.targetLocale, document.targetLocale)
            );
          }

          if (glossaryEntry && glossaryEntry.status) {
            glossaryStatus = glossaryEntry.status;
            logger.debug(
              { 
                documentId, 
                sourceTerm: entry.sourceTerm,
                foundStatus: glossaryStatus,
                foundSourceLocale: glossaryEntry.sourceLocale,
                foundTargetLocale: glossaryEntry.targetLocale,
                documentSourceLocale: document.sourceLocale,
                documentTargetLocale: document.targetLocale,
              },
              'Found matching global glossary entry',
            );
          } else {
            // If not found in global, check project-specific with flexible matching
            let projectEntry = await prisma.glossaryEntry.findFirst({
              where: {
                projectId: document.projectId,
                sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
                sourceLocale: { equals: document.sourceLocale, mode: 'insensitive' },
                targetLocale: { equals: document.targetLocale, mode: 'insensitive' },
              },
              select: {
                status: true,
                sourceLocale: true,
                targetLocale: true,
              },
            });
            
            // If not found with exact match, try flexible matching
            if (!projectEntry) {
              const candidateProjectEntries = await prisma.glossaryEntry.findMany({
                where: {
                  projectId: document.projectId,
                  sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
                },
                select: {
                  status: true,
                  sourceLocale: true,
                  targetLocale: true,
                },
              });
              
              projectEntry = candidateProjectEntries.find(
                (candidate) =>
                  localesMatch(candidate.sourceLocale, document.sourceLocale) &&
                  localesMatch(candidate.targetLocale, document.targetLocale)
              );
            }
            
            if (projectEntry && projectEntry.status) {
              glossaryStatus = projectEntry.status;
              logger.debug(
                { documentId, sourceTerm: entry.sourceTerm, foundStatus: glossaryStatus },
                'Found matching project glossary entry',
              );
            }
          }
        } catch (error: any) {
          // If lookup fails, just continue without status (will default to CANDIDATE)
          logger.debug(
            { documentId, sourceTerm: entry.sourceTerm, error: error.message },
            'Failed to lookup glossary entry status, defaulting to CANDIDATE',
          );
          glossaryStatus = undefined;
        }

        // Map status: PREFERRED -> APPROVED, CANDIDATE -> CANDIDATE, DEPRECATED -> DEPRECATED
        // Always ensure status is set (default to CANDIDATE if not found)
        let status: 'CANDIDATE' | 'APPROVED' | 'DEPRECATED' = 'CANDIDATE';
        if (glossaryStatus) {
          if (glossaryStatus === 'PREFERRED') {
            status = 'APPROVED';
          } else if (glossaryStatus === 'DEPRECATED') {
            status = 'DEPRECATED';
          } else if (glossaryStatus === 'CANDIDATE') {
            status = 'CANDIDATE';
          }
          // If glossaryStatus is any other value, keep default 'CANDIDATE'
        }
        
        // Debug logging to help diagnose missing approved terms
        if (status === 'CANDIDATE' && !glossaryStatus) {
          logger.debug(
            { 
              documentId, 
              sourceTerm: entry.sourceTerm,
              sourceLocale: document.sourceLocale,
              targetLocale: document.targetLocale,
              projectId: document.projectId,
            },
            'Term defaulting to CANDIDATE - no GlossaryEntry found with status',
          );
        }

        // Ensure frequency is always a valid number (default to 1 if missing or invalid)
        const frequency = typeof entry.occurrenceCount === 'number' && entry.occurrenceCount > 0 
          ? entry.occurrenceCount 
          : 1;

        return {
          id: entry.id,
          sourceTerm: entry.sourceTerm,
          targetTerm: entry.targetTerm,
          frequency,
          status,
        };
      }),
    );

    return entriesWithStatus;
  } catch (error: any) {
    logger.error(
      { documentId, error: error.message, stack: error.stack },
      'Error in listDocumentGlossary',
    );
    throw ApiError.badRequest(`Failed to fetch document glossary: ${error.message || 'Unknown error'}`);
  }
};

/**
 * Updates a document glossary entry by finding/creating the corresponding GlossaryEntry
 * and updating its status and/or targetTerm
 */
export const updateDocumentGlossaryEntry = async (
  documentGlossaryEntryId: string,
  data: {
    status?: 'PREFERRED' | 'DEPRECATED' | 'CANDIDATE';
    targetTerm?: string;
  },
) => {
  // Get the DocumentGlossaryEntry
  const documentEntry = await prisma.documentGlossaryEntry.findUnique({
    where: { id: documentGlossaryEntryId },
    include: {
      document: {
        select: {
          sourceLocale: true,
          targetLocale: true,
          projectId: true,
        },
      },
    },
  });

  if (!documentEntry) {
    throw ApiError.notFound('Document glossary entry not found');
  }

  const { document } = documentEntry;

  // Find or create the corresponding GlossaryEntry
  // First check global (projectId: null)
  let glossaryEntry = await prisma.glossaryEntry.findFirst({
    where: {
      projectId: null,
      sourceTerm: { equals: documentEntry.sourceTerm, mode: 'insensitive' },
      sourceLocale: document.sourceLocale,
      targetLocale: document.targetLocale,
    },
  });

  // If not found in global, check project-specific
  if (!glossaryEntry) {
    glossaryEntry = await prisma.glossaryEntry.findFirst({
      where: {
        projectId: document.projectId,
        sourceTerm: { equals: documentEntry.sourceTerm, mode: 'insensitive' },
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
      },
    });
  }

  // If still not found, create a new GlossaryEntry
  if (!glossaryEntry) {
    const statusToSave = data.status === 'CANDIDATE' ? 'CANDIDATE' : data.status || 'CANDIDATE';
    glossaryEntry = await prisma.glossaryEntry.create({
      data: {
        sourceTerm: documentEntry.sourceTerm,
        targetTerm: data.targetTerm || documentEntry.targetTerm,
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
        direction: `${document.sourceLocale}-${document.targetLocale}`,
        projectId: document.projectId, // Create in project scope
        status: statusToSave as any,
      },
    });
  } else {
    // Update existing GlossaryEntry
    const updateData: any = {};
    if (data.status !== undefined) {
      updateData.status = data.status === 'CANDIDATE' ? 'CANDIDATE' : data.status;
    }
    if (data.targetTerm !== undefined) {
      updateData.targetTerm = data.targetTerm;
    }

    if (Object.keys(updateData).length > 0) {
      glossaryEntry = await prisma.glossaryEntry.update({
        where: { id: glossaryEntry.id },
        data: updateData,
      });
    }
  }

  // Also update the DocumentGlossaryEntry if targetTerm changed
  if (data.targetTerm !== undefined && data.targetTerm !== documentEntry.targetTerm) {
    await prisma.documentGlossaryEntry.update({
      where: { id: documentGlossaryEntryId },
      data: { targetTerm: data.targetTerm },
    });
  }

  return {
    id: documentGlossaryEntryId,
    sourceTerm: documentEntry.sourceTerm,
    targetTerm: glossaryEntry.targetTerm,
    status: glossaryEntry.status === 'PREFERRED' ? 'APPROVED' : glossaryEntry.status === 'DEPRECATED' ? 'DEPRECATED' : 'CANDIDATE',
  };
};
