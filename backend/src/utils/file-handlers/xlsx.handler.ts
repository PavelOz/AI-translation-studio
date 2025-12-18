import JSZip from 'jszip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { FileHandler, ParsedFileResult, ExportOptions } from './types';

type XlsxStructure = {
  sharedStrings: string[];
  worksheets: Array<{
    name: string;
    cells: Array<{
      row: number;
      col: number;
      type: 'sharedString' | 'inlineStr' | 'number' | 'formula';
      value: string | number;
      sharedStringIndex?: number;
      formula?: string;
      style?: number;
    }>;
  }>;
  styles?: unknown;
};

export class XlsxHandler implements FileHandler {
  private parser = new XMLParser({ 
    ignoreAttributes: false, 
    attributeNamePrefix: '@_', 
    preserveOrder: false, // Changed to false for better compatibility
    trimValues: true,
    parseAttributeValue: true,
  });
  private builder = new XMLBuilder({ 
    ignoreAttributes: false, 
    attributeNamePrefix: '@_', 
    format: true, 
    preserveOrder: false,
  });

  supports(_mimeType: string | undefined, extension: string): boolean {
    return extension === '.xlsx';
  }

  async parse(buffer: Buffer): Promise<ParsedFileResult> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch (error) {
      throw new Error(`Invalid XLSX file: ${(error as Error).message}`);
    }

    // Try to load shared strings (may not exist in all Excel files)
    const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string');
    let sharedStrings: string[] = [];
    
    if (sharedStringsXml) {
      try {
        const sharedStringsParsed = this.parser.parse(sharedStringsXml);
        const siArray = sharedStringsParsed['sst']?.['si'] ?? [];
        const siItems = Array.isArray(siArray) ? siArray : siArray ? [siArray] : [];

        sharedStrings = siItems.map((si: any) => {
          const t = si.t;
          if (typeof t === 'string') return t;
          if (Array.isArray(t)) return t.map((item: any) => (typeof item === 'string' ? item : item['#text'] ?? '')).join('');
          return t?.['#text'] ?? '';
        });
      } catch (error) {
        // If shared strings parsing fails, continue without them
        console.warn('Failed to parse shared strings:', error);
      }
    }

    const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
    if (!workbookXml) {
      throw new Error('Invalid XLSX: missing xl/workbook.xml');
    }

    let workbookParsed: any;
    try {
      workbookParsed = this.parser.parse(workbookXml);
    } catch (error) {
      throw new Error(`Failed to parse workbook.xml: ${(error as Error).message}`);
    }

    // First, check if there are any worksheet files in the zip
    const allWorksheetFiles = Object.keys(zip.files).filter((name) => 
      name.startsWith('xl/worksheets/') && name.endsWith('.xml') && !name.includes('_rels')
    );

    // Try multiple possible structures for sheets
    let sheets: any[] = [];
    
    // Structure 1: workbook.sheets.sheet (most common)
    if (workbookParsed.workbook?.sheets?.sheet) {
      const sheetData = workbookParsed.workbook.sheets.sheet;
      sheets = Array.isArray(sheetData) ? sheetData : [sheetData];
    }
    // Structure 2: workbook.sheet
    else if (workbookParsed.workbook?.sheet) {
      const sheetData = workbookParsed.workbook.sheet;
      sheets = Array.isArray(sheetData) ? sheetData : [sheetData];
    }
    // Structure 3: sheets.sheet (no workbook wrapper)
    else if (workbookParsed.sheets?.sheet) {
      const sheetData = workbookParsed.sheets.sheet;
      sheets = Array.isArray(sheetData) ? sheetData : [sheetData];
    }
    // Structure 4: sheet (direct)
    else if (workbookParsed.sheet) {
      const sheetData = workbookParsed.sheet;
      sheets = Array.isArray(sheetData) ? sheetData : [sheetData];
    }

    // Normalize to array
    let sheetArray = Array.isArray(sheets) ? sheets : sheets ? [sheets] : [];

    // Fallback: If we couldn't find sheets in workbook.xml, try to find worksheets directly
    if (sheetArray.length === 0 && allWorksheetFiles.length > 0) {
      // Extract sheet IDs from filenames and create sheet objects
      console.warn('Could not parse workbook.xml structure, extracting sheets from filenames');
      sheetArray = allWorksheetFiles.map((filename, index) => {
        const match = filename.match(/sheet(\d+)\.xml/i);
        const sheetId = match ? match[1] : String(index + 1);
        return {
          '@_sheetId': sheetId,
          '@_name': `Sheet${index + 1}`,
        };
      });
    }

    if (sheetArray.length === 0) {
      // Provide helpful debugging info
      const availableFiles = Object.keys(zip.files).filter((name) => 
        name.startsWith('xl/') && name.endsWith('.xml')
      );
      const workbookKeys = JSON.stringify(Object.keys(workbookParsed)).substring(0, 500);
      const workbookSample = JSON.stringify(workbookParsed).substring(0, 1000);
      
      throw new Error(
        `XLSX file contains no worksheets. ` +
        `Found ${allWorksheetFiles.length} worksheet files: ${allWorksheetFiles.join(', ')}. ` +
        `Workbook keys: ${workbookKeys}. ` +
        `Workbook sample: ${workbookSample}. ` +
        `Available XML files in xl/: ${availableFiles.join(', ')}`
      );
    }

    const segments: Array<{ index: number; sourceText: string; sharedStringIndex?: number }> = [];
    const structure: XlsxStructure = {
      sharedStrings,
      worksheets: [],
    };

    for (const sheet of sheetArray) {
      const sheetId = sheet['@_sheetId'] ?? sheet['sheetId'] ?? sheet['@_id'] ?? sheet['id'];
      const sheetName = sheet['@_name'] ?? sheet['name'] ?? `Sheet${sheetId}`;
      
      // Try multiple possible worksheet file paths
      let sheetRelsXml: string | undefined;
      const possiblePaths = [
        `xl/worksheets/sheet${sheetId}.xml`,
        `xl/worksheets/Sheet${sheetId}.xml`,
      ];
      
      for (const path of possiblePaths) {
        sheetRelsXml = await zip.file(path)?.async('string');
        if (sheetRelsXml) break;
      }
      
      // If still not found, try to find by index
      if (!sheetRelsXml) {
        const worksheetFiles = Object.keys(zip.files).filter((name) => 
          name.startsWith('xl/worksheets/') && name.endsWith('.xml')
        ).sort();
        if (worksheetFiles.length > 0) {
          // Try to match by index if sheetId is numeric
          const sheetIndex = parseInt(String(sheetId), 10);
          if (!isNaN(sheetIndex) && worksheetFiles[sheetIndex - 1]) {
            sheetRelsXml = await zip.file(worksheetFiles[sheetIndex - 1])?.async('string');
          } else if (worksheetFiles[0]) {
            // Fallback to first worksheet
            sheetRelsXml = await zip.file(worksheetFiles[0])?.async('string');
          }
        }
      }
      
      if (!sheetRelsXml) {
        const availableFiles = Object.keys(zip.files).filter((name) => name.startsWith('xl/worksheets/'));
        console.warn(`Sheet ${sheetId} (${sheetName}) not found. Available worksheets: ${availableFiles.join(', ')}`);
        continue;
      }

      let sheetParsed: any;
      try {
        sheetParsed = this.parser.parse(sheetRelsXml);
      } catch (error) {
        console.warn(`Failed to parse sheet ${sheetId}:`, error);
        continue;
      }

      const sheetData = sheetParsed.worksheet?.sheetData?.row ?? [];
      const rows = Array.isArray(sheetData) ? sheetData : sheetData ? [sheetData] : [];

      const cells: XlsxStructure['worksheets'][0]['cells'] = [];

      for (const row of rows) {
        const rowNum = parseInt(row['@_r'] ?? '0', 10);
        const rowCells = row.c ?? [];
        const cellArray = Array.isArray(rowCells) ? rowCells : rowCells ? [rowCells] : [];

        for (const cell of cellArray) {
          const cellRef = cell['@_r'] ?? '';
          const cellType = cell['@_t'] ?? 'n';
          const cellValue = cell.v;
          const cellFormula = cell.f;
          const cellStyle = cell['@_s'];
          let cellText = '';

          // Extract text based on cell type
          if (cellType === 's' && typeof cellValue === 'string') {
            // Shared string reference
            const sharedIndex = parseInt(cellValue, 10);
            if (!isNaN(sharedIndex) && sharedStrings[sharedIndex]) {
              cellText = sharedStrings[sharedIndex];
            }
          } else if (cellType === 'inlineStr') {
            // Inline string
            const is = cell.is;
            if (is) {
              const t = is.t;
              if (typeof t === 'string') {
                cellText = t;
              } else if (Array.isArray(t)) {
                cellText = t.map((item: any) => (typeof item === 'string' ? item : item['#text'] ?? '')).join('');
              } else {
                cellText = t?.['#text'] ?? '';
              }
            }
          } else if (cellValue !== undefined && cellValue !== null) {
            // Number, date, or other value - convert to string
            cellText = String(cellValue);
          }

          // Only add non-empty text as a segment
          if (cellText.trim()) {
            segments.push({
              index: segments.length,
              sourceText: cellText.trim(),
              sharedStringIndex: cellType === 's' && typeof cellValue === 'string' ? parseInt(cellValue, 10) : undefined,
            });
          }

          cells.push({
            row: rowNum,
            col: this.cellRefToCol(cellRef),
            type: cellType === 's' ? 'sharedString' : cellType === 'inlineStr' ? 'inlineStr' : cellFormula ? 'formula' : 'number',
            value: cellType === 's' ? parseInt(cellValue, 10) : cellValue ?? '',
            sharedStringIndex: cellType === 's' && typeof cellValue === 'string' ? parseInt(cellValue, 10) : undefined,
            formula: cellFormula?.['#text'] ?? cellFormula,
            style: cellStyle ? parseInt(cellStyle, 10) : undefined,
          });
        }
      }

      structure.worksheets.push({ name: sheetName, cells });
    }

    if (segments.length === 0) {
      throw new Error('XLSX file does not contain any text cells to translate. Please ensure the file has text content.');
    }

    return {
      segments: segments.map((seg) => ({
        index: seg.index,
        sourceText: seg.sourceText,
        metadata: {
          sharedStringIndex: seg.sharedStringIndex,
        },
      })),
      metadata: {
        type: 'xlsx',
        sharedStringCount: sharedStrings.length,
        segmentCount: segments.length,
        sheetCount: structure.worksheets.length,
      },
      totalWords: segments.reduce((acc, seg) => acc + seg.sourceText.split(/\s+/).filter(Boolean).length, 0),
      originalStructure: structure,
    };
  }

  private cellRefToCol(ref: string): number {
    let col = 0;
    for (let i = 0; i < ref.length; i++) {
      const char = ref[i];
      if (char >= 'A' && char <= 'Z') {
        col = col * 26 + (char.charCodeAt(0) - 'A'.charCodeAt(0) + 1);
      } else {
        break;
      }
    }
    return col - 1;
  }

  private colToCellRef(col: number, row: number): string {
    let ref = '';
    let c = col + 1;
    while (c > 0) {
      const remainder = (c - 1) % 26;
      ref = String.fromCharCode('A'.charCodeAt(0) + remainder) + ref;
      c = Math.floor((c - 1) / 26);
    }
    return ref + row;
  }

  async export(options: ExportOptions): Promise<Buffer> {
    if (!options.originalBuffer) {
      throw new Error('Original XLSX buffer required for export');
    }

    const zip = await JSZip.loadAsync(options.originalBuffer);
    const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string');
    if (!sharedStringsXml) {
      throw new Error('Invalid XLSX: missing xl/sharedStrings.xml');
    }

    const sharedStringsParsed = this.parser.parse(sharedStringsXml);
    const siArray = sharedStringsParsed['sst']?.['si'] ?? [];
    const siItems = Array.isArray(siArray) ? siArray : siArray ? [siArray] : [];

    const segmentMap = new Map(options.segments.map((seg) => [seg.index, seg.targetText]));

    for (let i = 0; i < siItems.length; i++) {
      const translatedText = segmentMap.get(i);
      if (translatedText !== undefined) {
        siItems[i] = {
          t: { '#text': translatedText },
        };
      }
    }

    sharedStringsParsed['sst']['si'] = siItems;
    const updatedSharedStringsXml = this.builder.build(sharedStringsParsed);
    zip.file('xl/sharedStrings.xml', updatedSharedStringsXml);

    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }
}
