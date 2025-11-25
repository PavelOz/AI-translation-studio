import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import type { GlossaryEntry as PrismaGlossaryEntry } from '@prisma/client';

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
}) => {
  // Map 'forbidden' to 'isForbidden' for Prisma schema
  // Normalize terms by trimming whitespace
  // Generate direction from sourceLocale and targetLocale
  const { forbidden, status, description, notes, ...rest } = data;
  
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
  };

  // If updating existing entry by ID
  if (data.id) {
    const updated = await prisma.glossaryEntry.update({
      where: { id: data.id },
      data: prismaData,
    });
    
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

export const importGlossaryCsv = async (buffer: Buffer, projectId?: string) => {
  const content = buffer.toString('utf-8');
  const rows = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rows.length <= 1) {
    throw ApiError.badRequest('CSV must contain at least one data row');
  }

  const header = rows[0].split(',').map((value) => value.trim().toLowerCase());
  const getIndex = (key: string) => header.indexOf(key);
  const sourceIdx = getIndex('term_source');
  const targetIdx = getIndex('term_target');
  if (sourceIdx === -1 || targetIdx === -1) {
    throw ApiError.badRequest('CSV must include term_source and term_target columns');
  }
  const notesIdx = getIndex('notes');
  const forbiddenIdx = getIndex('forbidden');

  const entries = rows.slice(1).map((row) => {
    const columns = row.split(',').map((value) => value.trim());
    // Generate direction from sourceLocale and targetLocale
    const sourceLocale = 'source'; // TODO: Should be provided in CSV or request
    const targetLocale = 'target'; // TODO: Should be provided in CSV or request
    const direction = `${sourceLocale}-${targetLocale}`;
    
    return {
      projectId,
      sourceTerm: columns[sourceIdx],
      targetTerm: columns[targetIdx],
      sourceLocale,
      targetLocale,
      direction, // Required field in Prisma schema
      notes: notesIdx >= 0 ? columns[notesIdx] : undefined,
      isForbidden:
        forbiddenIdx >= 0 ? ['true', '1', 'yes'].includes(columns[forbiddenIdx]?.toLowerCase()) : false,
    };
  });

  // Use skipDuplicates to prevent duplicate entries during import
  // This will skip entries that have the same combination of:
  // sourceTerm, targetTerm, sourceLocale, targetLocale, and projectId
  const result = await prisma.glossaryEntry.createMany({
    data: entries,
    skipDuplicates: true, // Skip duplicates instead of throwing error
  });

  return { imported: result.count };
};
