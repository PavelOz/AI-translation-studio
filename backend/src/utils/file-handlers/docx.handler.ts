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
  private isExporting = false; // Flag to disable logging during export
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
        // CRITICAL: Check if this paragraph is inside a textbox - if so, skip it
        // Textbox paragraphs are extracted separately when processing the parent paragraph
        let isInsideTextbox = false;
        let currentNode: Node | null = element.parentNode;
        while (currentNode) {
          if (currentNode.nodeType === 1) {
            const elem = currentNode as Element;
            const nodeTagName = elem.tagName || elem.nodeName;
            // Check if we're inside w:txbxContent (textbox content)
            if (nodeTagName === 'w:txbxContent' || nodeTagName === 'txbxContent') {
              isInsideTextbox = true;
              break;
            }
          }
          currentNode = currentNode.parentNode;
        }
        
        if (isInsideTextbox) {
          continue; // Skip paragraphs inside textbox - they're extracted separately
        }
        
        const { paragraphText, shapeText, textboxParagraphs } = this.extractTextFromParagraph(element);
        
        // Create segment for paragraph text (if not empty)
        if (paragraphText.trim().length > 0) {
          segments.push({
            index: segmentIndex,
            sourceText: paragraphText,
            type: 'paragraph',
            metadata: {
              xmlIndex: i, // Store original position in DOM for reference
            },
          });
          segmentIndex++;
        }
        
        // Create separate segment for each textbox paragraph (like regular paragraphs)
        if (textboxParagraphs && textboxParagraphs.length > 0) {
          for (let paraIdx = 0; paraIdx < textboxParagraphs.length; paraIdx++) {
            const paraText = textboxParagraphs[paraIdx];
            // Create segment for each paragraph, even if empty (to preserve structure)
            segments.push({
              index: segmentIndex,
              sourceText: paraText,
              type: 'paragraph',
              metadata: {
                xmlIndex: i, // Store original position in DOM for reference
                isTextbox: true, // Mark as textbox segment
                textboxParaIdx: paraIdx, // Store paragraph index within textbox
              },
            });
            segmentIndex++;
          }
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
  private extractTextFromParagraph(paragraphElement: Element): { paragraphText: string; shapeText: string; textboxParagraphs: string[] } {
    // Check if this paragraph contains drawing/shape elements
    const drawings = this.getElementsByTagName(paragraphElement, 'w:drawing');
    let shapeText = '';
    const textboxParagraphs: string[] = [];
    
    if (drawings.length > 0) {
      // Extract text from shapes/drawings
      // CRITICAL: Process textbox only once to avoid duplication
      // Multiple drawings may reference the same textbox, so we track processed textboxes
      const processedTextboxes = new Set<Element>();
      for (const drawing of drawings) {
        // DrawingML textbox: <wps:txbx> with <w:txbxContent> containing <w:p> paragraphs
        // This must be checked FIRST because textbox contains paragraphs that need special handling
        const wpsTextboxes = this.getElementsByTagName(drawing, 'wps:txbx');
        if (wpsTextboxes.length > 0) {
          for (const wpsTextbox of wpsTextboxes) {
            // Skip if this textbox was already processed
            if (processedTextboxes.has(wpsTextbox)) {
              continue;
            }
            processedTextboxes.add(wpsTextbox);
            const txbxContent = this.getElementsByTagName(wpsTextbox, 'w:txbxContent');
            for (const content of txbxContent) {
              // Extract text from all paragraphs in textbox
              const paragraphs = this.getElementsByTagName(content, 'w:p');
              for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
                const para = paragraphs[paraIdx];
                // Use extractTextFromParagraphWithFormatting to preserve line breaks and list items
                // but skip shape processing to avoid recursion
                const paraText = this.extractTextFromParagraphWithFormatting(para);
                // Store each paragraph separately for individual segment creation
                textboxParagraphs.push(paraText);
                // Also keep shapeText for backward compatibility (legacy single-segment approach)
                if (paraIdx > 0 && shapeText.length > 0) {
                  shapeText += '\n';
                }
                shapeText += paraText;
              }
              }
          }
          continue; // Skip other types if DrawingML textbox found
        }
        
        // DrawingML text: <a:t> elements (simple text, not in textbox)
        const drawingTextNodes = this.getElementsByTagName(drawing, 'a:t');
        for (const textNode of drawingTextNodes) {
          const text = this.getTextNodeContent(textNode);
          if (text !== null && text.length > 0) {
            shapeText += text;
          }
        }
        
        // VML text: <v:textbox> with <w:t> inside
        const textboxes = this.getElementsByTagName(drawing, 'v:textbox');
        for (const textbox of textboxes) {
          const vmlTextNodes = this.findAllTextNodes(textbox);
          for (const textNode of vmlTextNodes) {
            const text = this.getTextNodeContent(textNode);
            if (text !== null && text.length > 0) {
              shapeText += text;
            }
          }
        }
      }
      
      }
    
    // Find all <w:r> (run) elements in this paragraph
    const runs = this.getElementsByTagName(paragraphElement, 'w:r');
    
    if (runs.length === 0) {
      // No runs found, but might have shape text
      // Try old method as fallback for paragraph text
      const paragraphText = this.extractTextFromParagraphLegacy(paragraphElement);
      return { paragraphText, shapeText, textboxParagraphs };
    }

    // Check if this paragraph is part of a list (has <w:numPr> in paragraph properties)
    const pPrElements = this.getElementsByTagName(paragraphElement, 'w:pPr');
    let isListItem = false;
    let listLevel = 0;
    if (pPrElements.length > 0) {
      const pPr = pPrElements[0];
      const numPrElements = this.getElementsByTagName(pPr, 'w:numPr');
      if (numPrElements.length > 0) {
        isListItem = true;
        // Try to get list level (ilvl)
        const ilvlElements = this.getElementsByTagName(numPrElements[0], 'w:ilvl');
        if (ilvlElements.length > 0) {
          const ilvlAttr = ilvlElements[0].getAttribute('w:val') || ilvlElements[0].getAttribute('val');
          if (ilvlAttr) {
            listLevel = parseInt(ilvlAttr, 10) || 0;
          }
        }
        }
    }

    const textParts: string[] = [];
    
    // Don't add bullet point prefix for list items - Word will add it automatically on export
    // We'll strip any existing bullets from the text instead
    
    let currentFormattingGroupIndex = 0;
    let previousRunProperties: string | null = null;
    let hasTextInCurrentMarker = false;
    let currentRunIndexInParagraph = 0; // Track actual run position in paragraph

    // Process each run in order
    for (let runIdx = 0; runIdx < runs.length; runIdx++) {
      const run = runs[runIdx];
      
      // CRITICAL: Skip runs that contain drawings - text from drawings is extracted separately
      // This prevents double extraction of textbox content
      const runDrawings = this.getElementsByTagName(run, 'w:drawing');
      if (runDrawings.length > 0) {
        // This run contains a drawing - skip it, text will be extracted from shapeText
        continue;
      }
      
      // Find <w:t> nodes within this run
      // CRITICAL: getElementsByTagName is recursive, but we've excluded textbox from it
      // So text inside textbox should not be found
      const textNodes = this.getElementsByTagName(run, 'w:t');
      
      // Check for line breaks (<w:br/>) in this run
      const hasLineBreak = Array.from(run.childNodes || []).some(child => {
        if (child.nodeType === 1) {
          const element = child as Element;
          const tagName = element.tagName || '';
          return tagName === 'w:br' || tagName.toLowerCase() === 'br';
        }
        return false;
      });
      
      // Check if this run has any content (including spaces or line breaks)
      // CRITICAL: We must preserve spaces even if they're the only content
      // Also preserve line breaks even if there's no text
      const hasContent = hasLineBreak || (textNodes.length > 0 && textNodes.some(tn => {
        const text = this.getTextNodeContent(tn);
        return text !== null && text.length > 0; // Changed from trim().length > 0 to length > 0
      }));

      // Get run properties (formatting) - needed even for space-only runs
      const runProperties = this.getRunProperties(run);
      
      // Check if formatting changed (or if it's the first run with content)
      if (previousRunProperties === null || runProperties !== previousRunProperties) {
        // Close previous marker if exists and had content
        if (previousRunProperties !== null && hasTextInCurrentMarker) {
          const closingIndex = currentFormattingGroupIndex - 1;
          // Guard against negative index (should not happen, but prevents {{/-1}} artifacts)
          if (closingIndex >= 0) {
            textParts.push(`{{/${closingIndex}}}`);
          }
        }
        // Start new marker (even for space-only runs to preserve formatting context)
        if (hasContent) {
          textParts.push(`{{${currentFormattingGroupIndex}}}`);
          previousRunProperties = runProperties;
          hasTextInCurrentMarker = false;
          currentFormattingGroupIndex++;
        } else {
          // No content, but track position
          // CRITICAL FIX: Update previousRunProperties even when skipping, so next run with same formatting is recognized
          previousRunProperties = runProperties;
          currentRunIndexInParagraph++;
          continue;
        }
      }

      // Process all children of the run in order to preserve line breaks and text
      // This ensures <w:br/> elements are converted to newlines in the correct position
      const childNodes = Array.from(run.childNodes || []);
      let foundTextInRun = false;
      
      for (let i = 0; i < childNodes.length; i++) {
        const child = childNodes[i];
        if (child.nodeType === 1) { // Element node
          const element = child as Element;
          const tagName = element.tagName || '';
          
          // Check for line break element
          if (tagName === 'w:br' || tagName.toLowerCase() === 'br') {
            textParts.push('\n');
            hasTextInCurrentMarker = true;
            foundTextInRun = true;
          }
          // Check for text node (<w:t>)
          else if (tagName === 'w:t' || tagName.toLowerCase() === 't') {
            const text = this.getTextNodeContent(element);
            if (text !== null && text.length > 0) {
              textParts.push(text);
              hasTextInCurrentMarker = true;
              foundTextInRun = true;
            }
          }
        }
      }

      currentRunIndexInParagraph++;
    }

    // Close the last marker if it had text
    if (previousRunProperties !== null && hasTextInCurrentMarker) {
      const closingIndex = currentFormattingGroupIndex - 1;
      // Guard against negative index (should not happen, but prevents {{/-1}} artifacts)
      if (closingIndex >= 0) {
        textParts.push(`{{/${closingIndex}}}`);
      }
    }

    let result = textParts.join('');
    
    // For list items, strip any leading bullet characters (•, -, *, etc.) from the text
    // Word will automatically add the bullet on export based on w:numPr property
    // This prevents "• Overview" from appearing when the bullet is already in the text
    if (isListItem && result.trim().length > 0) {
      // Remove leading bullet characters and whitespace
      // Match: bullet char (•, -, *, etc.) followed by optional whitespace at the start
      result = result.replace(/^[\s\u2022\u2023\u25E6\u2043\u2219\-\*]\s*/, '');
    }
    
    // Don't append shape text to paragraph text - return them separately
    // This allows creating separate segments for textbox content
    // Return paragraph text and shape text separately
    return { paragraphText: result, shapeText, textboxParagraphs };
  }

  /**
   * Extract text from paragraph for export (lightweight, no logging)
   * 
   * This is a simplified version used during export to avoid performance issues
   * from extensive logging. It extracts text without formatting markers.
   */
  private extractTextFromParagraphForExport(paragraphElement: Element): string {
    const textNodes = this.findAllTextNodes(paragraphElement);
    const textParts: string[] = [];

    for (const textNode of textNodes) {
      const text = this.getTextNodeContent(textNode);
      if (text !== null) {
        textParts.push(text);
      }
    }

    return textParts.join('');
  }

  /**
   * Extract text from paragraph with formatting (line breaks, list items) but without shape processing
   * This is used for textbox paragraphs to avoid recursion while preserving formatting
   */
  private extractTextFromParagraphWithFormatting(paragraphElement: Element): string {
    // Check if this paragraph is part of a list (has <w:numPr> in paragraph properties)
    const pPrElements = this.getElementsByTagName(paragraphElement, 'w:pPr');
    let isListItem = false;
    let listLevel = 0;
    if (pPrElements.length > 0) {
      const pPr = pPrElements[0];
      const numPrElements = this.getElementsByTagName(pPr, 'w:numPr');
      if (numPrElements.length > 0) {
        isListItem = true;
        // Try to get list level (ilvl)
        const ilvlElements = this.getElementsByTagName(numPrElements[0], 'w:ilvl');
        if (ilvlElements.length > 0) {
          const ilvlAttr = ilvlElements[0].getAttribute('w:val') || ilvlElements[0].getAttribute('val');
          if (ilvlAttr) {
            listLevel = parseInt(ilvlAttr, 10) || 0;
          }
        }
      }
    }
    const textParts: string[] = [];
    
    // Get all runs in the paragraph
    const runs = this.getElementsByTagName(paragraphElement, 'w:r');
    
    // Process each run in order to extract text first
    for (let runIdx = 0; runIdx < runs.length; runIdx++) {
      const run = runs[runIdx];
      
      // Process all children of the run in order to preserve line breaks and text
      const childNodes = Array.from(run.childNodes || []);
      
      for (const childNode of childNodes) {
        if (childNode.nodeType === 1) {
          // Element node
          const element = childNode as Element;
          const tagName = element.tagName || element.nodeName;
          
          // Check for line break
          if (tagName === 'w:br' || tagName.toLowerCase() === 'br') {
            textParts.push('\n');
          }
          // Check for text node
          else if (tagName === 'w:t' || tagName === 't') {
            const text = this.getTextNodeContent(element);
            if (text !== null) {
              textParts.push(text);
            }
          }
        }
      }
    }

    let result = textParts.join('');
    
    // For list items, strip any leading bullet characters (•, -, *, etc.) from the text
    // Word will automatically add the bullet on export based on w:numPr property
    // This prevents "• Overview" from appearing when the bullet is already in the text
    if (isListItem && result.trim().length > 0) {
      // Remove leading bullet characters and whitespace
      // Match: bullet char (•, -, *, etc.) followed by optional whitespace at the start
      result = result.replace(/^[\s\u2022\u2023\u25E6\u2043\u2219\-\*]\s*/, '');
    }

    return result;
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

    // CRITICAL FIX: We need to normalize run properties by removing spacing
    // Spacing (w:spacing) is a layout property, not a formatting property
    // Different spacing values should not create different formatting groups
    // This ensures that runs with the same visual formatting (bold, italic, etc.)
    // but different spacing are grouped together
    const rPr = rPrElements[0].cloneNode(true) as Element;
    
    // Remove all w:spacing elements from the cloned properties
    const spacingElements = this.getElementsByTagName(rPr, 'w:spacing');
    for (const spacingEl of spacingElements) {
      if (spacingEl.parentNode) {
        spacingEl.parentNode.removeChild(spacingEl);
      }
    }

    // Serialize the normalized properties element to a string for comparison
    const serializer = new XMLSerializer();
    return serializer.serializeToString(rPr);
  }

  /**
   * Find all <w:t> (text) nodes within an element, in DOM order
   * 
   * This recursively traverses the DOM tree to find all text nodes.
   * We maintain DOM order to preserve the original text sequence.
   * 
   * CRITICAL: Exclude textbox content to avoid double extraction
   * Textbox text is extracted separately via extractTextFromParagraph
   */
  private findAllTextNodes(element: Element): Element[] {
    const textNodes: Element[] = [];

    // Recursive function to traverse DOM tree
    const traverse = (node: Node) => {
      // Check if this is an element node
      if (node.nodeType === 1) { // Node.ELEMENT_NODE
        const elem = node as Element;
        const tagName = elem.tagName || elem.nodeName;
        
        // CRITICAL: Skip textbox content - it's extracted separately
        // Stop recursion when we hit w:txbxContent (DrawingML textbox) or v:textbox (VML textbox)
        if (tagName === 'w:txbxContent' || tagName === 'txbxContent' || 
            tagName === 'v:textbox' || tagName === 'textbox' ||
            tagName === 'wps:txbx' || tagName === 'txbx') {
          return; // Don't traverse into textbox - its content is extracted separately
        }
        
        // Check for w:t tag (qualified name or local name)
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
          const { paragraphText, shapeText: cellShapeText } = this.extractTextFromParagraph(paragraph);
          const text = paragraphText + (cellShapeText.length > 0 ? cellShapeText : '');
          
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
   * 
   * CRITICAL: Exclude textbox content to avoid double extraction
   * Textbox text is extracted separately via extractTextFromParagraph
   * 
   * EXCEPTION: When searching for textbox elements themselves (wps:txbx, w:txbxContent, v:textbox),
   * we must find them, but still exclude their content from further recursion.
   */
  private getElementsByTagName(element: Element, tagName: string): Element[] {
    const results: Element[] = [];
    
    // Check if we're searching for a textbox element itself
    const isSearchingForTextbox = tagName === 'wps:txbx' || tagName === 'txbx' ||
                                   tagName === 'w:txbxContent' || tagName === 'txbxContent' ||
                                   tagName === 'v:textbox' || tagName === 'textbox';

    const traverse = (node: Node) => {
      if (node.nodeType === 1) { // Node.ELEMENT_NODE
        const elem = node as Element;
        const elemTagName = elem.tagName || elem.nodeName;
        
        // Check if this is a textbox element
        const isTextboxElement = elemTagName === 'w:txbxContent' || elemTagName === 'txbxContent' || 
                                 elemTagName === 'v:textbox' || elemTagName === 'textbox' ||
                                 elemTagName === 'wps:txbx' || elemTagName === 'txbx';
        
        // CRITICAL: Skip textbox content - it's extracted separately
        // BUT: We need special handling:
        // 1. When searching for textbox elements themselves (wps:txbx, w:txbxContent, v:textbox), we must find them
        // 2. When searching for w:p inside w:txbxContent, we must traverse into w:txbxContent
        // 3. Otherwise, skip textbox content
        if (!isSearchingForTextbox && isTextboxElement) {
          // We're not searching for textbox elements, but we found one
          // However, if we're searching for w:p, we might need to traverse into w:txbxContent
          if (tagName === 'w:p' || tagName === 'p') {
            // We're searching for paragraphs - allow traversal into w:txbxContent to find them
            if (elemTagName === 'w:txbxContent' || elemTagName === 'txbxContent') {
              // Continue traversal into w:txbxContent to find w:p paragraphs
              // Don't return - continue to traverse childNodes
            } else {
              // For other textbox elements (wps:txbx, v:textbox), skip them
              return;
            }
          } else {
            // For other searches, skip textbox content
            return;
          }
        }
        
        // Support both qualified names (w:p) and local names (p)
        // Add element to results BEFORE checking if we should stop recursion
        if (elemTagName === tagName || elemTagName.endsWith(':' + tagName.split(':').pop())) {
          results.push(elem);
        }
        
        // If we found a textbox and we're searching for it, handle special cases:
        // 1. When searching for w:txbxContent, we need to traverse into wps:txbx to find it
        // 2. When searching for w:p, we need to traverse into w:txbxContent to find paragraphs
        // 3. But we should NOT traverse into w:txbxContent when searching for other elements
        if (isSearchingForTextbox && isTextboxElement) {
          // If we're searching for w:txbxContent, we need to traverse into wps:txbx to find it
          if (tagName === 'w:txbxContent' || tagName === 'txbxContent') {
            // We're searching for w:txbxContent
            if (elemTagName === 'w:txbxContent' || elemTagName === 'txbxContent') {
              // We found w:txbxContent - don't traverse into it (we'll search for w:p separately)
              return;
            }
            // If we found wps:txbx, continue traversal to find w:txbxContent inside it
            // Don't return - continue to traverse childNodes below
          } else {
            // We're searching for wps:txbx or v:textbox - don't traverse into their content
            return;
          }
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
    // Set flag to disable logging during export for performance
    this.isExporting = true;
    
    if (!options.originalBuffer) {
      this.isExporting = false;
      throw new Error('Original DOCX buffer required for export');
    }

    // Step 1: Load original DOCX as ZIP
    // Add timeout wrapper to detect if JSZip.loadAsync hangs
    const zipPromise = JSZip.loadAsync(options.originalBuffer);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('JSZip.loadAsync timeout after 30s')), 30000);
    });
    
    let zip;
    try {
      zip = await Promise.race([zipPromise, timeoutPromise]) as JSZip;
    } catch (error) {
      throw error;
    }
    
    let documentXml;
    try {
      documentXml = await zip.file('word/document.xml')?.async('string');
    } catch (error) {
      throw error;
    }
    
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

    // Step 4: Create a map of segment index -> translated text and metadata
    const translationMap = new Map<number, { text: string; metadata?: Record<string, unknown> }>();
    for (const segment of options.segments) {
      translationMap.set(segment.index, { 
        text: segment.targetText,
        metadata: segment.metadata 
      });
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
        // CRITICAL: We must use the SAME extraction method as import to ensure matching
        // Using extractTextFromParagraphForExport would extract without formatting markers,
        // which would cause mismatches. We need to use extractTextFromParagraph but with
        // logging disabled (which is handled by isExporting flag).
        const { paragraphText, shapeText: paraShapeText, textboxParagraphs } = this.extractTextFromParagraph(element);
        
        // Process paragraph text segment (if not empty)
        if (paragraphText.trim().length > 0) {
          const segmentData = translationMap.get(segmentIndex);
          
          if (segmentData !== undefined) {
            // Replace text in this paragraph
            this.replaceTextInParagraph(element, segmentData.text);
          }
          
          segmentIndex++;
        }
        
        // Process textbox paragraph segments (one segment per paragraph, like regular paragraphs)
        if (textboxParagraphs && textboxParagraphs.length > 0) {
          const drawings = this.getElementsByTagName(element, 'w:drawing');
          
          for (let paraIdx = 0; paraIdx < textboxParagraphs.length; paraIdx++) {
            const segmentData = translationMap.get(segmentIndex);
            
            if (segmentData !== undefined && drawings.length > 0) {
              // Replace text in specific paragraph within textbox
              // Use paraIdx from metadata if available, otherwise use loop index
              const targetParaIdx = segmentData.metadata?.textboxParaIdx !== undefined 
                ? segmentData.metadata.textboxParaIdx as number 
                : paraIdx;
              this.replaceTextInShapes(drawings, segmentData.text, targetParaIdx);
            }
            
            segmentIndex++;
          }
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
    
    const result = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    
    // Reset flag
    this.isExporting = false;
    
    return result;
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
    // Check if this paragraph contains drawing/shape elements
    const drawings = this.getElementsByTagName(paragraphElement, 'w:drawing');
    
    // Extract shape text from translated text if present
    // For now, we'll try to preserve shape text by not modifying it
    // TODO: In the future, we could separate shape text into its own segments
    let shapeTextInTranslation = '';
    if (drawings.length > 0) {
      // Try to extract shape text from the end of translated text
      // This is a heuristic - ideally shapes should be separate segments
      }
    
    // Find all <w:r> (run) elements in this paragraph
    const runs = this.getElementsByTagName(paragraphElement, 'w:r');
    
    if (runs.length === 0) {
      // No runs found - use legacy method for regular text
      // Shapes (including textbox) are handled separately during export
      this.replaceTextInParagraphLegacy(paragraphElement, translatedText);
      return;
    }

    // Try to parse formatting markers
    const parsedSegments = this.parseFormattingMarkers(translatedText);
    
    if (parsedSegments && parsedSegments.length > 0) {
      // Markers found - distribute text to runs
      // CRITICAL FIX: We need to count formatting groups FIRST to detect mismatches
      // The issue is that after spacing normalization, many segments map to few groups
      // We'll do a quick pass to count groups, then decide whether to use legacy method
      
      // Quick pass: Count formatting groups (same logic as distributeTextToRuns)
      let formattingGroupCount = 0;
      let previousRunProperties: string | null = null;
      for (const run of runs) {
        const textNodes = this.getElementsByTagName(run, 'w:t');
        const hasText = textNodes.length > 0 && textNodes.some(tn => {
          const text = this.getTextNodeContent(tn);
          return text !== null && text.trim().length > 0;
        });
        
        if (hasText) {
          const runProperties = this.getRunProperties(run);
          if (previousRunProperties === null || runProperties !== previousRunProperties) {
            formattingGroupCount++;
            previousRunProperties = runProperties;
          }
        }
      }
      
      const segmentsCount = parsedSegments.length;
      
      // CRITICAL FIX: If we have significantly more segments than formatting groups,
      // it means the document was imported before spacing normalization
      // Use legacy method to preserve all text (better to lose formatting than text)
      if (segmentsCount > formattingGroupCount * 1.5) {
        // Formatting groups don't match - use legacy to preserve all text
        this.replaceTextInParagraphLegacy(paragraphElement, translatedText);
      } else {
        // Groups match - try to distribute
        this.distributeTextToRuns(runs, parsedSegments);
      }
    } else {
      // No valid markers - fallback to old behavior
      this.replaceTextInParagraphLegacy(paragraphElement, translatedText);
    }
    
    // CRITICAL: Shapes (including textbox) are now handled separately during export
    // We create separate segments for textbox text, so we don't need to handle shapes here
    // This prevents double processing of textbox content
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
        // No runs for this formatting group - skip
        continue;
      }

      // CRITICAL FIX: Unescape any XML entities first, then let createTextNode handle escaping
      // This prevents double-escaping (e.g., "&amp;" becoming "&amp;amp;")
      // createTextNode() will automatically escape special characters when serialized
      const unescapedText = this.unescapeXml(segment.text);

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
        
        this.setTextNodeContent(firstTextNode, unescapedText);
        
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

    // Step 4: Handle segments that couldn't be mapped to formatting groups
    // This can happen if the document was imported before spacing normalization
    // In this case, we need to put the text somewhere to preserve it
    const unmappedSegments: Array<{ runIndex: number; text: string }> = [];
    const mappedSegmentIndices = new Set<number>();
    
    for (const segment of segments) {
      const runsInGroup = formattingGroupToRuns.get(segment.runIndex);
      if (runsInGroup && runsInGroup.length > 0) {
        mappedSegmentIndices.add(segment.runIndex);
      } else {
        unmappedSegments.push(segment);
      }
    }
    
    // CRITICAL FIX: For unmapped segments, concatenate all text and put it in the first run
    // This preserves text even when formatting groups don't match
    if (unmappedSegments.length > 0 && runsWithText.length > 0) {
      const allUnmappedText = unmappedSegments.map(s => s.text).join('');
      // Unescape any XML entities - createTextNode will handle escaping automatically
      const unescapedText = this.unescapeXml(allUnmappedText);
      
      // Find the first run with text that hasn't been used yet
      const firstUnusedRun = runsWithText.find(runInfo => !mappedSegmentIndices.has(runInfo.formattingGroup));
      if (firstUnusedRun && firstUnusedRun.textNodes.length > 0) {
        const firstTextNode = firstUnusedRun.textNodes[0];
        this.setTextNodeContent(firstTextNode, unescapedText);
        
        // Clear other text nodes in this run
        for (let j = 1; j < firstUnusedRun.textNodes.length; j++) {
          this.setTextNodeContent(firstUnusedRun.textNodes[j], '');
        }
      }
    }

    // Step 5: Clear any runs that don't have corresponding segments
    const usedRunIndices = new Set<number>();
    for (const segment of segments) {
      const runsInGroup = formattingGroupToRuns.get(segment.runIndex);
      if (runsInGroup) {
        for (const runInfo of runsInGroup) {
          usedRunIndices.add(runInfo.runIndex);
        }
      }
    }
    
    // Also mark the fallback run as used if we used it
    if (unmappedSegments.length > 0 && runsWithText.length > 0) {
      const firstUnusedRun = runsWithText.find(runInfo => !mappedSegmentIndices.has(runInfo.formattingGroup));
      if (firstUnusedRun) {
        usedRunIndices.add(firstUnusedRun.runIndex);
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
   * Replace text in shape/drawing elements
   * Preserves formatting structure by only replacing text content
   * 
   * NOTE: This currently replaces all text nodes in a shape with the provided text.
   * This may lose formatting if the shape has multiple text nodes with different formatting.
   * A better approach would be to preserve the structure and replace text node by node.
   */
  private replaceTextInShapes(drawings: Element[], translatedText: string, targetParaIdx?: number): void {
    const strippedText = this.stripFormattingTags(translatedText);
    const unescapedText = this.unescapeXml(strippedText);
    
    for (const drawing of drawings) {
      // DrawingML textbox: <wps:txbx> with <w:txbxContent> containing <w:p> paragraphs
      // This must be checked FIRST because textbox contains paragraphs that need special handling
      const wpsTextboxes = this.getElementsByTagName(drawing, 'wps:txbx');
      if (wpsTextboxes.length > 0) {
        for (const wpsTextbox of wpsTextboxes) {
          const txbxContent = this.getElementsByTagName(wpsTextbox, 'w:txbxContent');
          for (const content of txbxContent) {
            const paragraphs = this.getElementsByTagName(content, 'w:p');
            
            // If targetParaIdx is specified, replace text only in that specific paragraph
            // Otherwise, use legacy logic (for backward compatibility)
            if (targetParaIdx !== undefined && targetParaIdx >= 0 && targetParaIdx < paragraphs.length) {
              const para = paragraphs[targetParaIdx];
              // Replace text in this specific paragraph, preserving formatting
              this.replaceTextInParagraphWithFormatting(para, unescapedText);
            } else {
              // Legacy logic: distribute text across all paragraphs (for backward compatibility)
              // This should not be used with new segmentation approach
              const textLines = unescapedText.split('\n');
              
              // Extract original text from each paragraph to understand structure
              const originalParaTexts: string[] = [];
              for (let i = 0; i < paragraphs.length; i++) {
                const para = paragraphs[i];
                const paraText = this.extractTextFromParagraphWithFormatting(para);
                originalParaTexts.push(paraText);
              }
              
              let textLineIndex = 0;
              for (let i = 0; i < paragraphs.length; i++) {
                const para = paragraphs[i];
                const originalParaText = originalParaTexts[i];
                const hadOriginalText = originalParaText.trim().length > 0;
                
                let paraText = '';
                
                if (hadOriginalText && textLineIndex < textLines.length) {
                  paraText = textLines[textLineIndex];
                  textLineIndex++;
                }
                
                // Replace text in this paragraph, preserving formatting
                this.replaceTextInParagraphWithFormatting(para, paraText);
              }
            }
          }
        }
        continue; // Skip other types if DrawingML textbox found
      }
      
      // DrawingML text: <a:t> elements (simple text, not in textbox)
      const drawingTextNodes = this.getElementsByTagName(drawing, 'a:t');
      if (drawingTextNodes.length > 0) {
        // Replace text in first node, clear others
        // TODO: Preserve formatting by replacing node-by-node instead of clearing all
        this.setTextNodeContent(drawingTextNodes[0], unescapedText);
        for (let i = 1; i < drawingTextNodes.length; i++) {
          this.setTextNodeContent(drawingTextNodes[i], '');
        }
        continue; // Skip VML if DrawingML found
      }
      
      // VML text: <v:textbox> with <w:t> inside
      const textboxes = this.getElementsByTagName(drawing, 'v:textbox');
      for (const textbox of textboxes) {
        const vmlTextNodes = this.findAllTextNodes(textbox);
        if (vmlTextNodes.length > 0) {
          this.setTextNodeContent(vmlTextNodes[0], unescapedText);
          for (let i = 1; i < vmlTextNodes.length; i++) {
            this.setTextNodeContent(vmlTextNodes[i], '');
          }
          }
      }
    }
  }

  /**
   * Replace text in paragraph preserving formatting (list items, line breaks)
   * Used for textbox paragraphs to maintain structure
   */
  private replaceTextInParagraphWithFormatting(paragraphElement: Element, translatedText: string): void {
    // Strip formatting tags before processing
    const strippedText = this.stripFormattingTags(translatedText);
    // Unescape any XML entities
    const unescapedText = this.unescapeXml(strippedText);
    
    // Remove bullet markers if paragraph has w:numPr (Word will add them automatically)
    let textToInsert = unescapedText;
    const pPrElements = this.getElementsByTagName(paragraphElement, 'w:pPr');
    if (pPrElements.length > 0) {
      const pPr = pPrElements[0];
      const numPrElements = this.getElementsByTagName(pPr, 'w:numPr');
      if (numPrElements.length > 0) {
        // Paragraph is a list item - remove bullet marker if present
        textToInsert = textToInsert.replace(/^\s*[•\-\*]\s+/, '');
      }
    }
    
    // Check if text contains line breaks that need to be preserved
    if (textToInsert.includes('\n')) {
      // Split by newlines and insert <w:br/> elements
      const textParts = textToInsert.split('\n');
      const runs = this.getElementsByTagName(paragraphElement, 'w:r');
      
      if (runs.length > 0) {
        // Use first run for first text part
        const firstRun = runs[0];
        const firstTextNode = this.findAllTextNodes(firstRun)[0];
        if (firstTextNode) {
          this.setTextNodeContent(firstTextNode, textParts[0]);
        }
        
        // Insert remaining text parts with line breaks
        for (let i = 1; i < textParts.length; i++) {
          // Create a new run with line break
          const newRun = paragraphElement.ownerDocument!.createElement('w:r');
          const textNode = paragraphElement.ownerDocument!.createElement('w:t');
          const brNode = paragraphElement.ownerDocument!.createElement('w:br');
          
          // Insert line break before text
          newRun.appendChild(brNode);
          textNode.appendChild(paragraphElement.ownerDocument!.createTextNode(textParts[i]));
          newRun.appendChild(textNode);
          
          // Insert after first run or after previous run
          if (i === 1) {
            paragraphElement.insertBefore(newRun, firstRun.nextSibling);
          } else {
            const prevRun = paragraphElement.childNodes[paragraphElement.childNodes.length - 1] as Element;
            paragraphElement.insertBefore(newRun, prevRun.nextSibling);
          }
        }
        
        // Clear remaining runs
        for (let i = 1; i < runs.length; i++) {
          const textNodes = this.findAllTextNodes(runs[i]);
          for (const textNode of textNodes) {
            this.setTextNodeContent(textNode, '');
          }
        }
      } else {
        // No runs - use legacy method
        this.replaceTextInParagraphLegacy(paragraphElement, textToInsert);
      }
    } else {
      // No line breaks - use legacy method
      this.replaceTextInParagraphLegacy(paragraphElement, textToInsert);
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

    // Strip formatting tags before setting text
    const strippedText = this.stripFormattingTags(translatedText);
    // Unescape any XML entities - createTextNode will handle escaping automatically
    const unescapedText = this.unescapeXml(strippedText);
    this.setTextNodeContent(textNodes[0], unescapedText);

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
   * Strip formatting tags from text
   * 
   * Removes all formatting markers like {{0}}, {{/0}}, {{1}}, {{/1}}, etc.
   * This is used when formatting markers are invalid or missing.
   */
  private stripFormattingTags(text: string): string {
    // Remove all formatting markers: {{n}} and {{/n}} where n is a number (including negative)
    // Also handle {{/-1}} which should not appear but we strip it anyway
    return text.replace(/\{\{\/?-?\d+\}\}/g, '');
  }

  /**
   * Unescape XML entities in text
   * 
   * Converts: &amp; &lt; &gt; &quot; &apos;
   * To:      & < > " '
   * 
   * This is needed because when text is read from XML, entities are already unescaped,
   * but if text comes from translation or other sources, it might contain escaped entities.
   */
  private unescapeXml(text: string): string {
    return text
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&'); // Must be last to avoid double-unescaping
  }

  /**
   * Escape XML special characters
   * 
   * Converts: & < > " '
   * To:      &amp; &lt; &gt; &quot; &apos;
   * 
   * NOTE: When using createTextNode(), the DOM API automatically escapes text,
   * so we should NOT call this before setTextNodeContent. Instead, we should
   * unescape any existing entities and let createTextNode handle escaping.
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
    translationMap: Map<number, { text: string; metadata?: Record<string, unknown> }>,
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
          const { paragraphText, shapeText: cellShapeText } = this.extractTextFromParagraph(paragraph);
          const originalText = paragraphText + (cellShapeText.length > 0 ? cellShapeText : '');
          
          // Only process if cell has text (same logic as import)
          if (originalText.trim().length > 0) {
            const segmentData = translationMap.get(currentIndex);
            
            if (segmentData !== undefined) {
              // Replace text in this paragraph
              this.replaceTextInParagraph(paragraph, segmentData.text);
            }
            
            currentIndex++;
          }
        }
      }
    }

    return currentIndex;
  }
}
