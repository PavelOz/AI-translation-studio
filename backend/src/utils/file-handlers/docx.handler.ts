import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { FileHandler, ParsedFileResult, ExportOptions } from './types';

/**
 * DOCX Handler - Complete Rewrite
 * 
 * Architecture:
 * - Uses JSZip to read/write DOCX files (ZIP archives)
 * - Uses @xmldom/xmldom for DOM-based XML manipulation
 * - State-less: No internal state, deterministic segment indexing
 * - Structure-preserving: Original XML structure is maintained exactly
 * 
 * Import Strategy:
 * 1. Load word/document.xml from DOCX
 * 2. Parse into DOM
 * 3. Traverse DOM recursively to find all <w:p> (paragraph) elements
 * 4. For each paragraph, extract all text from <w:t> nodes
 * 5. Group text by paragraph to form segments
 * 6. Assign deterministic index based on DOM order
 * 
 * Export Strategy:
 * 1. Load ORIGINAL DOCX file into memory
 * 2. Parse word/document.xml into DOM
 * 3. Traverse DOM in EXACT same order as import
 * 4. Maintain segment counter/index
 * 5. When counter matches a segment ID:
 *    - Replace text in FIRST <w:t> node of that paragraph
 *    - Clear/empty all subsequent <w:t> nodes in same paragraph
 * 6. Serialize modified DOM back to XML
 * 7. Save to ZIP and return buffer
 */
export class DocxHandler implements FileHandler {
  /**
   * Check if this handler supports the given file type
   */
  supports(mimeType: string | undefined, extension: string): boolean {
    return extension === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  /**
   * Parse DOCX file and extract segments
   * 
   * Process:
   * 1. Extract word/document.xml from DOCX ZIP
   * 2. Parse XML into DOM
   * 3. Find <w:body> element
   * 4. Traverse all child elements in order
   * 5. For each <w:p> (paragraph), extract all text from <w:t> nodes
   * 6. Create segments with deterministic indices
   */
  async parse(buffer: Buffer, _options?: unknown): Promise<ParsedFileResult> {
    // Step 1: Load DOCX as ZIP archive
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    
    if (!documentXml) {
      throw new Error('Invalid DOCX: missing word/document.xml');
    }

    // Step 2: Parse XML into DOM
    const parser = new DOMParser();
    const doc = parser.parseFromString(documentXml, 'text/xml');
    
    // Check for parsing errors
    const parseError = doc.getElementsByTagName('parsererror')[0];
    if (parseError) {
      throw new Error(`Failed to parse document.xml: ${parseError.textContent}`);
    }

    // Step 3: Find <w:body> element
    const body = this.findBodyElement(doc);
    if (!body) {
      throw new Error('Invalid DOCX: missing w:body element');
    }

    // Step 4: Traverse DOM and extract segments
    const segments: ParsedFileResult['segments'] = [];
    let segmentIndex = 0;

    // Traverse all direct children of <w:body>
    // These are typically <w:p> (paragraphs) and <w:tbl> (tables)
    // Check if childNodes exists and is not null
    if (!body.childNodes) {
      // If body has no children, return empty segments (valid for empty document)
      return {
        segments: [],
        metadata: {
          type: 'docx',
          totalParagraphs: 0,
          totalTables: 0,
        },
        totalWords: 0,
      };
    }
    
    for (let i = 0; i < body.childNodes.length; i++) {
      const child = body.childNodes[i];
      
      // Skip text nodes, comments, etc. - only process element nodes
      if (child.nodeType !== 1) { // Node.ELEMENT_NODE = 1
        continue;
      }

      const element = child as Element;
      const tagName = element.tagName || element.nodeName;

      // Handle paragraphs
      // Note: tagName should be 'w:p' (qualified name) in xmldom
      if (tagName === 'w:p' || tagName === 'p') {
        const text = this.extractTextFromParagraph(element);
        
        // Only create segment if paragraph has text
        // Empty paragraphs are preserved but not translated
        if (text.trim().length > 0) {
          segments.push({
            index: segmentIndex,
            sourceText: text,
            type: 'paragraph',
            metadata: {
              xmlIndex: i, // Store original position in DOM for reference
            },
          });
          segmentIndex++;
        }
      }
      // Handle tables (optional - can be extended later)
      else if (tagName === 'w:tbl') {
        // For now, we'll extract text from table cells
        // Each cell becomes a segment
        const tableSegments = this.extractTextFromTable(element, segmentIndex);
        segments.push(...tableSegments);
        segmentIndex += tableSegments.length;
      }
    }

    // Calculate total words
    const totalWords = segments ? segments.reduce((sum, seg) => {
      return sum + (seg.sourceText ? seg.sourceText.split(/\s+/).filter(Boolean).length : 0);
    }, 0) : 0;

    return {
      segments,
      metadata: {
        type: 'docx',
        totalParagraphs: segments.filter(s => s.type === 'paragraph').length,
        totalTables: segments.filter(s => s.type === 'table-cell').length,
      },
      totalWords,
    };
  }

  /**
   * Find the <w:body> element in the document
   * 
   * getElementsByTagName may not work with qualified names in xmldom,
   * so we traverse the DOM manually to find the body element.
   */
  private findBodyElement(doc: Document): Element | null {
    // Try getElementsByTagName first (might work in some cases)
    try {
      const bodyElements = doc.getElementsByTagName('w:body');
      if (bodyElements && bodyElements.length > 0) {
        return bodyElements[0] as Element;
      }
    } catch (error) {
      // getElementsByTagName might fail with qualified names, continue to manual search
    }

    // Fallback: traverse document manually
    const traverse = (node: Node): Element | null => {
      if (node.nodeType === 1) { // Node.ELEMENT_NODE
        const elem = node as Element;
        const tagName = elem.tagName || elem.nodeName;
        
        // Check if this is the body element
        if (tagName === 'w:body' || tagName === 'body' || tagName.endsWith(':body')) {
          return elem;
        }
      }

      // Recursively check children
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          const result = traverse(node.childNodes[i]);
          if (result) {
            return result;
          }
        }
      }

      return null;
    };

    // Start traversal from documentElement, or root if documentElement is null
    const rootNode = doc.documentElement || doc;
    if (!rootNode) {
      throw new Error('Invalid DOCX: document has no root element');
    }
    return traverse(rootNode);
  }

  /**
   * Extract all text from a paragraph element
   * 
   * A paragraph can contain multiple <w:r> (runs), each with <w:t> (text) nodes.
   * We need to concatenate all text from all <w:t> nodes in order.
   * 
   * Example structure:
   * <w:p>
   *   <w:r>
   *     <w:t>Hello</w:t>
   *   </w:r>
   *   <w:r>
   *     <w:t> World</w:t>
   *   </w:r>
   * </w:p>
   * 
   * Result: "Hello World"
   */
  private extractTextFromParagraph(paragraphElement: Element): string {
    const textParts: string[] = [];

    // Find all <w:t> nodes within this paragraph (recursively)
    const textNodes = this.findAllTextNodes(paragraphElement);

    // Extract text content from each <w:t> node
    for (const textNode of textNodes) {
      const text = this.getTextNodeContent(textNode);
      if (text !== null) {
        textParts.push(text);
      }
    }

    // Join all text parts
    // Note: We preserve whitespace as-is from the XML
    return textParts.join('');
  }

  /**
   * Find all <w:t> (text) nodes within an element, in DOM order
   * 
   * This recursively traverses the DOM tree to find all text nodes.
   * We maintain DOM order to preserve the original text sequence.
   */
  private findAllTextNodes(element: Element): Element[] {
    const textNodes: Element[] = [];

    // Recursive function to traverse DOM tree
    const traverse = (node: Node) => {
      // Check if this is an element node with tag name 'w:t'
      if (node.nodeType === 1) { // Node.ELEMENT_NODE
        const elem = node as Element;
        // Check for w:t tag (qualified name or local name)
        const tagName = elem.tagName || elem.nodeName;
        if (tagName === 'w:t' || tagName === 't') {
          textNodes.push(elem);
        }
      }

      // Recursively process all child nodes
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          traverse(node.childNodes[i]);
        }
      }
    };

    traverse(element);
    return textNodes;
  }

  /**
   * Extract text content from a <w:t> node
   * 
   * Handles:
   * - Direct text content
   * - Text nodes within the element
   * - xml:space="preserve" attribute (preserves whitespace)
   * 
   * Returns null if node has no text content
   */
  private getTextNodeContent(textElement: Element): string | null {
    // Get all text nodes (direct children that are text nodes)
    let text = '';
    
    if (textElement.childNodes) {
      for (let i = 0; i < textElement.childNodes.length; i++) {
        const child = textElement.childNodes[i];
        if (child.nodeType === 3) { // Node.TEXT_NODE = 3
          text += child.nodeValue || '';
        }
      }
    }

    // Check for xml:space="preserve" attribute
    // If present, we preserve whitespace exactly as-is
    const xmlSpace = textElement.getAttribute('xml:space');
    const preserveSpace = xmlSpace === 'preserve';

    // Trim only if xml:space is not "preserve"
    if (!preserveSpace && text.trim().length === 0) {
      return null;
    }

    return text;
  }

  /**
   * Extract text from table cells
   * 
   * Tables have structure:
   * <w:tbl>
   *   <w:tr> (table row)
   *     <w:tc> (table cell)
   *       <w:p> (paragraphs within cell)
   *         <w:r><w:t>text</w:t></w:r>
   *       </w:p>
   *     </w:tc>
   *   </w:tr>
   * </w:tbl>
   * 
   * We extract text from each cell's paragraphs.
   */
  private extractTextFromTable(tableElement: Element, startIndex: number): ParsedFileResult['segments'] {
    const segments: ParsedFileResult['segments'] = [];
    let currentIndex = startIndex;

    // Find all <w:tr> (table rows)
    const rows = this.getElementsByTagName(tableElement, 'w:tr');

    for (const row of rows) {
      // Find all <w:tc> (table cells) in this row
      const cells = this.getElementsByTagName(row, 'w:tc');

      for (const cell of cells) {
        // Find all <w:p> (paragraphs) in this cell
        const paragraphs = this.getElementsByTagName(cell, 'w:p');

        for (const paragraph of paragraphs) {
          const text = this.extractTextFromParagraph(paragraph);
          
          // Only create segment if cell has text
          if (text.trim().length > 0) {
            segments.push({
              index: currentIndex,
              sourceText: text,
              type: 'table-cell',
              metadata: {
                isTableCell: true,
              },
            });
            currentIndex++;
          }
        }
      }
    }

    return segments;
  }

  /**
   * Helper: Get all elements with a specific tag name (recursive)
   */
  private getElementsByTagName(element: Element, tagName: string): Element[] {
    const results: Element[] = [];

    const traverse = (node: Node) => {
      if (node.nodeType === 1) { // Node.ELEMENT_NODE
        const elem = node as Element;
        const elemTagName = elem.tagName || elem.nodeName;
        // Support both qualified names (w:p) and local names (p)
        if (elemTagName === tagName || elemTagName.endsWith(':' + tagName.split(':').pop())) {
          results.push(elem);
        }
      }

      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          traverse(node.childNodes[i]);
        }
      }
    };

    traverse(element);
    return results;
  }

  /**
   * Export DOCX with translated segments
   * 
   * Process:
   * 1. Load ORIGINAL DOCX file (from options.originalBuffer)
   * 2. Parse word/document.xml into DOM
   * 3. Traverse DOM in EXACT same order as import
   * 4. Maintain segment counter
   * 5. When counter matches a segment ID:
   *    - Find first <w:t> node in that paragraph
   *    - Replace its text with translated text
   *    - Clear all subsequent <w:t> nodes in same paragraph
   * 6. Serialize DOM back to XML
   * 7. Save to ZIP and return buffer
   */
  async export(options: ExportOptions): Promise<Buffer> {
    if (!options.originalBuffer) {
      throw new Error('Original DOCX buffer required for export');
    }

    // Step 1: Load original DOCX as ZIP
    const zip = await JSZip.loadAsync(options.originalBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    
    if (!documentXml) {
      throw new Error('Invalid DOCX: missing word/document.xml');
    }

    // Step 2: Parse XML into DOM
    const parser = new DOMParser();
    const doc = parser.parseFromString(documentXml, 'text/xml');
    
    // Check for parsing errors
    const parseError = doc.getElementsByTagName('parsererror')[0];
    if (parseError) {
      throw new Error(`Failed to parse document.xml: ${parseError.textContent}`);
    }

    // Step 3: Find <w:body> element
    const body = this.findBodyElement(doc);
    if (!body) {
      throw new Error('Invalid DOCX: missing w:body element');
    }

    // Step 4: Create a map of segment index -> translated text
    const translationMap = new Map<number, string>();
    for (const segment of options.segments) {
      translationMap.set(segment.index, segment.targetText);
    }

    // Step 5: Traverse DOM in EXACT same order as import
    let segmentIndex = 0;

    // Traverse all direct children of <w:body>
    if (!body.childNodes) {
      throw new Error('Invalid DOCX: body element has no child nodes');
    }
    
    for (let i = 0; i < body.childNodes.length; i++) {
      const child = body.childNodes[i];
      
      // Skip non-element nodes
      if (child.nodeType !== 1) { // Node.ELEMENT_NODE = 1
        continue;
      }

      const element = child as Element;
      const tagName = element.tagName || element.nodeName;

      // Handle paragraphs
      // Note: tagName should be 'w:p' (qualified name) in xmldom
      if (tagName === 'w:p' || tagName === 'p') {
        // Check if this paragraph has text (same logic as import)
        const originalText = this.extractTextFromParagraph(element);
        
        if (originalText.trim().length > 0) {
          // This paragraph corresponds to a segment
          const translatedText = translationMap.get(segmentIndex);
          
          if (translatedText !== undefined) {
            // Replace text in this paragraph
            this.replaceTextInParagraph(element, translatedText);
          }
          
          segmentIndex++;
        }
      }
      // Handle tables
      else if (tagName === 'w:tbl' || tagName === 'tbl') {
        segmentIndex = this.replaceTextInTable(element, translationMap, segmentIndex);
      }
    }

    // Step 6: Serialize DOM back to XML
    const serializer = new XMLSerializer();
    const updatedDocumentXml = serializer.serializeToString(doc);

    // Step 7: Save to ZIP
    zip.file('word/document.xml', updatedDocumentXml);

    // Step 8: Generate and return buffer
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }

  /**
   * Replace text in a paragraph element
   * 
   * Strategy:
   * 1. Find all <w:t> nodes in the paragraph (in order)
   * 2. Replace text content of FIRST <w:t> node with translated text
   * 3. Clear (empty) all subsequent <w:t> nodes
   * 
   * This handles the case where text is split across multiple runs.
   * Example:
   * Original: <w:r><w:t>Hello</w:t></w:r><w:r><w:t> World</w:t></w:r>
   * After:    <w:r><w:t>Bonjour</w:t></w:r><w:r><w:t></w:t></w:r>
   */
  private replaceTextInParagraph(paragraphElement: Element, translatedText: string): void {
    // Find all <w:t> nodes in this paragraph (in DOM order)
    const textNodes = this.findAllTextNodes(paragraphElement);

    if (textNodes.length === 0) {
      // No text nodes found - this shouldn't happen if we got here
      // But handle gracefully
      return;
    }

    // Escape XML special characters in translated text
    const escapedText = this.escapeXml(translatedText);

    // Replace text in first <w:t> node
    const firstTextNode = textNodes[0];
    this.setTextNodeContent(firstTextNode, escapedText);

    // Clear all subsequent <w:t> nodes (set to empty string)
    for (let i = 1; i < textNodes.length; i++) {
      this.setTextNodeContent(textNodes[i], '');
    }
  }

  /**
   * Set text content of a <w:t> node
   * 
   * This replaces all text node children with the new text.
   * Preserves the <w:t> element structure and attributes.
   */
  private setTextNodeContent(textElement: Element, text: string): void {
    // Remove all existing text node children
    const nodesToRemove: Node[] = [];
    if (textElement.childNodes) {
      for (let i = 0; i < textElement.childNodes.length; i++) {
        const child = textElement.childNodes[i];
        if (child.nodeType === 3) { // Node.TEXT_NODE
          nodesToRemove.push(child);
        }
      }
    }

    // Remove old text nodes
    for (const node of nodesToRemove) {
      textElement.removeChild(node);
    }

    // Add new text node with translated text
    const textNode = textElement.ownerDocument?.createTextNode(text);
    if (textNode) {
      textElement.appendChild(textNode);
    }
  }

  /**
   * Escape XML special characters
   * 
   * Converts: & < > " '
   * To:      &amp; &lt; &gt; &quot; &apos;
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Replace text in table cells
   * 
   * Traverses table structure and replaces text in each cell's paragraphs.
   * Returns the next segment index after processing this table.
   */
  private replaceTextInTable(
    tableElement: Element,
    translationMap: Map<number, string>,
    startIndex: number
  ): number {
    let currentIndex = startIndex;

    // Find all <w:tr> (table rows)
    const rows = this.getElementsByTagName(tableElement, 'w:tr');

    for (const row of rows) {
      // Find all <w:tc> (table cells) in this row
      const cells = this.getElementsByTagName(row, 'w:tc');

      for (const cell of cells) {
        // Find all <w:p> (paragraphs) in this cell
        const paragraphs = this.getElementsByTagName(cell, 'w:p');

        for (const paragraph of paragraphs) {
          const originalText = this.extractTextFromParagraph(paragraph);
          
          // Only process if cell has text (same logic as import)
          if (originalText.trim().length > 0) {
            const translatedText = translationMap.get(currentIndex);
            
            if (translatedText !== undefined) {
              // Replace text in this paragraph
              this.replaceTextInParagraph(paragraph, translatedText);
            }
            
            currentIndex++;
          }
        }
      }
    }

    return currentIndex;
  }
}
