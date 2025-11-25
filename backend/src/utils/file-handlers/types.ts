export type SegmentType = 'paragraph' | 'table-cell' | 'header' | 'footer' | 'cell' | 'sheet' | 'unit';

export type ParsedSegment = {
  index: number;
  sourceText: string;
  type: SegmentType; // Type of segment: paragraph, table cell, etc.
  targetMt?: string;
  targetFinal?: string;
  tags?: string[]; // For XLIFF: preserved tags like <g>, <x>, <ph>
  metadata?: Record<string, unknown>; // Format-specific metadata (styles, formatting, etc.)
};

export type ParsedFileResult = {
  segments: ParsedSegment[];
  metadata?: Record<string, unknown>;
  totalWords?: number;
  originalStructure?: unknown; // Preserved structure for rebuild
};

export type ExportOptions = {
  segments: Array<{ index: number; targetText: string }>;
  originalBuffer?: Buffer;
  metadata?: Record<string, unknown>;
};

export interface FileHandler {
  supports: (mimeType: string | undefined, extension: string) => boolean;
  parse: (buffer: Buffer) => Promise<ParsedFileResult>;
  export?: (options: ExportOptions) => Promise<Buffer>;
}

