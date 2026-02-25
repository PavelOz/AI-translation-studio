/**
 * UniversalFileService – zero-risk facade over existing file handlers.
 *
 * Uses resolveHandler() to delegate to DocxHandler, XlsxHandler, or XliffHandler.
 * No logic change: segmentIndex, metadata, and originalStructure pass through unchanged
 * so document structure (e.g. KEGOC DOCX/XLSX) is preserved.
 */

import { resolveHandler } from '../utils/file-handlers';
import type {
  ParsedFileResult,
  ExportOptions,
  ParseOptions,
} from '../utils/file-handlers/types';

/**
 * Parse a document buffer using the appropriate handler (DOCX, XLSX, or XLIFF).
 * Segments, metadata, totalWords, and originalStructure are returned as-is from the handler.
 *
 * @param buffer - Raw file content
 * @param filename - Original filename (used to resolve handler by extension)
 * @param mimetype - Optional MIME type for resolution
 * @param options - Parse options (e.g. segmentationMode)
 * @returns ParsedFileResult with segments and metadata unchanged (critical for structure preservation)
 */
export async function parse(
  buffer: Buffer,
  filename: string,
  mimetype?: string,
  options?: ParseOptions,
): Promise<ParsedFileResult> {
  const handler = resolveHandler(filename, mimetype);
  if (!handler) {
    throw new Error(`Unsupported file format: ${filename}`);
  }
  const result = await handler.parse(buffer, options);
  // Pass-through: do not mutate segments, metadata, or originalStructure
  return result;
}

/**
 * Export a document by injecting translated segments into the original file buffer.
 * Uses the same handler as import; segment index and metadata are passed through
 * so XML/DOM order (DOCX) and sharedStrings mapping (XLSX) remain correct.
 *
 * @param options - ExportOptions with segments (index, targetText, metadata), originalBuffer, metadata
 * @param filename - Document filename (used to resolve handler by extension)
 * @returns Buffer of the exported file
 */
export async function exportDocument(
  options: ExportOptions,
  filename: string,
): Promise<Buffer> {
  const handler = resolveHandler(filename, undefined);
  if (!handler) {
    throw new Error(`Unsupported file format: ${filename}`);
  }
  if (!handler.export) {
    throw new Error(`Export not supported for this file format: ${filename}`);
  }
  // Pass-through: options.segments (index, targetText, metadata) and options.originalBuffer unchanged
  return handler.export(options);
}
