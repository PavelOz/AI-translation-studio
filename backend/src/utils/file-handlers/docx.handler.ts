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
   * Extract all text from a paragraph element with formatting markers
   * 
   * A paragraph can contain multiple <w:r> (runs), each with <w:t> (text) nodes.
   * We track formatting changes between runs and insert markers like {{0}}, {{1}}, etc.
   * 
   * CRITICAL: We track which actual run indices belong to each formatting group,
   * so we can correctly distribute text back to the right runs.
   * 
   * Example structure:
   * <w:p>
   *   <w:r><w:t>Water is </w:t></w:r>
   *   <w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>H2O</w:t></w:r>
   * </w:p>
   * 
   * Result: "{{0}}Water is {{/0}}{{1}}H2O{{/1}}"
   * 
   * This allows us to preserve formatting when translating.
   */
  private extractTextFromParagraph(paragraphElement: Element): string {
    // Find all <w:r> (run) elements in this paragraph
    const runs = this.getElementsByTagName(paragraphElement, 'w:r');
    
    if (runs.length === 0) {
      // No runs found, try old method as fallback
      return this.extractTextFromParagraphLegacy(paragraphElement);
    }

    const textParts: string[] = [];
    let currentFormattingGroupIndex = 0;
    let previousRunProperties: string | null = null;
    let hasTextInCurrentMarker = false;
    let currentRunIndexInParagraph = 0; // Track actual run position in paragraph

    // Process each run in order
    for (let runIdx = 0; runIdx < runs.length; runIdx++) {
      const run = runs[runIdx];
      
      // Find <w:t> nodes within this run
      const textNodes = this.getElementsByTagName(run, 'w:t');
      
      // Check if this run has any content (including spaces)
      // CRITICAL: We must preserve spaces even if they're the only content
      const hasContent = textNodes.length > 0 && textNodes.some(tn => {
        const text = this.getTextNodeContent(tn);
        return text !== null && text.length > 0; // Changed from trim().length > 0 to length > 0
      });

      // Get run properties (formatting) - needed even for space-only runs
      const runProperties = this.getRunProperties(run);
      
      // Check if formatting changed (or if it's the first run with content)
      if (previousRunProperties === null || runProperties !== previousRunProperties) {
        // Close previous marker if exists and had content
        if (previousRunProperties !== null && hasTextInCurrentMarker) {
          textParts.push(`{{/${currentFormattingGroupIndex - 1}}}`);
        }
        // Start new marker (even for space-only runs to preserve formatting context)
        if (hasContent) {
          textParts.push(`{{${currentFormattingGroupIndex}}}`);
          previousRunProperties = runProperties;
          hasTextInCurrentMarker = false;
          currentFormattingGroupIndex++;
        } else {
          // No content, but track position
          currentRunIndexInParagraph++;
          continue;
        }
      }

      // Extract text from all <w:t> nodes in this run
      // CRITICAL: Preserve ALL text including spaces
      // Preserve xml:space="preserve" information for later restoration
      for (const textNode of textNodes) {
        const text = this.getTextNodeContent(textNode);
        if (text !== null && text.length > 0) {
          textParts.push(text);
          hasTextInCurrentMarker = true;
        }
      }

      currentRunIndexInParagraph++;
    }

    // Close the last marker if it had text
    if (previousRunProperties !== null && hasTextInCurrentMarker) {
      textParts.push(`{{/${currentFormattingGroupIndex - 1}}}`);
    }

    return textParts.join('');
  }

  /**
   * Legacy method: Extract text without formatting markers
   * Used as fallback when no runs are found
   */
  private extractTextFromParagraphLegacy(paragraphElement: Element): string {
    const textParts: string[] = [];
    const textNodes = this.findAllTextNodes(paragraphElement);

    for (const textNode of textNodes) {
      const text = this.getTextNodeContent(textNode);
      if (text !== null) {
        textParts.push(text);
      }
    }

    return textParts.join('');
  }

  /**
   * Get run properties as a string for comparison
   * 
   * This serializes the <w:rPr> element to detect formatting changes.
   * Properties include: bold, italic, subscript, superscript, etc.
   */
  private getRunProperties(runElement: Element): string {
    // Find <w:rPr> (run properties) element
    const rPrElements = this.getElementsByTagName(runElement, 'w:rPr');
    
    if (rPrElements.length === 0) {
      return ''; // No properties = default formatting
    }

    // Serialize the properties element to a string for comparison
    // We use a simple approach: get the inner XML structure
    const serializer = new XMLSerializer();
    return serializer.serializeToString(rPrElements[0]);
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

    // CRITICAL FIX: Preserve spaces even if they're the only content
    // In DOCX, spaces are important for word separation and should never be discarded
    // Only return null if the text node is completely empty (not just whitespace)
    if (text.length === 0) {
      return null;
    }

    // Always return the text as-is, preserving all spaces
    // The xml:space="preserve" attribute is handled during export, not import
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
   * Replace text in a paragraph element with formatting preservation
   * 
   * Strategy:
   * 1. Try to parse formatting markers ({{0}}...{{/0}}, {{1}}...{{/1}}, etc.)
   * 2. If markers are valid, distribute text to corresponding runs
   * 3. If markers are missing or broken, fallback to old behavior (wipe and replace)
   * 
   * Example with markers:
   * Input: "{{0}}Water is {{/0}}{{1}}H2O{{/1}}"
   * Result: First run gets "Water is ", second run gets "H2O"
   * 
   * Example without markers (fallback):
   * Input: "Water is H2O"
   * Result: First run gets "Water is H2O", other runs cleared
   */
  private replaceTextInParagraph(paragraphElement: Element, translatedText: string): void {
    // Find all <w:r> (run) elements in this paragraph
    const runs = this.getElementsByTagName(paragraphElement, 'w:r');
    
    if (runs.length === 0) {
      // No runs found, use legacy method
      this.replaceTextInParagraphLegacy(paragraphElement, translatedText);
      return;
    }

    // Try to parse formatting markers
    const parsedSegments = this.parseFormattingMarkers(translatedText);
    
    if (parsedSegments && parsedSegments.length > 0) {
      // Markers found - distribute text to runs
      this.distributeTextToRuns(runs, parsedSegments);
    } else {
      // No valid markers - fallback to old behavior
      this.replaceTextInParagraphLegacy(paragraphElement, translatedText);
    }
  }

  /**
   * Parse formatting markers from translated text
   * 
   * Returns array of { runIndex: number, text: string } or null if parsing fails
   * 
   * Example: "{{0}}Hello{{/0}}{{1}}World{{/1}}" -> [{runIndex: 0, text: "Hello"}, {runIndex: 1, text: "World"}]
   */
  private parseFormattingMarkers(text: string): Array<{ runIndex: number; text: string }> | null {
    // Pattern to match: {{n}}...{{/n}}
    const markerPattern = /\{\{(\d+)\}\}(.*?)\{\{\/\1\}\}/g;
    const segments: Array<{ runIndex: number; text: string }> = [];
    let lastIndex = 0;
    let match;

    // Find all marker pairs
    while ((match = markerPattern.exec(text)) !== null) {
      const runIndex = parseInt(match[1], 10);
      const segmentText = match[2];
      
      // Check for text before this marker (shouldn't happen in valid format)
      if (match.index > lastIndex) {
        const beforeText = text.substring(lastIndex, match.index);
        if (beforeText.trim().length > 0) {
          // Invalid format - text outside markers
          return null;
        }
      }
      
      segments.push({ runIndex, text: segmentText });
      lastIndex = markerPattern.lastIndex;
    }

    // Check if there's text after the last marker
    if (lastIndex < text.length) {
      const afterText = text.substring(lastIndex);
      if (afterText.trim().length > 0) {
        // Invalid format - text after markers
        return null;
      }
    }

    // Validate that run indices are sequential starting from 0
    if (segments.length === 0) {
      return null; // No markers found
    }

    for (let i = 0; i < segments.length; i++) {
      if (segments[i].runIndex !== i) {
        // Run indices are not sequential - invalid format
        return null;
      }
    }

    return segments;
  }

  /**
   * Distribute parsed text segments to corresponding runs
   * 
   * CRITICAL: Segments are indexed by formatting group ({{0}}, {{1}}, etc.),
   * but we need to map them to the actual runs that had text in the original.
   * 
   * Strategy:
   * 1. Identify which runs have text and their formatting groups
   * 2. Map formatting groups to the runs that belong to them
   * 3. Distribute segment text to all runs in that formatting group
   * 
   * Example: If {{0}} contains "Worker Accommodation Management Plan: "
   * and runs 0, 1, 2 all have bold formatting, we put the text in run 0
   * and clear runs 1 and 2 (since they were merged during extraction).
   */
  private distributeTextToRuns(
    runs: Element[],
    segments: Array<{ runIndex: number; text: string }>
  ): void {
    // Step 1: Identify runs with text and their formatting groups
    const runsWithText: Array<{ runIndex: number; formattingGroup: number; textNodes: Element[] }> = [];
    let currentFormattingGroup = 0;
    let previousRunProperties: string | null = null;

    for (let runIdx = 0; runIdx < runs.length; runIdx++) {
      const run = runs[runIdx];
      const textNodes = this.getElementsByTagName(run, 'w:t');
      
      // Check if this run has text
      const hasText = textNodes.length > 0 && textNodes.some(tn => {
        const text = this.getTextNodeContent(tn);
        return text !== null && text.trim().length > 0;
      });

      if (!hasText) {
        continue; // Skip runs without text
      }

      // Get run properties to determine formatting group
      const runProperties = this.getRunProperties(run);
      
      // Check if formatting changed
      if (previousRunProperties === null || runProperties !== previousRunProperties) {
        currentFormattingGroup++;
        previousRunProperties = runProperties;
      }

      runsWithText.push({
        runIndex: runIdx,
        formattingGroup: currentFormattingGroup - 1, // Adjust to 0-based
        textNodes,
      });
    }

    // Step 2: Map formatting groups to runs
    const formattingGroupToRuns = new Map<number, Array<{ runIndex: number; textNodes: Element[] }>>();
    for (const runInfo of runsWithText) {
      if (!formattingGroupToRuns.has(runInfo.formattingGroup)) {
        formattingGroupToRuns.set(runInfo.formattingGroup, []);
      }
      formattingGroupToRuns.get(runInfo.formattingGroup)!.push({
        runIndex: runInfo.runIndex,
        textNodes: runInfo.textNodes,
      });
    }

    // Step 3: Distribute segment text to runs
    for (const segment of segments) {
      const formattingGroup = segment.runIndex;
      const runsInGroup = formattingGroupToRuns.get(formattingGroup);

      if (!runsInGroup || runsInGroup.length === 0) {
        continue; // No runs for this formatting group
      }

      // Escape XML special characters
      const escapedText = this.escapeXml(segment.text);

      // Put all text in the first run of the group, clear others
      // This matches the extraction behavior where we concatenate text from all runs in a group
      const firstRun = runsInGroup[0];
      if (firstRun.textNodes.length > 0) {
        const firstTextNode = firstRun.textNodes[0];
        
        // Check if any run in this group had xml:space="preserve"
        // If so, preserve it on the first text node to maintain spacing
        let needsPreserveSpace = false;
        for (const runInfo of runsInGroup) {
          for (const textNode of runInfo.textNodes) {
            const xmlSpace = textNode.getAttribute('xml:space');
            if (xmlSpace === 'preserve') {
              needsPreserveSpace = true;
              break;
            }
          }
          if (needsPreserveSpace) break;
        }
        
        // Set xml:space="preserve" if needed
        if (needsPreserveSpace) {
          firstTextNode.setAttribute('xml:space', 'preserve');
        }
        
        this.setTextNodeContent(firstTextNode, escapedText);
        
        // Clear subsequent text nodes in first run
        for (let j = 1; j < firstRun.textNodes.length; j++) {
          this.setTextNodeContent(firstRun.textNodes[j], '');
        }
      }

      // Clear all other runs in this formatting group
      for (let i = 1; i < runsInGroup.length; i++) {
        const runInfo = runsInGroup[i];
        for (const textNode of runInfo.textNodes) {
          this.setTextNodeContent(textNode, '');
        }
      }
    }

    // Step 4: Clear any runs that don't have corresponding segments
    const usedRunIndices = new Set<number>();
    for (const segment of segments) {
      const runsInGroup = formattingGroupToRuns.get(segment.runIndex);
      if (runsInGroup) {
        for (const runInfo of runsInGroup) {
          usedRunIndices.add(runInfo.runIndex);
        }
      }
    }

    // Clear unused runs
    for (let runIdx = 0; runIdx < runs.length; runIdx++) {
      if (!usedRunIndices.has(runIdx)) {
        const textNodes = this.getElementsByTagName(runs[runIdx], 'w:t');
        for (const textNode of textNodes) {
          this.setTextNodeContent(textNode, '');
        }
      }
    }
  }

  /**
   * Legacy method: Replace text without formatting preservation
   * Used as fallback when markers are missing or invalid
   */
  private replaceTextInParagraphLegacy(paragraphElement: Element, translatedText: string): void {
    const textNodes = this.findAllTextNodes(paragraphElement);

    if (textNodes.length === 0) {
      return;
    }

    const escapedText = this.escapeXml(translatedText);
    this.setTextNodeContent(textNodes[0], escapedText);

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
