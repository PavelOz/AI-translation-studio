import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
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
  
  return {
    id: entry.id,
    projectId: entry.projectId || undefined,
    sourceTerm: entry.sourceTerm,
    targetTerm: entry.targetTerm,
    sourceLocale: entry.sourceLocale,
    targetLocale: entry.targetLocale,
    description,
    status: 'PREFERRED' as const, // Default status (not in Prisma schema)
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
  sourceTerm: string;
  targetTerm: string;
  sourceLocale: string;
  targetLocale: string;
  description?: string;
  status?: 'PREFERRED' | 'DEPRECATED'; // Not used in Prisma, kept for API compatibility
  forbidden?: boolean; // API accepts 'forbidden' for backward compatibility
  notes?: string;
  contextRules?: ContextRules;
}) => {
  // Map 'forbidden' to 'isForbidden' for Prisma schema
  // Normalize terms by trimming whitespace
  // Generate direction from sourceLocale and targetLocale
  const { forbidden, status, description, notes, contextRules, ...rest } = data;
  
  // Generate direction string (e.g., "ru-en", "en-ru")
  const direction = `${data.sourceLocale}-${data.targetLocale}`;
  
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
  
  const prismaData = {
    ...rest,
    sourceTerm: data.sourceTerm.trim(),
    targetTerm: data.targetTerm.trim(),
    direction, // Required field in Prisma schema
    isForbidden: forbidden ?? false,
    notes: combinedNotes,
    contextRules: contextRules ? (contextRules as any) : undefined,
  };

  // If updating existing entry by ID
  if (data.id) {
    const updated = await prisma.glossaryEntry.update({
      where: { id: data.id },
      data: prismaData,
    });
    
    // Regenerate embedding if sourceTerm changed (in background)
    const oldEntry = await prisma.glossaryEntry.findUnique({
      where: { id: data.id },
      select: { sourceTerm: true },
    });
    
    if (oldEntry && oldEntry.sourceTerm !== prismaData.sourceTerm) {
      // Source term changed, regenerate embedding
      (async () => {
        try {
          // First, clear existing embedding
          await prisma.$executeRawUnsafe(
            `UPDATE "GlossaryEntry" SET "sourceEmbedding" = NULL, "embeddingUpdatedAt" = NULL WHERE id = $1`,
            data.id,
          );
          
          const { generateEmbeddingForGlossaryEntry } = await import('./embedding-generation.service');
          await generateEmbeddingForGlossaryEntry(data.id);
          logger.debug({ entryId: data.id }, 'Background glossary embedding regenerated successfully');
        } catch (error: any) {
          logger.debug(
            {
              entryId: data.id,
              error: error.message,
            },
            'Background glossary embedding regeneration failed (non-critical)',
          );
        }
      })();
    }
    
    // Map Prisma schema to API response format
    return mapPrismaToApi(updated);
  }

  // For new entries, check for duplicates first
  // A duplicate is defined as: same sourceTerm, targetTerm, sourceLocale, targetLocale, and projectId
  // Normalize terms by trimming whitespace for comparison
  const normalizedSourceTerm = data.sourceTerm.trim();
  const normalizedTargetTerm = data.targetTerm.trim();
  
  // Build where clause for duplicate check
  // Handle projectId: null and undefined both mean "global entry"
  const duplicateWhere: any = {
    sourceTerm: normalizedSourceTerm,
    targetTerm: normalizedTargetTerm,
    sourceLocale: data.sourceLocale,
    targetLocale: data.targetLocale,
  };
  
  // For global entries (no projectId), check for entries with null projectId
  if (data.projectId) {
    duplicateWhere.projectId = data.projectId;
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
