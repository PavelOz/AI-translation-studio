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

  /**
   * Extract text from a paragraph DOM element
   * Collects text from all <w:t> elements within the paragraph
   * HARDENED: Ignores runs that contain only noise tags (proof errors, revision IDs, etc.)
   */
  /**
   * Check if a DOM run element is a noise run (only contains noise tags, no text)
   * This matches the logic of isNoiseRun() for object-based runs
   */
  private isNoiseRunDOM(runElement: Element): boolean {
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    
    // First check if run has any text - if it does, it's not noise
    const textNodes = runElement.getElementsByTagNameNS(namespace, 't');
    for (let i = 0; i < textNodes.length; i++) {
      const textNode = textNodes[i];
      if (textNode.firstChild && textNode.firstChild.nodeType === 3) { // TEXT_NODE
        const text = textNode.firstChild.nodeValue || '';
        if (typeof text === 'string' && text.trim().length > 0) {
          return false; // Has text, not noise
        }
      }
    }
    
    // No text found - check if it only contains noise elements
    // Filter out noise attributes (rsidR, rsidRPr, lang) from children check
    const children = Array.from(runElement.childNodes).filter(child => {
      if (child.nodeType !== 1) return false; // Only element nodes
      const localName = (child as Element).localName || (child as Element).nodeName.split(':').pop();
      return localName !== 'rsidR' && localName !== 'rsidRPr' && localName !== 'lang';
    });
    
    // Check if all children are noise elements
    return children.every(child => {
      const localName = (child as Element).localName || (child as Element).nodeName.split(':').pop();
      return localName === 'proofErr' ||
             localName === 'gramStart' ||
             localName === 'gramEnd' ||
             localName === 'lang' ||
             localName === 'rsid' ||
             (localName === 'rPr' && Array.from((child as Element).childNodes).every(propChild => {
               if (propChild.nodeType !== 1) return true;
               const propLocalName = (propChild as Element).localName || (propChild as Element).nodeName.split(':').pop();
               return propLocalName === 'rsidRPr' || propLocalName === 'rsidR' || propLocalName === 'lang';
             }));
    });
  }

  /**
   * Strict text extraction from a DOM node - ONLY extracts text from <w:t> elements
   * This matches the parser's behavior which only reads <w:t> values
   * 
   * Rules:
   * - IF node is <w:t>: Extract text from text node children
   * - IF node is <w:br/> OR <w:cr/>: Return "" (empty, parser ignores these)
   * - IF node is <w:tab/>: Return "" (empty, parser ignores tabs)
   * - IF node is <w:numPr> (Numbering): Return "" (ignore)
   * - IF node is <w:noBreakHyphen>: Return "" (ignore)
   * - IF node is <w:r> (Run): Recurse into children
   * - ELSE: Return "" (ignore)
   */
  private getTextFromNodeStrict(node: Node): string {
    if (node.nodeType !== 1) { // Not an Element node
      return '';
    }
    
    const element = node as Element;
    const localName = element.localName || element.nodeName.split(':').pop() || '';
    
    // CRITICAL: Only extract text from <w:t> elements
    if (localName === 't') {
      // Extract text from text node children
      const textParts: string[] = [];
      for (let i = 0; i < element.childNodes.length; i++) {
        const child = element.childNodes[i];
        if (child.nodeType === 3) { // TEXT_NODE
          const text = child.nodeValue || '';
          if (text.length > 0) {
            textParts.push(text);
          }
        }
      }
      return textParts.join('');
    }
    
    // Ignore these elements (parser ignores them):
    if (localName === 'br' || localName === 'cr' || localName === 'tab' || 
        localName === 'numPr' || localName === 'noBreakHyphen' || 
        localName === 'softHyphen' || localName === 'lastRenderedPageBreak') {
      return '';
    }
    
    // For <w:r> (Run) or other container elements, recurse into children
    // But only collect text from <w:t> descendants
    const textParts: string[] = [];
    for (let i = 0; i < element.childNodes.length; i++) {
      const child = element.childNodes[i];
      if (child.nodeType === 1) { // ELEMENT_NODE only
        const childText = this.getTextFromNodeStrict(child);
        if (childText.length > 0) {
          textParts.push(childText);
        }
      }
    }
    return textParts.join('');
  }

  /**
   * Extract text from a DOM run element using strict <w:t>-only extraction
   * This matches the parser's behavior which only reads <w:t> values
   * HARDENED: Only extracts text from <w:t> elements, ignoring numbering, tabs, breaks, etc.
   */
  private getRunTextFromDOMRun(runElement: Element): string {
    // Use strict extraction which only looks at <w:t> elements
    return this.getTextFromNodeStrict(runElement);
  }

  /**
   * Extract text from a paragraph DOM element using strict <w:t>-only extraction
   * CRITICAL: This must produce identical results to extractTextFromParagraph() for consistency
   * Uses strict <w:t>-only extraction to match parser behavior (ignores numbering, tabs, breaks, etc.)
   */
  private extractTextFromParagraphDOM(paraElement: Element): string {
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const runs = paraElement.getElementsByTagNameNS(namespace, 'r');
    const textParts: string[] = [];
    
    // CRITICAL: Match the logic of extractTextFromParagraph() exactly
    // Iterate through runs and extract text, filtering noise runs
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      
      // HARDENED: Skip noise runs (contain only proof errors, revision IDs, etc.)
      if (this.isNoiseRunDOM(run)) {
        continue; // Skip this run entirely
      }
      
      // CRITICAL: Use strict <w:t>-only extraction (matches parser behavior)
      // This ignores numbering, tabs, breaks, and other non-text elements
      const extractedText = this.getRunTextFromDOMRun(run);
      
      if (extractedText && extractedText.length > 0) {
        textParts.push(extractedText);
      }
    }
    
    // HARDENED: Join text directly (Word splits text across runs, spaces are in text nodes)
    // This matches extractTextFromParagraph() which uses join('')
    const joinedText = textParts.join('');
    
    // CRITICAL: Normalize text for consistent empty detection (replace non-breaking spaces, trim)
    // This ensures export() skips paragraphs that parse() skips
    const result = this.normalizeTextForComparison(joinedText);
    
    return result;
  }

  /**
   * Extract runs with their formatting from a paragraph DOM element
   * Returns array of { run: Element, textNode: Element | null, text: string, hasFormatting: boolean }
   * HARDENED: Skips noise runs (proof errors, revision IDs, etc.)
   */
  private extractRunsWithFormattingDOM(paraElement: Element): Array<{
    run: Element;
    textNode: Element | null;
    text: string;
    hasFormatting: boolean;
  }> {
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const runs = paraElement.getElementsByTagNameNS(namespace, 'r');
    const result: Array<{
      run: Element;
      textNode: Element | null;
      text: string;
      hasFormatting: boolean;
    }> = [];

    // CRITICAL: Process runs in order to preserve the complete structure
    // This ensures we maintain ALL formatting properties (bold, italic, underline, color, size, font, etc.)
    // HARDENED: Skip noise runs (proof errors, revision IDs, etc.)
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      
      // HARDENED: Check if this run is a noise run (only proof errors, revision IDs, etc.)
      const hasProofErr = run.getElementsByTagNameNS(namespace, 'proofErr').length > 0 ||
                         run.getElementsByTagNameNS(namespace, 'gramStart').length > 0 ||
                         run.getElementsByTagNameNS(namespace, 'gramEnd').length > 0;
      const hasRsid = run.hasAttribute('w:rsid') || 
                     run.hasAttribute('w:rsidR') || 
                     run.hasAttribute('w:rsidRPr') ||
                     run.hasAttribute('w:rsidRDefault');
      const hasLang = run.getElementsByTagNameNS(namespace, 'lang').length > 0;
      const hasFldChar = run.getElementsByTagNameNS(namespace, 'fldChar').length > 0;
      const hasInstrText = run.getElementsByTagNameNS(namespace, 'instrText').length > 0;
      
      const textNodes = run.getElementsByTagNameNS(namespace, 't');
      let hasText = false;
      let text = '';
      let textNode: Element | null = null;
      
      if (textNodes.length > 0) {
        textNode = textNodes[0];
        if (textNode.firstChild && textNode.firstChild.nodeType === 3) { // TEXT_NODE
          text = textNode.firstChild.nodeValue || '';
          hasText = text.trim().length > 0;
        }
      }
      
      // Skip runs that only contain noise elements and have no text
      if (!hasText && (hasProofErr || hasRsid || hasLang || hasFldChar || hasInstrText)) {
        continue; // Skip this noise run
      }
      
      // Check if run has formatting properties (w:rPr)
      // w:rPr can contain: w:b (bold), w:i (italic), w:u (underline), w:color, w:sz (size), w:rFonts, etc.
      const rPr = run.getElementsByTagNameNS(namespace, 'rPr');
      const hasFormatting = rPr.length > 0;
      
      // Include runs that have text or formatting (formatting-only runs are preserved for structure)
      result.push({
        run,
        textNode,
        text: text, // Don't trim - preserve spaces that Word includes in text nodes
        hasFormatting
      });
    }

    return result;
  }

  /**
   * Replace text in a paragraph DOM element
   * 
   * Strategy: Preserves all runs with their formatting (w:rPr) and distributes new text proportionally.
   * This ensures that mixed formatting (bold, italic, etc.) is maintained in the translated text.
   * 
   * Example:
   *   Original: "This is **bold** text" (3 runs: normal, bold, normal)
   *   Translation: "Это **жирный** текст"
   *   Result: Text distributed across 3 runs, preserving bold formatting in the middle run
   */
  private replaceTextInParagraphDOM(paraElement: Element, newText: string): void {
    const runsWithFormatting = this.extractRunsWithFormattingDOM(paraElement);
    
    // #region agent log
    const originalText = runsWithFormatting.map(r => r.text).join('');
    if (originalText.length > 0 && (originalText.includes('PLAN FOR MANAGEMENT') || originalText.includes('500 kV OVERHEAD'))) {
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1920',message:'Export: replaceTextInParagraphDOM - text replacement START',data:{originalText,newText,originalLength:originalText.length,newLength:newText.length,runsCount:runsWithFormatting.length,runsWithText:runsWithFormatting.filter(r=>r.text.length>0).length,runTexts:runsWithFormatting.map((r,i)=>({index:i,text:r.text,length:r.text.length})).slice(0,10)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'W'})}).catch(()=>{});
    }
    // #endregion
    
    if (runsWithFormatting.length === 0) {
      // No runs found - create one
      const runs = paraElement.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'r'
      );
      if (runs.length > 0) {
        const firstRun = runs[0];
        const textElement = paraElement.ownerDocument!.createElementNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          't'
        );
        textElement.appendChild(paraElement.ownerDocument!.createTextNode(newText));
        firstRun.appendChild(textElement);
      } else {
        // No runs at all - create run and text node
        const runElement = paraElement.ownerDocument!.createElementNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'r'
        );
        const textElement = paraElement.ownerDocument!.createElementNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          't'
        );
        textElement.appendChild(paraElement.ownerDocument!.createTextNode(newText));
        runElement.appendChild(textElement);
        paraElement.appendChild(runElement);
      }
      return;
    }

    // Calculate total original text length for proportional distribution
    // Only count runs that actually have text (not just formatting)
    const totalOriginalLength = runsWithFormatting.reduce((sum, run) => sum + run.text.length, 0);
    
    // CRITICAL: If no original text, distribute evenly across all runs
    if (totalOriginalLength === 0) {
      // All runs are empty but have formatting - distribute text across all runs
      // This preserves the formatting structure
      const textPerRun = Math.floor(newText.length / runsWithFormatting.length);
      let remainingText = newText;
      
      for (let i = 0; i < runsWithFormatting.length; i++) {
        const run = runsWithFormatting[i];
        let textForThisRun: string;
        
        if (i === runsWithFormatting.length - 1) {
          // Last run gets all remaining text
          textForThisRun = remainingText;
        } else {
          textForThisRun = remainingText.substring(0, textPerRun);
          remainingText = remainingText.substring(textPerRun);
        }
        
        // Handle text node - create if it doesn't exist
        let textNode = run.textNode;
        if (!textNode) {
          textNode = paraElement.ownerDocument!.createElementNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            't'
          );
          const rPr = run.run.getElementsByTagNameNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'rPr'
          );
          if (rPr.length > 0) {
            if (rPr[0].nextSibling) {
              run.run.insertBefore(textNode, rPr[0].nextSibling);
            } else {
              run.run.appendChild(textNode);
            }
          } else {
            run.run.appendChild(textNode);
          }
        }
        
        // Clear and set text
        while (textNode.firstChild) {
          textNode.removeChild(textNode.firstChild);
        }
        if (textForThisRun.length > 0) {
          textNode.appendChild(paraElement.ownerDocument!.createTextNode(textForThisRun));
        }
      }
      return;
    }

    // Distribute new text proportionally across runs that had text
    // CRITICAL: We preserve ALL runs (including those without text) to maintain formatting structure
    // Only runs that had text originally will get new text distributed to them
    // CRITICAL: Ensure ALL text is distributed - no truncation
    let remainingText = newText;
    
    // Create a map to track text assignment: index in runsWithFormatting -> text to assign
    const textAssignment = new Map<number, string>();
    
    // Get list of runs that had text originally (in order)
    const runsWithText = runsWithFormatting
      .map((run, idx) => ({ run, index: idx, originalLength: run.text.length }))
      .filter(r => r.originalLength > 0);
    
    if (runsWithText.length === 0) {
      // No runs had text - put all text in first run
      if (runsWithFormatting.length > 0) {
        textAssignment.set(0, newText);
      }
    } else {
      // First pass: distribute text proportionally to runs that had text
      // CRITICAL: Last run gets ALL remaining text to prevent truncation
      for (let i = 0; i < runsWithText.length; i++) {
        const runInfo = runsWithText[i];
        const runIndex = runInfo.index;
        let textForThisRun: string;
        
        // Check if this is the last run with text
        if (i === runsWithText.length - 1) {
          // Last run with text gets ALL remaining text to prevent truncation
          textForThisRun = remainingText;
          remainingText = '';
        } else {
          // Calculate proportional length based on original text length
          const proportion = runInfo.originalLength / totalOriginalLength;
          const targetLength = Math.max(1, Math.floor(newText.length * proportion));
          
          // CRITICAL: Ensure we don't take more than what's remaining
          // Also ensure we don't take all remaining text if there are more runs to process
          const maxLength = i === runsWithText.length - 2 
            ? remainingText.length - 1  // Leave at least 1 char for last run
            : remainingText.length;
          const actualLength = Math.min(targetLength, maxLength);
          textForThisRun = remainingText.substring(0, actualLength);
          remainingText = remainingText.substring(actualLength);
        }
        
        // #region agent log
        if (originalText.includes('PLAN FOR MANAGEMENT') && i < 3) {
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2058',message:'Export: replaceTextInParagraphDOM - distributing text to run',data:{runIndex,i,isLast:i===runsWithText.length-1,textForThisRunLength:textForThisRun.length,textForThisRunPreview:textForThisRun.substring(0,30),remainingTextLength:remainingText.length,originalRunLength:runInfo.originalLength,proportion:i===runsWithText.length-1?1:runInfo.originalLength/totalOriginalLength},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'Z'})}).catch(()=>{});
        }
        // #endregion
        
        textAssignment.set(runIndex, textForThisRun);
      }
      
      // CRITICAL: Verify all text was assigned and handle any remaining text
      let totalAssigned = 0;
      for (const assignedText of textAssignment.values()) {
        totalAssigned += assignedText.length;
      }
      
      // If there's any remaining text or mismatch, add it to the last run with text
      // CRITICAL: Only do this ONCE to prevent duplication
      if (remainingText.length > 0 || totalAssigned < newText.length) {
        const missingText = remainingText.length > 0 ? remainingText : newText.substring(totalAssigned);
        if (missingText.length > 0 && runsWithText.length > 0) {
          const lastRunIndex = runsWithText[runsWithText.length - 1].index;
          const existingText = textAssignment.get(lastRunIndex) || '';
          textAssignment.set(lastRunIndex, existingText + missingText);
          remainingText = ''; // CRITICAL: Clear to prevent duplicate processing
        }
      }
    }
    
    // CRITICAL: Final safety check - only if remainingText is still not empty
    // This should rarely trigger if the above logic works correctly
    // But we check remainingText.length explicitly to avoid duplicate additions
    if (remainingText.length > 0) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2080',message:'Export: replaceTextInParagraphDOM - remainingText still not empty after first check',data:{remainingTextLength:remainingText.length,remainingTextPreview:remainingText.substring(0,50),newTextLength:newText.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'X'})}).catch(()=>{});
      // #endregion
      
      // Find the last run with text and add remaining text to it
      let foundLastRun = false;
      for (let i = runsWithFormatting.length - 1; i >= 0; i--) {
        if (runsWithFormatting[i].text.length > 0) {
          const existingText = textAssignment.get(i) || '';
          textAssignment.set(i, existingText + remainingText);
          remainingText = '';
          foundLastRun = true;
          break;
        }
      }
      
      // If no run with text was found (shouldn't happen), put all text in first run
      if (!foundLastRun && runsWithFormatting.length > 0) {
        const existingText = textAssignment.get(0) || '';
        textAssignment.set(0, existingText + remainingText);
        remainingText = '';
      }
    }
    
    // CRITICAL: Final verification - ensure all text was assigned
    // Calculate total assigned text length
    let totalAssignedLength = 0;
    for (const assignedText of textAssignment.values()) {
      totalAssignedLength += assignedText.length;
    }
    
    // If there's still a mismatch after all the above checks, log a warning
    // This should rarely happen if the distribution logic works correctly
    if (totalAssignedLength !== newText.length && newText.length > 0) {
      logger.warn({
        totalAssignedLength,
        newTextLength: newText.length,
        difference: newText.length - totalAssignedLength,
        remainingTextLength: remainingText.length,
      }, 'Export: Text length mismatch detected in replaceTextInParagraphDOM after all fixes');
      
      // CRITICAL: Only fix if there's actually missing text AND remainingText is empty
      // If remainingText is not empty, it means the previous checks didn't work, so don't duplicate
      if (totalAssignedLength < newText.length && remainingText.length === 0) {
        const missingText = newText.substring(totalAssignedLength);
        // Find the last run with text and add missing text to it
        for (let i = runsWithFormatting.length - 1; i >= 0; i--) {
          if (runsWithFormatting[i].text.length > 0) {
            const existingText = textAssignment.get(i) || '';
            textAssignment.set(i, existingText + missingText);
            break;
          }
        }
      }
    }
    
    // Second pass: process ALL runs to update their text nodes
    // This ensures we preserve formatting for ALL runs, even those without text
    for (let i = 0; i < runsWithFormatting.length; i++) {
      const run = runsWithFormatting[i];
      const textForThisRun = textAssignment.get(i) || '';
      
      // Replace text in this run's text node
      // CRITICAL: We only modify the text content, NOT the run structure or w:rPr
      // This ensures ALL formatting properties (bold, italic, underline, color, size, font, etc.) are preserved
      
      // Handle text node - create if it doesn't exist
      let textNode = run.textNode;
      if (!textNode && textForThisRun.length > 0) {
        // Create text node if it doesn't exist and we have text to add
        textNode = paraElement.ownerDocument!.createElementNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          't'
        );
        // Insert text node after rPr if it exists, otherwise append
        const rPr = run.run.getElementsByTagNameNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'rPr'
        );
        if (rPr.length > 0) {
          // Insert after rPr element
          if (rPr[0].nextSibling) {
            run.run.insertBefore(textNode, rPr[0].nextSibling);
          } else {
            run.run.appendChild(textNode);
          }
        } else {
          // No rPr, just append
          run.run.appendChild(textNode);
        }
      }
      
      // Replace text content
      if (textNode) {
        // CRITICAL: Always clear existing text content first to prevent duplication
        // This ensures we replace, not append, even if the method is called multiple times
        while (textNode.firstChild) {
          textNode.removeChild(textNode.firstChild);
        }
        // Add new text (even if empty, to maintain structure)
        if (textForThisRun.length > 0) {
          // CRITICAL: Use textContent assignment instead of appendChild to prevent duplication
          // textContent replaces all content, while appendChild would add to existing content
          textNode.textContent = textForThisRun;
        }
        // CRITICAL: If this run originally had text but doesn't get new text assigned,
        // we need to preserve the textNode structure but the text will be empty
        // This is intentional - the translated text might be shorter and we distribute it proportionally
        // However, we should NOT clear runs that have special content (like numbering)
        // For now, we clear it but this might need refinement for numbering/formatting preservation
      }
      // If run has no text node and no text to add, leave it as is (preserves formatting-only runs)
    }
    
    // #region agent log
    const finalText = Array.from(runsWithFormatting).map((r, i) => {
      const textNode = r.textNode;
      return textNode ? (textNode.textContent || '') : '';
    }).join('');
    if (originalText.length > 0 && (originalText.includes('PLAN FOR MANAGEMENT') || originalText.includes('500 kV OVERHEAD'))) {
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2202',message:'Export: replaceTextInParagraphDOM - text replacement END',data:{originalText,newText,finalText,originalLength:originalText.length,newLength:newText.length,finalLength:finalText.length,textAssignmentEntries:Array.from(textAssignment.entries()).map(([idx,text])=>({index:idx,textLength:text.length,textPreview:text.substring(0,30)})).slice(0,10)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'Y'})}).catch(()=>{});
    }
    // #endregion
  }

  /**
   * Extract text from a table cell DOM element
   */
  private extractTextFromTableCellDOM(cellElement: Element): string {
    const paragraphs = cellElement.getElementsByTagNameNS(
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'p'
    );
    const texts: string[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const paraText = this.extractTextFromParagraphDOM(paragraphs[i]);
      // CRITICAL: extractTextFromParagraphDOM already normalizes (replaces \u00A0 and trims)
      // So we just need to check if the normalized result has content
      if (paraText && paraText.length > 0) {
        texts.push(paraText);
      }
    }
    // CRITICAL: Normalize the final joined text to ensure consistency
    const joinedText = texts.join(' ');
    return this.normalizeTextForComparison(joinedText);
  }

  /**
   * Replace text in a table cell DOM element
   * Replaces text in the first paragraph of the cell
   */
  private replaceTextInTableCellDOM(cellElement: Element, newText: string): void {
    const paragraphs = cellElement.getElementsByTagNameNS(
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'p'
    );
    
    if (paragraphs.length === 0) {
      // No paragraph found - create one
      const paraElement = cellElement.ownerDocument!.createElementNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'p'
      );
      const runElement = cellElement.ownerDocument!.createElementNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'r'
      );
      const textElement = cellElement.ownerDocument!.createElementNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        't'
      );
      textElement.appendChild(cellElement.ownerDocument!.createTextNode(newText));
      runElement.appendChild(textElement);
      paraElement.appendChild(runElement);
      cellElement.appendChild(paraElement);
      return;
    }

    // Replace text in first paragraph
    this.replaceTextInParagraphDOM(paragraphs[0], newText);
    
    // Clear other paragraphs (keep structure but remove text)
    for (let i = 1; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      const textNodes = para.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        't'
      );
      for (let j = 0; j < textNodes.length; j++) {
        const textNode = textNodes[j];
        while (textNode.firstChild) {
          textNode.removeChild(textNode.firstChild);
        }
      }
    }
  }

  /**
   * Recursively process container node (body, table cell, sdtContent) and apply translations
   * CRITICAL: Uses strict recursive traversal matching parse() method - NO getElementsByTagNameNS
   * Iterates childNodes one by one to ensure exact order matching
   */
  private processContainerNodeRecursively(
    containerNode: Element,
    context: {
      segmentIndex: { value: number }; // Mutable ref
      elementIndex: { value: number }; // Mutable ref
      segmentMap: Map<number, string>;
      segmentTypeMap: Map<number, string>;
      paragraphToSegmentsMap: Map<number, number[]>;
      options: ExportOptions;
      likelySentenceSegmented: boolean;
      processedParagraphs: { value: number };
      processedTables: { value: number };
      namespace: string;
    }
  ): void {
    // Iterate childNodes one by one - NO getElementsByTagNameNS
    for (let i = 0; i < containerNode.childNodes.length; i++) {
      const node = containerNode.childNodes[i];
      
      // Only process ELEMENT_NODE types
      if (node.nodeType !== 1) continue; // Skip text nodes, comments, etc.
      
      const element = node as Element;
      const localName = element.localName || element.nodeName.split(':').pop() || '';
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2485',message:'Export Visiting (recursive)',data:{nodeName:element.nodeName,localName,currentSegIndex:context.segmentIndex.value,currentElementIndex:context.elementIndex.value,containerType:containerNode.localName||containerNode.nodeName},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'RECURSIVE'})}).catch(()=>{});
      // #endregion
      
      // CRITICAL: Increment elementIndex for ALL elements (matches parse logic)
      // Parse increments parseElementIndex for every element in bodyChildren, including 'other' elements
      // We must do the same to keep indices aligned
      context.elementIndex.value++;
      
      // Switch statement for different node types
      switch (localName) {
        case 'p': {
          // Handle paragraph
          this.processParagraphElement(element, context);
          break;
        }
        case 'tbl': {
          // Handle table - CRITICAL: recursively process rows and cells
          this.processTableElementRecursively(element, context);
          break;
        }
        case 'sdt': {
          // Handle content control - recurse into w:sdtContent
          // CRITICAL: elementIndex already incremented above, but we don't process sdt itself
          // We only recurse into its content, so elementIndex stays aligned
          const sdtContent = Array.from(element.childNodes).find(
            (n) => n.nodeType === 1 && ((n as Element).localName || (n as Element).nodeName.split(':').pop()) === 'sdtContent'
          ) as Element | undefined;
          if (sdtContent) {
            // Recursively process content inside sdtContent
            // Note: This recursion doesn't increment elementIndex - it processes nested elements
            this.processContainerNodeRecursively(sdtContent, context);
          }
          break;
        }
        case 'sectPr':
        default:
          // Ignore sectPr and other elements (if parse ignores them)
          // CRITICAL: elementIndex already incremented above to match parse behavior
          // #region agent log
          if (localName !== 'sectPr') {
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2505',message:'Export: ignoring node type (recursive)',data:{localName,nodeName:element.nodeName,elementIndex:context.elementIndex.value},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'IGNORE'})}).catch(()=>{});
          }
          // #endregion
          break;
      }
    }
  }

  /**
   * Process a paragraph element - extracts text, applies translation, updates DOM
   * This matches the paragraph processing logic from the original flat loop
   */
  private processParagraphElement(
    paraElement: Element,
    context: {
      segmentIndex: { value: number };
      elementIndex: { value: number };
      segmentMap: Map<number, string>;
      segmentTypeMap: Map<number, string>;
      paragraphToSegmentsMap: Map<number, number[]>;
      options: ExportOptions;
      likelySentenceSegmented: boolean;
      processedParagraphs: { value: number };
      namespace: string;
      consecutiveFailures?: { value: number }; // Track consecutive verification failures
    }
  ): void {
    const elementIndex = context.elementIndex.value;
    let segmentIndex = context.segmentIndex.value;
    
    // Initialize consecutiveFailures counter if not present
    if (!context.consecutiveFailures) {
      context.consecutiveFailures = { value: 0 };
    }
    
    // Skip table of contents paragraphs
    const isTOC = this.isTableOfContentsParagraphDOM(paraElement, elementIndex);
    if (isTOC) {
      // #region agent log
      const paraText = this.extractTextFromParagraphDOM(paraElement);
      // TRAVERSAL TRACE: Log skipped TOC paragraph
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2578',message:'[EXPORT] Skipped para',data:{elementIndex,segmentIndex,type:'paragraph',text:paraText?.substring(0,200)||'',textLength:paraText?.length||0,reason:'table_of_contents',isTOC:true,skipped:true},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'EXPORT_SKIP'})}).catch(()=>{});
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2520',message:'Export: preserving TOC paragraph (recursive)',data:{elementIndex,segmentIndex,reason:'table_of_contents',skipped:true,paraTextPreview:paraText?.substring(0,50)||''},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'TOC'})}).catch(()=>{});
      // #endregion
      return; // Skip TOC - don't increment segmentIndex
    }
    
    const paraText = this.extractTextFromParagraphDOM(paraElement);
    
    // CRITICAL: Only process paragraphs that have text (matches parse logic)
    // extractTextFromParagraphDOM already normalizes (replaces \u00A0 and trims)
    // So we just need to check if the normalized result is empty
    if (!paraText || paraText.length === 0) {
      // #region agent log
      // TRAVERSAL TRACE: Log skipped empty paragraph
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2587',message:'[EXPORT] Skipped para',data:{elementIndex,segmentIndex,type:'paragraph',text:paraText?.substring(0,200)||'',textLength:paraText?.length||0,reason:'empty_paragraph',skipped:true},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'EXPORT_SKIP'})}).catch(()=>{});
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2532',message:'Export: skipping empty paragraph (recursive)',data:{elementIndex,segmentIndex,reason:'empty_paragraph'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'EMPTY'})}).catch(()=>{});
      // #endregion
      return; // Skip empty - don't increment segmentIndex
    }
    
    // Check if we have a segment for this index
    if (segmentIndex >= context.segmentMap.size) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2540',message:'Export: segmentIndex out of bounds (recursive)',data:{elementIndex,segmentIndex,segmentMapSize:context.segmentMap.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'BOUNDS'})}).catch(()=>{});
      // #endregion
      return;
    }
    
    // STRICT CONTENT VERIFICATION: Verify DOM text matches segment text before injecting
    const segment = context.options.segments.find(s => s.index === segmentIndex);
    if (segment) {
      // Get source text from segment - try segment.text first, then fallback to metadata
      let segmentText = '';
      const segmentMetadata = (segment as any).metadata as any;
      
      // Try segment.text directly (if available)
      if ((segment as any).text) {
        segmentText = (segment as any).text;
      } else if (segmentMetadata?.sourceText) {
        // Try sourceText from metadata
        segmentText = segmentMetadata.sourceText;
      } else if (segmentMetadata?.formattedText) {
        // Try formattedText from metadata (stored during parse)
        segmentText = segmentMetadata.formattedText;
      } else if (segmentMetadata?.formattedRuns && Array.isArray(segmentMetadata.formattedRuns)) {
        // Reconstruct from formattedRuns
        segmentText = segmentMetadata.formattedRuns
          .map((run: { text?: string }) => run.text || '')
          .join('');
      } else if (segmentMetadata?.runs && Array.isArray(segmentMetadata.runs)) {
        // Fallback: reconstruct from runs
        segmentText = segmentMetadata.runs
          .map((run: { text?: string }) => run.text || '')
          .join('');
      }
      
      // Only perform verification if we successfully extracted segment text
      if (segmentText && segmentText.length > 0) {
        // Strip formatting tags from segmentText if it contains them (formattedText has tags)
        const plainSegmentText = this.stripFormattingTags(segmentText);
        
        // Compare normalized texts (both should be plain text now)
        const normalizedDomText = this.normalizeText(paraText);
        const normalizedSegmentText = this.normalizeText(plainSegmentText);
        
        if (normalizedDomText !== normalizedSegmentText) {
          // Mismatch detected - try to find matching segment by searching forward
          context.consecutiveFailures!.value++;
          
          // If we have too many consecutive failures, increment segmentIndex to avoid getting stuck
          if (context.consecutiveFailures!.value >= 3) {
            logger.warn({
              message: '[Mismatch] Too many consecutive failures, incrementing segmentIndex to avoid cascade',
              elementIndex,
              segmentIndex,
              consecutiveFailures: context.consecutiveFailures!.value,
            });
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2908',message:'[Mismatch] Cascade prevention - incrementing segmentIndex',data:{elementIndex,segmentIndex,consecutiveFailures:context.consecutiveFailures!.value,domText:paraText.substring(0,100),normalizedDomText:normalizedDomText.substring(0,100)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'MISMATCH_CASCADE'})}).catch(()=>{});
            // #endregion
            context.segmentIndex.value = segmentIndex + 1;
            context.consecutiveFailures!.value = 0; // Reset counter
            return; // Skip this node but with incremented segmentIndex
          }
          
          // Try to find a matching segment within next 5 segments
          let foundMatch = false;
          for (let searchIdx = segmentIndex + 1; searchIdx <= Math.min(segmentIndex + 5, context.segmentMap.size - 1); searchIdx++) {
            const searchSegment = context.options.segments.find(s => s.index === searchIdx);
            if (!searchSegment) continue;
            
            const searchSegmentMetadata = (searchSegment as any).metadata as any;
            const searchSegmentText = searchSegmentMetadata?.sourceText || '';
            if (!searchSegmentText) continue;
            
            const normalizedSearchText = this.normalizeText(this.stripFormattingTags(searchSegmentText));
            if (normalizedDomText === normalizedSearchText) {
              // Found match! Update segmentIndex to the matching segment
              logger.info({
                message: '[Mismatch Recovery] Found matching segment by searching forward',
                elementIndex,
                oldSegmentIndex: segmentIndex,
                newSegmentIndex: searchIdx,
                distance: searchIdx - segmentIndex,
              });
              // #region agent log
              fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2925',message:'[Mismatch Recovery] Found match by forward search',data:{elementIndex,oldSegmentIndex:segmentIndex,newSegmentIndex:searchIdx,distance:searchIdx-segmentIndex},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'MISMATCH_RECOVERY'})}).catch(()=>{});
              // #endregion
              segmentIndex = searchIdx;
              context.segmentIndex.value = searchIdx;
              foundMatch = true;
              context.consecutiveFailures!.value = 0; // Reset counter
              break;
            }
          }
          
          if (!foundMatch) {
            // No exact match found - check if texts are similar enough to proceed
            // Calculate similarity: check if normalized texts start with same prefix (first 100 chars)
            const domPrefix = normalizedDomText.substring(0, 100).trim();
            const segmentPrefix = normalizedSegmentText.substring(0, 100).trim();
            const hasSimilarPrefix = domPrefix.length > 20 && segmentPrefix.length > 20 && 
                                   (domPrefix === segmentPrefix || 
                                    domPrefix.substring(0, Math.min(50, domPrefix.length)) === segmentPrefix.substring(0, Math.min(50, segmentPrefix.length)));
            
            // Also check if one text contains the other (might be partial match)
            // Check if DOM text starts with segment text or vice versa
            const domStartsWithSegment = normalizedDomText.startsWith(normalizedSegmentText.substring(0, Math.min(100, normalizedSegmentText.length)));
            const segmentStartsWithDom = normalizedSegmentText.startsWith(normalizedDomText.substring(0, Math.min(100, normalizedDomText.length)));
            const oneContainsOther = domStartsWithSegment || segmentStartsWithDom ||
                                    normalizedDomText.includes(normalizedSegmentText.substring(0, 100)) || 
                                    normalizedSegmentText.includes(normalizedDomText.substring(0, 100));
            
            if (hasSimilarPrefix || oneContainsOther) {
              // Texts are similar enough - proceed with translation despite mismatch
              logger.info({
                message: '[Mismatch] Texts are similar enough, proceeding with translation',
                elementIndex,
                segmentIndex,
                domPrefix: domPrefix.substring(0, 50),
                segmentPrefix: segmentPrefix.substring(0, 50),
                hasSimilarPrefix,
                oneContainsOther,
              });
              // #region agent log
              fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2978',message:'[Mismatch] Similar texts - proceeding',data:{elementIndex,segmentIndex,domPrefix:domPrefix.substring(0,100),segmentPrefix:segmentPrefix.substring(0,100),hasSimilarPrefix,oneContainsOther,domStartsWithSegment,segmentStartsWithDom,domLength:normalizedDomText.length,segmentLength:normalizedSegmentText.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'MISMATCH_LENIENT'})}).catch(()=>{});
              // #endregion
              // Reset consecutive failures since we're proceeding
              context.consecutiveFailures!.value = 0;
              // Continue with translation application below
            } else {
              // Not similar enough - log warning and skip this node
              logger.warn({
                message: '[Mismatch] DOM text does not match segment text, no forward match found, texts not similar',
                elementIndex,
                segmentIndex,
                consecutiveFailures: context.consecutiveFailures!.value,
                domText: paraText.substring(0, 200),
                segmentText: segmentText.substring(0, 200),
                normalizedDomText: normalizedDomText.substring(0, 200),
                normalizedSegmentText: normalizedSegmentText.substring(0, 200),
              });
              // #region agent log
              fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2973',message:'[Mismatch] DOM: "..." vs Segment: "..." - no forward match, not similar',data:{elementIndex,segmentIndex,consecutiveFailures:context.consecutiveFailures!.value,domText:paraText.substring(0,200),segmentText:segmentText.substring(0,200),normalizedDomText:normalizedDomText.substring(0,200),normalizedSegmentText:normalizedSegmentText.substring(0,200),skipped:true},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'MISMATCH'})}).catch(()=>{});
              // #endregion
              return; // Skip this node - don't increment segmentIndex, continue traversal to find correct match
            }
          }
          // If foundMatch is true, we continue with the updated segmentIndex
        } else {
          // Match found - reset consecutive failures counter
          context.consecutiveFailures!.value = 0;
        }
      } else {
        // Could not extract segment text for verification - skip to maintain alignment
        // Proceeding without verification would break structure alignment
        logger.warn({
          message: '[Verification] Could not extract segment text for verification, skipping injection to maintain alignment',
          elementIndex,
          segmentIndex,
          hasMetadata: !!segmentMetadata,
          hasFormattedRuns: !!(segmentMetadata?.formattedRuns),
          hasRuns: !!(segmentMetadata?.runs),
        });
        return; // Skip this node - don't increment segmentIndex, continue traversal
      }
    }
    // Note: If segment is not found, we proceed anyway since we can't verify a mismatch
    // This handles edge cases where segment metadata might not be available
    
    // Get translation - handle sentence segmentation if needed
    let translatedText = context.segmentMap.get(segmentIndex);
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2931',message:'Export: lookup translation for paragraph',data:{elementIndex,segmentIndex,segmentMapSize:context.segmentMap.size,hasTranslation:translatedText!==undefined,translatedTextPreview:translatedText?.substring(0,50)||'undefined',translatedTextLength:translatedText?.length||0,translatedTextTrimmedLength:translatedText?.trim().length||0,paraTextPreview:paraText.substring(0,50),paraTextLength:paraText.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    let segmentsToSkip = 0;
    
    // Check if sentence segmentation is needed
    const shouldUseHeuristic = context.likelySentenceSegmented || paraText.length > 200;
    
    if (shouldUseHeuristic) {
      // Try to use paragraphToSegmentsMap first
      const segmentIndicesForThisParagraph = context.paragraphToSegmentsMap.get(elementIndex);
      
      if (segmentIndicesForThisParagraph && segmentIndicesForThisParagraph.length > 0) {
        // Collect all sentence segments for this paragraph
        const sentenceSegments: string[] = [];
        for (const segIdx of segmentIndicesForThisParagraph) {
          const segText = context.segmentMap.get(segIdx);
          const segType = context.segmentTypeMap.get(segIdx) || 'paragraph';
          
          // Only collect paragraph segments, skip table cells
          if (segType !== 'table-cell' && segType !== 'cell' && segText && segText.trim()) {
            sentenceSegments.push(segText.trim());
          }
        }
        
        if (sentenceSegments.length > 0) {
          translatedText = sentenceSegments.join(' ');
          // Calculate segmentsToSkip
          let nextSegmentIndex = segmentIndex;
          while (nextSegmentIndex < context.segmentMap.size && segmentIndicesForThisParagraph.includes(nextSegmentIndex)) {
            nextSegmentIndex++;
          }
          segmentsToSkip = nextSegmentIndex - segmentIndex - 1;
        }
      } else {
        // CRITICAL: If no metadata found, use heuristic to collect sentence segments
        // This ensures shifted segments (from sentence segmentation) are not skipped
        const sentenceSegments: string[] = [];
        let nextIndex = segmentIndex;
        const originalParaLength = paraText.length;
        const avgSentenceLength = 80;
        const estimatedSentences = Math.max(1, Math.ceil(originalParaLength / avgSentenceLength));
        const maxSentencesPerParagraph = Math.min(estimatedSentences + 5, 30);
        
        let collectedTextLength = 0;
        const targetLength = originalParaLength;
        const tolerance = 0.5;
        const minTargetLength = targetLength * 0.7;
        const maxTargetLength = targetLength * (1 + tolerance);
        
        while (nextIndex < context.segmentMap.size && sentenceSegments.length < maxSentencesPerParagraph) {
          const nextText = context.segmentMap.get(nextIndex);
          const nextSegmentType = context.segmentTypeMap.get(nextIndex) || 'paragraph';
          const isNextSegmentTableCell = nextSegmentType === 'table-cell' || nextSegmentType === 'cell';
          
          // Stop if we hit a table cell
          if (isNextSegmentTableCell) {
            break;
          }
          
          if (nextText !== undefined && nextText !== null) {
            const textLength = nextText.trim().length;
            const remainingTarget = targetLength - collectedTextLength;
            const wouldExceedMax = collectedTextLength + textLength > maxTargetLength;
            const hasCollectedSubstantialAmount = collectedTextLength >= targetLength * 0.85;
            const isNextSegmentWayTooLong = textLength > remainingTarget * 4;
            
            // Stop if segment is clearly from next paragraph
            if (hasCollectedSubstantialAmount && wouldExceedMax && isNextSegmentWayTooLong) {
              break;
            }
            
            if (textLength > 0) {
              sentenceSegments.push(nextText.trim());
              collectedTextLength += textLength;
            }
            nextIndex++;
            
            // Stop if we've collected enough (close to target) or exceeded max significantly
            if (collectedTextLength >= minTargetLength && (collectedTextLength >= targetLength * 0.98 || collectedTextLength > maxTargetLength * 1.1)) {
              break;
            }
          } else {
            // Missing segment - stop to avoid gaps
            break;
          }
        }
        
        if (sentenceSegments.length > 0) {
          translatedText = sentenceSegments.join(' ');
          segmentsToSkip = nextIndex - segmentIndex - 1;
        }
      }
    }
    
    // Apply translation
    // #region agent log
    const willApplyTranslation = translatedText !== undefined && translatedText !== null && translatedText.trim().length > 0;
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:3018',message:'Export: checking translation application condition',data:{elementIndex,segmentIndex,translatedTextUndefined:translatedText===undefined,translatedTextNull:translatedText===null,translatedTextTrimmedLength:translatedText?.trim().length||0,willApplyTranslation,reason:!willApplyTranslation?(translatedText===undefined?'undefined':translatedText===null?'null':'empty_after_trim'):'will_apply'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    
    // Re-extract segment text for logging and comparison (it's only available in verification block scope)
    let segmentTextForLog = '';
    const segmentForLog = context.options.segments.find(s => s.index === segmentIndex);
    if (segmentForLog) {
      const segmentMetadataForLog = (segmentForLog as any).metadata as any;
      if ((segmentForLog as any).text) {
        segmentTextForLog = (segmentForLog as any).text;
      } else if (segmentMetadataForLog?.sourceText) {
        segmentTextForLog = segmentMetadataForLog.sourceText;
      } else if (segmentMetadataForLog?.formattedText) {
        segmentTextForLog = this.stripFormattingTags(segmentMetadataForLog.formattedText);
      } else if (segmentMetadataForLog?.formattedRuns) {
        segmentTextForLog = segmentMetadataForLog.formattedRuns.map((run: { text?: string }) => run.text || '').join('');
      } else if (segmentMetadataForLog?.runs) {
        segmentTextForLog = segmentMetadataForLog.runs.map((run: { text?: string }) => run.text || '').join('');
      }
    }
    
    // CRITICAL: Check if DOM text is longer than segment/translation (might indicate split caption)
    // This happens when import split "Table 1. List of..." into two segments, but DOM has the full text
    const domTextLonger = paraText.length > (translatedText?.trim().length || 0);
    const domStartsWithSegmentSource = segmentTextForLog && paraText.startsWith(segmentTextForLog.trim());
    const domStartsWithTranslation = translatedText && paraText.startsWith(translatedText.trim());
    
    // Check if DOM text contains the segment source at the start (even if translation doesn't match)
    // This indicates the DOM has more text than the segment captured
    const translationIsPartial = domTextLonger && (domStartsWithSegmentSource || domStartsWithTranslation);
    
    // Check if next segments might contain the remainder (e.g., split table captions)
    let nextSegmentsPreview = '';
    let combinedTranslation = translatedText;
    let segmentsToCombine = 0;
    
    if (translationIsPartial && domStartsWithSegmentSource && segmentIndex + 1 < context.segmentMap.size) {
      // DOM text starts with segment source but is longer - might be split during import
      const normalizedSegmentSource = this.normalizeText(segmentTextForLog);
      let remainderFromDom = paraText.substring(normalizedSegmentSource.length).trim();
      
      // Check up to 2 segments ahead for split captions (handles 2-3 segment splits)
      // This covers cases like "Table 1." + "List of" + "accommodation sites"
      const maxSegmentsToCheck = 2;
      let foundMatch = false;
      let accumulatedTranslation = translatedText ? translatedText.trim() : '';
      let accumulatedRemainder = remainderFromDom;
      
      // Pre-fetch next segments for preview
      const nextSegment1 = context.segmentMap.get(segmentIndex + 1);
      const nextSegment2 = context.segmentMap.get(segmentIndex + 2);
      
      for (let offset = 1; offset <= maxSegmentsToCheck && !foundMatch && segmentIndex + offset < context.segmentMap.size; offset++) {
        const candidateSegmentObj = context.options.segments.find(s => s.index === segmentIndex + offset);
        if (!candidateSegmentObj) continue;
        
        const candidateMetadata = (candidateSegmentObj as any).metadata as any;
        const candidateSource = candidateMetadata?.sourceText || (candidateSegmentObj as any).text || '';
        const normalizedCandidate = this.normalizeText(this.stripFormattingTags(candidateSource));
        const candidateTranslation = context.segmentMap.get(segmentIndex + offset);
        
        if (!normalizedCandidate || !candidateTranslation || !candidateTranslation.trim()) continue;
        
        // Adaptive threshold: use 30 chars or 70% of remainder length (whichever is smaller, min 10)
        // This handles both long and short remainders better
        // Examples: 5 chars -> 5, 20 chars -> 14, 50 chars -> 30
        const thresholdLength = Math.max(10, Math.min(30, Math.floor(accumulatedRemainder.length * 0.7)));
        
        // Check if accumulated remainder matches candidate segment
        const candidatePrefix = normalizedCandidate.substring(0, Math.min(thresholdLength, normalizedCandidate.length));
        const remainderPrefix = accumulatedRemainder.substring(0, Math.min(thresholdLength, accumulatedRemainder.length));
        
        if (candidatePrefix && remainderPrefix &&
            (normalizedCandidate.startsWith(remainderPrefix) ||
             accumulatedRemainder.startsWith(candidatePrefix) ||
             candidatePrefix === remainderPrefix)) {
          // Match found - add to combined translation
          accumulatedTranslation = accumulatedTranslation + ' ' + candidateTranslation.trim();
          segmentsToCombine = offset;
          foundMatch = true;
          
          // Update accumulated remainder by removing the matched portion
          // This allows checking if there's more remainder (for 3+ segment splits)
          if (accumulatedRemainder.length > normalizedCandidate.length) {
            accumulatedRemainder = accumulatedRemainder.substring(normalizedCandidate.length).trim();
            // If there's still remainder, we could continue, but we stop at first match
            // to avoid false positives (rare case of 3+ segment splits)
          } else {
            accumulatedRemainder = ''; // Fully matched
          }
        }
      }
      
      if (foundMatch && accumulatedTranslation) {
        combinedTranslation = accumulatedTranslation;
        nextSegmentsPreview = `[Combined ${segmentsToCombine} segment(s)]`;
      } else {
        // Log preview for debugging when no match found
        nextSegmentsPreview = `[+1:${nextSegment1?.substring(0,50)||'N/A'}|+2:${nextSegment2?.substring(0,50)||'N/A'}]`;
      }
    }
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:3075',message:'Export: translation vs DOM text comparison (table caption check)',data:{elementIndex,segmentIndex,paraTextLength:paraText.length,translatedTextLength:translatedText?.trim().length||0,combinedTranslationLength:combinedTranslation?.trim().length||0,segmentTextLength:segmentTextForLog.length,domTextLonger,domStartsWithSegmentSource,domStartsWithTranslation,translationIsPartial,segmentsToCombine,paraTextPreview:paraText.substring(0,100),translatedTextPreview:translatedText?.substring(0,100)||'N/A',combinedTranslationPreview:combinedTranslation?.substring(0,100)||'N/A',segmentTextPreview:segmentTextForLog.substring(0,100)||'N/A',nextSegmentsPreview},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'TABLE_CAPTION'})}).catch(()=>{});
    // #endregion
    
    // Use combined translation if we found a split caption
    if (segmentsToCombine > 0 && combinedTranslation && translatedText) {
      translatedText = combinedTranslation;
      // Update segmentsToSkip to account for the combined segment
      segmentsToSkip = segmentsToCombine;
    }
    
    if (willApplyTranslation && translatedText !== undefined && translatedText !== null && translatedText.trim().length > 0) {
      // #region agent log
      // TRAVERSAL TRACE: Log every paragraph translation injection
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:3042',message:'[EXPORT] Seg injection',data:{elementIndex,segmentIndex,type:'paragraph',text:paraText.substring(0,200),textLength:paraText.length,translatedText:translatedText.substring(0,200),translatedLength:translatedText.length,skipped:false},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'EXPORT_SEG'})}).catch(()=>{});
      // #endregion
      
      // Segment already retrieved above for verification, reuse it
      const segmentForInjection = context.options.segments.find(s => s.index === segmentIndex);
      const segmentMetadata = (segmentForInjection as any)?.metadata as any;
      const hasLocationMetadata = segmentMetadata?.location || segmentMetadata?.formattedRuns;
      
      if (hasLocationMetadata) {
        this.reconstructParagraph(paraElement, translatedText.trim(), segmentMetadata || {});
      } else {
        this.replaceTextInParagraphDOM(paraElement, translatedText.trim());
      }
      context.processedParagraphs.value++;
    } else {
      // #region agent log
      // TRAVERSAL TRACE: Log when no translation available (but segment exists)
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2995',message:'[EXPORT] Seg no translation',data:{elementIndex,segmentIndex,type:'paragraph',text:paraText.substring(0,200),textLength:paraText.length,reason:translatedText===undefined?'undefined':translatedText===null?'null':'empty_after_trim',skipped:false},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'EXPORT_NO_TRANS'})}).catch(()=>{});
      // #endregion
    }
    
    // Increment segmentIndex
    const oldSegmentIndex = context.segmentIndex.value;
    context.segmentIndex.value = segmentIndex + segmentsToSkip + 1;
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2996',message:'Export: segmentIndex incremented after paragraph',data:{elementIndex,oldSegmentIndex,newSegmentIndex:context.segmentIndex.value,segmentsToSkip,type:'paragraph'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
  }

  /**
   * Process a table element recursively - iterates rows and cells using childNodes
   * CRITICAL: Recursively processes cell content to handle nested tables
   */
  private processTableElementRecursively(
    tableElement: Element,
    context: {
      segmentIndex: { value: number };
      elementIndex: { value: number };
      segmentMap: Map<number, string>;
      segmentTypeMap: Map<number, string>;
      processedTables: { value: number };
      namespace: string;
    }
  ): void {
    const elementIndex = context.elementIndex.value;
    context.processedTables.value++;
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2580',message:'Export: processing table (recursive)',data:{elementIndex,segmentIndex:context.segmentIndex.value,tableIndex:context.processedTables.value},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'TABLE'})}).catch(()=>{});
    // #endregion
    
    // Iterate childNodes to find rows (w:tr) - NO getElementsByTagNameNS
    for (let i = 0; i < tableElement.childNodes.length; i++) {
      const node = tableElement.childNodes[i];
      if (node.nodeType !== 1) continue;
      
      const rowElement = node as Element;
      const rowLocalName = rowElement.localName || rowElement.nodeName.split(':').pop() || '';
      
      if (rowLocalName !== 'tr') continue; // Skip non-row elements
      
      // Iterate row childNodes to find cells (w:tc)
      for (let j = 0; j < rowElement.childNodes.length; j++) {
        const cellNode = rowElement.childNodes[j];
        if (cellNode.nodeType !== 1) continue;
        
        const cellElement = cellNode as Element;
        const cellLocalName = cellElement.localName || cellElement.nodeName.split(':').pop() || '';
        
        if (cellLocalName !== 'tc') continue; // Skip non-cell elements
        
        // Extract cell text
        const cellText = this.extractTextFromTableCellDOM(cellElement);
        
        // CRITICAL: Only process cells that have text (matches parse logic)
        // extractTextFromTableCellDOM already normalizes (replaces \u00A0 and trims)
        if (!cellText || cellText.length === 0) {
          // #region agent log
          // TRAVERSAL TRACE: Log skipped empty table cell
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2605',message:'[EXPORT] Skipped cell',data:{elementIndex,segmentIndex:context.segmentIndex.value,type:'table-cell',text:cellText?.substring(0,200)||'',textLength:cellText?.length||0,reason:'empty_text',skipped:true},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'EXPORT_SKIP'})}).catch(()=>{});
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2605',message:'Export: skipping empty cell (recursive)',data:{elementIndex,segmentIndex:context.segmentIndex.value,cellTextPreview:cellText?.substring(0,30)||''},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'EMPTY_CELL'})}).catch(()=>{});
          // #endregion
          continue; // Skip empty - don't increment segmentIndex
        }
        
        // Check bounds
        if (context.segmentIndex.value >= context.segmentMap.size) {
          return;
        }
        
        // Verify this is a table cell segment
        const cellSegmentType = context.segmentTypeMap.get(context.segmentIndex.value) || 'paragraph';
        const isActuallyTableCell = cellSegmentType === 'table-cell' || cellSegmentType === 'cell';
        
        // CRITICAL: Only process and increment if this is actually a table cell segment
        // If it's not, we're out of sync - skip this cell without incrementing segmentIndex
        // This prevents "ghost increments" when Export processes cells that Parse skipped
        if (!isActuallyTableCell) {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2830',message:'[EXPORT] Skipped cell - not a table cell segment',data:{elementIndex,segmentIndex:context.segmentIndex.value,type:'table-cell',expectedType:cellSegmentType,text:cellText.substring(0,200),textLength:cellText.length,reason:'segment_type_mismatch',skipped:true},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'EXPORT_SKIP'})}).catch(()=>{});
          // #endregion
          // CRITICAL: continue prevents segmentIndex increment - this is intentional
          // We skip this cell because it doesn't match the expected segment type
          continue;
        }
        
        // Get translation
        const translatedText = context.segmentMap.get(context.segmentIndex.value);
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:3074',message:'Export: lookup translation for table cell',data:{elementIndex,segmentIndex:context.segmentIndex.value,segmentMapSize:context.segmentMap.size,hasTranslation:translatedText!==undefined,translatedTextPreview:translatedText?.substring(0,50)||'undefined',translatedTextLength:translatedText?.length||0,cellTextPreview:cellText.substring(0,50),cellTextLength:cellText.length,cellSegmentType},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        // Apply translation
        if (translatedText !== undefined && translatedText !== null && translatedText.trim().length > 0) {
          // #region agent log
          // TRAVERSAL TRACE: Log every table cell translation injection
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2705',message:'[EXPORT] Seg injection',data:{elementIndex,segmentIndex:context.segmentIndex.value,type:'table-cell',text:cellText.substring(0,200),textLength:cellText.length,translatedText:translatedText.substring(0,200),translatedLength:translatedText.length,skipped:false},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'EXPORT_SEG'})}).catch(()=>{});
          // #endregion
          this.replaceTextInTableCellDOM(cellElement, translatedText.trim());
        }
        
        // CRITICAL: Recursively process cell content to handle nested tables/paragraphs
        // This ensures we process any nested structures inside the cell
        // However, we only increment segmentIndex once per cell (cell text is one segment)
        // Nested structures inside cells should have already been included in the cell's text during parse
        
        // CRITICAL: Only increment segmentIndex if we processed a valid table cell segment
        // This matches parse() behavior: parse() only increments segmentIndex when creating a segment
        const oldSegmentIndex = context.segmentIndex.value;
        context.segmentIndex.value++;
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:3095',message:'Export: segmentIndex incremented after table cell',data:{elementIndex,oldSegmentIndex,newSegmentIndex:context.segmentIndex.value,type:'table-cell'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
      }
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
