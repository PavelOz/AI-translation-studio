import JSZip from 'jszip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import mammoth from 'mammoth';
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

  /**
   * Parse DOCX using mammoth.js with custom document transformer to preserve order
   * This processes elements sequentially as they appear in the document
   */
  private async parseWithMammoth(buffer: Buffer): Promise<ParsedFileResult> {
    const segments: Array<{
      index: number;
      sourceText: string;
      type: 'paragraph' | 'table-cell';
      metadata?: Record<string, unknown>;
    }> = [];
    
    let segmentIndex = 0;
    
    // Use mammoth with custom document transformer
    // This processes elements in the order they appear in the document
    const result = await mammoth.convertToHtml(
      { buffer },
      {
        transformDocument: (document: any) => {
          // Process document children in order
          const processChildren = (children: any[]): any[] => {
            return children.map((child: any) => {
              // Process paragraphs
              if (child.type === 'paragraph') {
                const text = this.extractTextFromMammothElement(child);
                if (text && text.trim()) {
                  segments.push({
                    index: segmentIndex++,
                    sourceText: text.trim(),
                    type: 'paragraph',
                    metadata: {},
                  });
                }
              }
              // Process tables
              else if (child.type === 'table') {
                // Process table rows
                if (child.children && Array.isArray(child.children)) {
                  for (const row of child.children) {
                    if (row.type === 'tableRow' && row.children && Array.isArray(row.children)) {
                      // Process table cells
                      for (const cell of row.children) {
                        if (cell.type === 'tableCell' && cell.children && Array.isArray(cell.children)) {
                          // Extract text from cell paragraphs
                          for (const cellChild of cell.children) {
                            if (cellChild.type === 'paragraph') {
                              const cellText = this.extractTextFromMammothElement(cellChild);
                              if (cellText && cellText.trim()) {
                                segments.push({
                                  index: segmentIndex++,
                                  sourceText: cellText.trim(),
                                  type: 'table-cell',
                                  metadata: {
                                    tableIndex: segments.filter(s => s.type === 'table-cell').length,
                                  },
                                });
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
              
              // Recursively process nested children
              if (child.children && Array.isArray(child.children)) {
                return {
                  ...child,
                  children: processChildren(child.children),
                };
              }
              
              return child;
            });
          };
          
          return {
            ...document,
            children: processChildren(document.children || []),
          };
        },
        includeDefaultStyleMap: true,
      }
    );
    
    if (segments.length === 0) {
      throw new Error('No segments extracted from document using mammoth');
    }
    
    console.log(`Mammoth extracted ${segments.length} segments (${segments.filter(s => s.type === 'paragraph').length} paragraphs, ${segments.filter(s => s.type === 'table-cell').length} table cells)`);
    
    const totalWords = segments.reduce((acc, seg) => acc + seg.sourceText.split(/\s+/).filter(Boolean).length, 0);
    
    return {
      segments,
      metadata: {
        type: 'docx',
        paragraphCount: segments.filter(s => s.type === 'paragraph').length,
        tableCellCount: segments.filter(s => s.type === 'table-cell').length,
      },
      totalWords,
    };
  }

  /**
   * Extract text from mammoth document element
   */
  private extractTextFromMammothElement(element: any): string {
    if (!element || !element.children) {
      return '';
    }
    
    return element.children
      .map((child: any) => {
        if (typeof child === 'string') {
          return child;
        }
        if (child && typeof child === 'object') {
          if (child.type === 'text') {
            return child.value || '';
          }
          if (child.type === 'textRun' && child.children) {
            return child.children
              .map((c: any) => (c.type === 'text' ? c.value : ''))
              .join('');
          }
          // Recursively extract from nested children
          if (child.children) {
            return this.extractTextFromMammothElement(child);
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  }

  async parse(buffer: Buffer): Promise<ParsedFileResult> {
    try {
      // Use XML parsing approach with proper order preservation
      // mammoth.js doesn't preserve table order, so we'll use direct XML parsing
      
      const zip = await JSZip.loadAsync(buffer);
      const documentXml = await zip.file('word/document.xml')?.async('string');
      if (!documentXml) {
        throw new Error('Invalid DOCX: missing word/document.xml');
      }

      // First, extract the order of elements from XML directly
      const bodyMatch = documentXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
      if (!bodyMatch) {
        throw new Error('Invalid DOCX: missing w:body element');
      }
      
      const bodyXml = bodyMatch[1];
      
      // Extract elements in order using a more robust approach
      // We need to find ALL elements (both paragraphs and tables) and sort them by position
      const elementOrder: Array<{ type: 'p' | 'tbl'; index: number; xml: string }> = [];
      
      // Function to find matching closing tag for an opening tag
      const findMatchingCloseTag = (xml: string, startIndex: number, tagName: string): number => {
        const openTag = `<${tagName}`;
        const closeTag = `</${tagName}>`;
        let depth = 1;
        let pos = startIndex + openTag.length;
        
        // Find the end of the opening tag
        const tagEnd = xml.indexOf('>', pos);
        if (tagEnd === -1) return -1;
        pos = tagEnd + 1;
        
        while (pos < xml.length && depth > 0) {
          const nextOpen = xml.indexOf(openTag, pos);
          const nextClose = xml.indexOf(closeTag, pos);
          
          if (nextClose === -1) return -1;
          
          if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++;
            pos = nextOpen + openTag.length;
            const tagEnd = xml.indexOf('>', pos);
            if (tagEnd === -1) return -1;
            pos = tagEnd + 1;
          } else {
            depth--;
            if (depth === 0) {
              return nextClose + closeTag.length;
            }
            pos = nextClose + closeTag.length;
          }
        }
        
        return -1;
      };
      
      // Collect ALL element positions first (both paragraphs and tables)
      // This ensures we can sort them together by position
      const allElementPositions: Array<{ type: 'p' | 'tbl'; startIndex: number; endIndex: number }> = [];
      
      // Find all paragraphs - search from start each time to find all occurrences
      let searchPos = 0;
      while (true) {
        const paraStart = bodyXml.indexOf('<w:p', searchPos);
        if (paraStart === -1) break;
        
        const paraEnd = findMatchingCloseTag(bodyXml, paraStart, 'w:p');
        if (paraEnd === -1) {
          searchPos = paraStart + 1;
          continue;
        }
        
        allElementPositions.push({
          type: 'p',
          startIndex: paraStart,
          endIndex: paraEnd,
        });
        
        searchPos = paraEnd;
      }
      
      // Find all tables - search from start each time to find all occurrences
      searchPos = 0;
      while (true) {
        const tblStart = bodyXml.indexOf('<w:tbl', searchPos);
        if (tblStart === -1) break;
        
        const tblEnd = findMatchingCloseTag(bodyXml, tblStart, 'w:tbl');
        if (tblEnd === -1) {
          searchPos = tblStart + 1;
          continue;
        }
        
        allElementPositions.push({
          type: 'tbl',
          startIndex: tblStart,
          endIndex: tblEnd,
        });
        
        searchPos = tblEnd;
      }
      
      // CRITICAL: Sort ALL elements by their start position in XML
      // This preserves the exact order from the original document
      allElementPositions.sort((a, b) => a.startIndex - b.startIndex);
      
      // Debug: log what we found
      console.log(`Found ${allElementPositions.length} elements:`, 
        allElementPositions.map(e => `${e.type}@${e.startIndex}`));
      
      // Now extract XML for each element in the correct order
      for (const elem of allElementPositions) {
        const elemXml = bodyXml.substring(elem.startIndex, elem.endIndex);
        elementOrder.push({
          type: elem.type,
          index: elem.startIndex,
          xml: elemXml,
        });
      }
      
      // Extract text directly from XML fragments in the correct order
      // This avoids parsing issues and preserves the exact order from elementOrder
      const segments: DocxParagraph[] = [];
      let segmentIndex = 0;
      
      // Helper function to extract text from XML using regex (more reliable than parsing)
      const extractTextFromXml = (xml: string): string => {
        // Extract all <w:t> text nodes
        const textMatches = xml.match(/<w:t[^>]*>(.*?)<\/w:t>/gis);
        if (!textMatches) return '';
        
        return textMatches
          .map(match => {
            // Extract content between tags, handling CDATA and entities
            const contentMatch = match.match(/<w:t[^>]*>(.*?)<\/w:t>/i);
            if (!contentMatch) return '';
            let text = contentMatch[1];
            // Decode XML entities
            text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
            return text;
          })
          .filter(Boolean)
          .join(' ')
          .trim();
      };
      
      // Process each element in order, extracting text directly from XML
      for (const element of elementOrder) {
        if (element.type === 'p') {
          // Extract text from paragraph XML
          const text = extractTextFromXml(element.xml);
          if (text) {
            // Create a simple run structure for consistency
            const runs = text.split(/\s+/).filter(Boolean).map((t) => ({
              text: t,
              properties: {},
            }));
            
            segments.push({
              index: segmentIndex++,
              runs,
              properties: {},
            });
          }
        } else if (element.type === 'tbl') {
          // Extract cells from table XML
          // Find all table cells <w:tc>
          const cellRegex = /<w:tc[^>]*>([\s\S]*?)<\/w:tc>/gi;
          let cellMatch;
          while ((cellMatch = cellRegex.exec(element.xml)) !== null) {
            // Extract paragraphs from cell
            const cellParaRegex = /<w:p[^>]*>([\s\S]*?)<\/w:p>/gi;
            let paraMatch;
            while ((paraMatch = cellParaRegex.exec(cellMatch[1])) !== null) {
              const cellText = extractTextFromXml(paraMatch[1]);
              if (cellText) {
                const runs = cellText.split(/\s+/).filter(Boolean).map((t) => ({
                  text: t,
                  properties: {},
                }));
                
                segments.push({
                  index: segmentIndex++,
                  runs,
                  properties: {
                    isTableCell: true,
                    tableIndex: segments.filter(s => s.properties?.isTableCell).length,
                  },
                });
              }
            }
          }
        }
      }
      
      console.log(`Extracted ${segments.length} segments directly from XML (${segments.filter(s => !s.properties?.isTableCell).length} paragraphs, ${segments.filter(s => s.properties?.isTableCell).length} table cells)`);
      
      if (segments.length === 0) {
        throw new Error('Document body is empty or could not be parsed');
      }
      
      // Convert to ParsedFileResult format
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
            }),
          },
        };
      });
      
      const totalWords = parsedSegments.reduce((acc, seg) => acc + seg.sourceText.split(/\s+/).filter(Boolean).length, 0);
      
      return {
        segments: parsedSegments,
        metadata: {
          type: 'docx',
          paragraphCount: parsedSegments.filter(s => s.type === 'paragraph').length,
          tableCellCount: parsedSegments.filter(s => s.type === 'table-cell').length,
        },
        totalWords,
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

    // Extract element order from XML to preserve structure
    const bodyMatch = documentXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
    if (!bodyMatch) {
      throw new Error('Invalid DOCX: missing w:body element');
    }
    
    const bodyXml = bodyMatch[1];
    const elementOrder: Array<{ type: 'p' | 'tbl'; index: number }> = [];
    
    // Find all paragraphs and tables in order
    const paragraphRegex = /<w:p[^>]*>/g;
    let match;
    while ((match = paragraphRegex.exec(bodyXml)) !== null) {
      elementOrder.push({ type: 'p', index: match.index });
    }
    
    const tableRegex = /<w:tbl[^>]*>/g;
    while ((match = tableRegex.exec(bodyXml)) !== null) {
      elementOrder.push({ type: 'tbl', index: match.index });
    }
    
    // Sort by position to get correct order
    elementOrder.sort((a, b) => a.index - b.index);
    
    // Parse the document
    const parsed = this.parser.parse(documentXml);
    const body = parsed['w:document']?.['w:body'] ?? {};
    
    // Get paragraphs and tables from body
    const paragraphs = body['w:p'] ?? [];
    const tables = body['w:tbl'] ?? [];
    const paragraphArray = Array.isArray(paragraphs) ? paragraphs : paragraphs ? [paragraphs] : [];
    const tableArray = Array.isArray(tables) ? tables : tables ? [tables] : [];

    const segmentMap = new Map(options.segments.map((seg) => [seg.index, seg.targetText]));

    let segmentIndex = 0;
    let paragraphIdx = 0;
    let tableIdx = 0;
    
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
    
    // Update elements in the correct order
    for (const element of elementOrder) {
      if (element.type === 'p' && paragraphIdx < paragraphArray.length) {
        const para = paragraphArray[paragraphIdx];
        if (para) {
          const runs = para['w:r'] ?? [];
          const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
          const hasText = runArray.some((run: any) => run['w:t']);

          if (hasText) {
            const translatedText = segmentMap.get(segmentIndex);
            if (translatedText !== undefined) {
              para['w:r'] = updateRunsWithText(runArray, translatedText);
            }
            segmentIndex++;
          }
          paragraphIdx++;
        }
      } else if (element.type === 'tbl' && tableIdx < tableArray.length) {
        const table = tableArray[tableIdx];
        if (table) {
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
          tableIdx++;
        }
      }
    }

    // Rebuild body maintaining order
    parsed['w:document']['w:body']['w:p'] = paragraphArray;
    parsed['w:document']['w:body']['w:tbl'] = tableArray;
    const updatedXml = this.builder.build(parsed);

    zip.file('word/document.xml', updatedXml);
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }
}
