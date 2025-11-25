import JSZip from 'jszip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { FileHandler, ParsedFileResult, ExportOptions } from './types';

type DocxParagraph = {
  index: number;
  runs: Array<{
    text: string;
    properties?: Record<string, unknown>;
  }>;
  properties?: Record<string, unknown>;
};

type DocxStructure = {
  paragraphs: DocxParagraph[];
  styles?: unknown;
  relationships?: unknown;
};

export class DocxHandler implements FileHandler {
  // Temporarily disable preserveOrder to fix upload issues
  // TODO: Implement proper order preservation using a different approach
  private parser = new XMLParser({ 
    ignoreAttributes: false, 
    attributeNamePrefix: '@_', 
    preserveOrder: false,
    trimValues: false,
  });
  private builder = new XMLBuilder({ 
    ignoreAttributes: false, 
    attributeNamePrefix: '@_', 
    format: true, 
    preserveOrder: false,
  });

  supports(mimeType: string | undefined, extension: string): boolean {
    return extension === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  async parse(buffer: Buffer): Promise<ParsedFileResult> {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const documentXml = await zip.file('word/document.xml')?.async('string');
      if (!documentXml) {
        throw new Error('Invalid DOCX: missing word/document.xml');
      }

      const parsed = this.parser.parse(documentXml);
      const body = parsed['w:document']?.['w:body'] ?? {};
      
      // Get paragraphs and tables from body
      // Note: With preserveOrder: false, we can't determine exact order, so paragraphs come first, then tables
      const paragraphs = body['w:p'] ?? [];
      const tables = body['w:tbl'] ?? [];
      const paragraphArray = Array.isArray(paragraphs) ? paragraphs : paragraphs ? [paragraphs] : [];
      const tableArray = Array.isArray(tables) ? tables : tables ? [tables] : [];
      
      // Combine in order: paragraphs first, then tables
      // TODO: Implement proper order preservation using XML parsing or different library
      const bodyElements: Array<{ 'w:p'?: any; 'w:tbl'?: any }> = [
        ...paragraphArray.map((p: any) => ({ 'w:p': p })),
        ...tableArray.map((t: any) => ({ 'w:tbl': t })),
      ];
      
      if (bodyElements.length === 0) {
        throw new Error('Document body is empty or could not be parsed');
      }

    const segments: DocxParagraph[] = [];
    let segmentIndex = 0;

    // Helper function to extract text from runs
    const extractTextFromRuns = (runs: any[]): string => {
      const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
      const textRuns = runArray
        .map((run: any) => {
          const textNode = run['w:t'];
          if (!textNode) return null;
          
          let text: string = '';
          if (Array.isArray(textNode)) {
            text = textNode
              .map((t: any) => {
                if (typeof t === 'string') return t;
                if (typeof t === 'object' && t !== null) {
                  return typeof t['#text'] === 'string' ? t['#text'] : '';
                }
                return '';
              })
              .join('');
          } else if (typeof textNode === 'string') {
            text = textNode;
          } else if (typeof textNode === 'object' && textNode !== null) {
            if (typeof textNode['#text'] === 'string') {
              text = textNode['#text'];
            } else if (typeof textNode['#text'] === 'object' && textNode['#text'] !== null) {
              const nestedText = textNode['#text'];
              if (Array.isArray(nestedText)) {
                text = nestedText
                  .map((nt: any) => (typeof nt === 'string' ? nt : ''))
                  .join('');
              } else if (typeof nestedText === 'string') {
                text = nestedText;
              }
            }
          }
          
          const trimmedText = typeof text === 'string' ? text.trim() : '';
          if (!trimmedText) return null;
          
          return trimmedText;
        })
        .filter((t): t is string => t !== null && t.length > 0);
      
      return textRuns.join(' ').trim();
    };

    // Process body elements in order (preserving document structure)
    for (const bodyElement of bodyElements) {
      if (!bodyElement || typeof bodyElement !== 'object') continue;

      // Check if this is a paragraph
      if ('w:p' in bodyElement) {
        const para = bodyElement['w:p'];
        if (!para) continue;

        const runs = para['w:r'] ?? [];
        const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
        const textRuns = runArray
          .map((run: any) => {
            const textNode = run['w:t'];
            if (!textNode) return null;
            
            // Extract text from various possible structures
            let text: string = '';
            if (Array.isArray(textNode)) {
              text = textNode
                .map((t: any) => {
                  if (typeof t === 'string') return t;
                  if (typeof t === 'object' && t !== null) {
                    return typeof t['#text'] === 'string' ? t['#text'] : '';
                  }
                  return '';
                })
                .join('');
            } else if (typeof textNode === 'string') {
              text = textNode;
            } else if (typeof textNode === 'object' && textNode !== null) {
              // Handle object with #text property
              if (typeof textNode['#text'] === 'string') {
                text = textNode['#text'];
              } else if (typeof textNode['#text'] === 'object' && textNode['#text'] !== null) {
                // Handle nested structures
                const nestedText = textNode['#text'];
                if (Array.isArray(nestedText)) {
                  text = nestedText
                    .map((nt: any) => (typeof nt === 'string' ? nt : ''))
                    .join('');
                } else if (typeof nestedText === 'string') {
                  text = nestedText;
                }
              }
            }
            
            // Ensure text is a string and trim it
            const trimmedText = typeof text === 'string' ? text.trim() : '';
            if (!trimmedText) return null;
            
            return {
              text: trimmedText,
              properties: run['w:rPr'] ?? {},
            };
          })
          .filter((r): r is { text: string; properties: Record<string, unknown> } => r !== null && r.text.length > 0);

        if (textRuns.length === 0) continue;

        const fullText = textRuns.map((r: any) => r.text).join(' ').trim();
        if (!fullText) continue;

        segments.push({
          index: segmentIndex++,
          runs: textRuns,
          properties: para['w:pPr'] ?? {},
        });
      }
      // Check if this is a table
      else if ('w:tbl' in bodyElement) {
        const table = bodyElement['w:tbl'];
        if (!table) continue;
        
        const rows = table['w:tr'] ?? [];
        const rowArray = Array.isArray(rows) ? rows : rows ? [rows] : [];
        
        for (const row of rowArray) {
          if (!row) continue;
          
          const cells = row['w:tc'] ?? [];
          const cellArray = Array.isArray(cells) ? cells : cells ? [cells] : [];
          
          for (const cell of cellArray) {
            if (!cell) continue;
            
            // Extract paragraphs from cell
            const cellParagraphs = cell['w:p'] ?? [];
            const cellParaArray = Array.isArray(cellParagraphs) ? cellParagraphs : cellParagraphs ? [cellParagraphs] : [];
            
            for (const cellPara of cellParaArray) {
              if (!cellPara) continue;
              
              const cellRuns = cellPara['w:r'] ?? [];
              const cellText = extractTextFromRuns(cellRuns);
              
              if (cellText) {
                // Create runs from extracted text for consistency
                const textRuns = cellText.split(' ').filter(Boolean).map((text) => ({
                  text,
                  properties: {},
                }));
                
                segments.push({
                  index: segmentIndex++,
                  runs: textRuns,
                  properties: {
                    ...cellPara['w:pPr'],
                    isTableCell: true,
                    tableIndex: bodyElements.filter(e => 'w:tbl' in e).indexOf(bodyElement),
                    rowIndex: rowArray.indexOf(row),
                    cellIndex: cellArray.indexOf(cell),
                  },
                });
              }
            }
          }
        }
      }
    }

      const structure: DocxStructure = {
        paragraphs: segments,
      };

      const parsedSegments = segments.map((para) => {
        const isTableCell = para.properties?.isTableCell === true;
        return {
          index: para.index,
          sourceText: para.runs.map((r) => r.text).join(' '),
          type: (isTableCell ? 'table-cell' : 'paragraph') as 'paragraph' | 'table-cell',
          metadata: {
            runs: para.runs,
            paragraphProperties: para.properties,
            ...(isTableCell && {
              tableIndex: para.properties.tableIndex,
              rowIndex: para.properties.rowIndex,
              cellIndex: para.properties.cellIndex,
            }),
          },
        };
      });

      return {
        segments: parsedSegments,
        metadata: {
          type: 'docx',
          paragraphCount: segments.length,
        },
        totalWords: parsedSegments.reduce((acc, seg) => acc + seg.sourceText.split(/\s+/).filter(Boolean).length, 0),
        originalStructure: structure,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse DOCX file: ${errorMessage}`);
    }
  }

  async export(options: ExportOptions): Promise<Buffer> {
    if (!options.originalBuffer) {
      throw new Error('Original DOCX buffer required for export');
    }

    const zip = await JSZip.loadAsync(options.originalBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    if (!documentXml) {
      throw new Error('Invalid DOCX: missing word/document.xml');
    }

    const parsed = this.parser.parse(documentXml);
    const body = parsed['w:document']?.['w:body'] ?? {};
    
    // Get paragraphs and tables from body
    const paragraphs = body['w:p'] ?? [];
    const tables = body['w:tbl'] ?? [];
    const paragraphArray = Array.isArray(paragraphs) ? paragraphs : paragraphs ? [paragraphs] : [];
    const tableArray = Array.isArray(tables) ? tables : tables ? [tables] : [];

    const segmentMap = new Map(options.segments.map((seg) => [seg.index, seg.targetText]));

    let segmentIndex = 0;
    
    // Helper function to update text in runs
    const updateRunsWithText = (runs: any[], translatedText: string) => {
      const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
      const firstRun = runArray.find((run: any) => run['w:t']);
      if (firstRun) {
        const firstRunProps = firstRun['w:rPr'] ?? {};
        return [
          {
            'w:rPr': firstRunProps,
            'w:t': { '@_xml:space': 'preserve', '#text': translatedText },
          },
        ];
      }
      return runArray;
    };
    
    // Update paragraphs
    for (const para of paragraphArray) {
      if (!para) continue;

      const runs = para['w:r'] ?? [];
      const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
      const hasText = runArray.some((run: any) => run['w:t']);

      if (!hasText) continue;

      const translatedText = segmentMap.get(segmentIndex);
      if (translatedText !== undefined) {
        para['w:r'] = updateRunsWithText(runArray, translatedText);
      }
      segmentIndex++;
    }

    // Update tables
    for (const table of tableArray) {
      if (!table) continue;
      
      const rows = table['w:tr'] ?? [];
      const rowArray = Array.isArray(rows) ? rows : rows ? [rows] : [];
      
      for (const row of rowArray) {
        if (!row) continue;
        
        const cells = row['w:tc'] ?? [];
        const cellArray = Array.isArray(cells) ? cells : cells ? [cells] : [];
        
        for (const cell of cellArray) {
          if (!cell) continue;
          
          const cellParagraphs = cell['w:p'] ?? [];
          const cellParaArray = Array.isArray(cellParagraphs) ? cellParagraphs : cellParagraphs ? [cellParagraphs] : [];
          
          for (const cellPara of cellParaArray) {
            if (!cellPara) continue;
            
            const cellRuns = cellPara['w:r'] ?? [];
            const hasText = Array.isArray(cellRuns) 
              ? cellRuns.some((run: any) => run['w:t'])
              : cellRuns && cellRuns['w:t'];
            
            if (!hasText) continue;
            
            const translatedText = segmentMap.get(segmentIndex);
            if (translatedText !== undefined) {
              cellPara['w:r'] = updateRunsWithText(Array.isArray(cellRuns) ? cellRuns : [cellRuns], translatedText);
            }
            segmentIndex++;
          }
        }
      }
    }

    parsed['w:document']['w:body']['w:p'] = paragraphArray;
    parsed['w:document']['w:body']['w:tbl'] = tableArray;
    const updatedXml = this.builder.build(parsed);

    zip.file('word/document.xml', updatedXml);
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }
}
