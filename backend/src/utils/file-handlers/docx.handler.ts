import JSZip from 'jszip';
import { XMLParser, XMLBuilder, XmlBuilderOptions } from 'fast-xml-parser';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { FileHandler, ParsedFileResult, ExportOptions } from './types';
import { logger } from '../logger';

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
  // Enable preserveOrder to maintain element order (paragraphs and tables mixed)
  private parser = new XMLParser({ 
    ignoreAttributes: false, 
    attributeNamePrefix: '@_', 
    preserveOrder: true, // Enable order preservation
    trimValues: false,
  });
  private builder = new XMLBuilder({ 
    ignoreAttributes: false, 
    attributeNamePrefix: '@_', 
    format: true, 
    preserveOrder: true, // Enable order preservation
  });

  supports(mimeType: string | undefined, extension: string): boolean {
    return extension === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  // REMOVED: parseWithMammoth - using XML-only parsing
  // Legacy method removed as part of Phase 1.1 cleanup

  // REMOVED: All LibreOffice and Mammoth parsing methods - using XML-only parsing
  // Legacy methods removed as part of Phase 1.1 cleanup:
  // - isLibreOfficeAvailable
  // - getLibreOfficeStatus  
  // - parseWithLibreOffice
  // - parseHtmlFromLibreOffice
  // - extractTextFromHtml
  // - extractTextFromMammothElement
  // - parseWithMammoth

  /**
   * Escape XML special characters for use in XML strings
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
   * Escape special regex characters for use in regex patterns
   */
  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Normalize text for robust comparison by removing zero-width spaces,
   * non-breaking spaces, and trimming whitespace
   */
  private normalizeText(text: string): string {
    if (!text) return '';
    return text
      .replace(/\u200B/g, '') // Zero-width space
      .replace(/\u00A0/g, ' ') // Non-breaking space to regular space
      .replace(/\uFEFF/g, '') // Zero-width no-break space
      .trim();
  }

  /**
   * Strip formatting tags from text (e.g., <b id="1">text</b> -> text)
   * Used to compare formattedText with plain text
   */
  private stripFormattingTags(text: string): string {
    if (!text) return '';
    // Remove formatting tags like <b id="1">, </b>, <i id="2">, </i>, etc.
    return text.replace(/<[^>]+>/g, '');
  }

  /**
   * Parse formatting tags from translated text
   * Extracts tags like <b id="1">text</b>, <i id="2">text</i>, etc.
   * Returns array of text chunks with their associated formatting tags
   */
  private parseFormattingTags(text: string): Array<{
    text: string;
    tags: Array<{ type: string; id: string }>; // Stack of open tags
  }> {
    const result: Array<{ text: string; tags: Array<{ type: string; id: string }> }> = [];
    const tagStack: Array<{ type: string; id: string }> = [];
    let currentText = '';
    let i = 0;

    while (i < text.length) {
      if (text[i] === '<' && i + 1 < text.length) {
        // Check if it's a closing tag
        if (text[i + 1] === '/') {
          // Closing tag: </b>, </i>, etc.
          const tagEnd = text.indexOf('>', i);
          if (tagEnd === -1) {
            currentText += text[i];
            i++;
            continue;
          }
          
          // Save current text if any
          if (currentText) {
            result.push({
              text: currentText,
              tags: [...tagStack],
            });
            currentText = '';
          }
          
          // Pop matching tag from stack
          const tagContent = text.substring(i + 2, tagEnd);
          const tagType = tagContent.split(/\s+/)[0].toLowerCase();
          const tagIndex = tagStack.findIndex(t => t.type === tagType);
          if (tagIndex !== -1) {
            tagStack.splice(tagIndex, 1);
          }
          
          i = tagEnd + 1;
        } else {
          // Opening tag: <b id="1">, <i id="2">, etc.
          const tagEnd = text.indexOf('>', i);
          if (tagEnd === -1) {
            currentText += text[i];
            i++;
            continue;
          }
          
          // Save current text if any
          if (currentText) {
            result.push({
              text: currentText,
              tags: [...tagStack],
            });
            currentText = '';
          }
          
          // Parse opening tag
          const tagContent = text.substring(i + 1, tagEnd);
          const tagMatch = tagContent.match(/^(\w+)(?:\s+id="(\d+)")?/);
          if (tagMatch) {
            const tagType = tagMatch[1].toLowerCase();
            const tagId = tagMatch[2] || '';
            tagStack.push({ type: tagType, id: tagId });
          }
          
          i = tagEnd + 1;
        }
      } else {
        currentText += text[i];
        i++;
      }
    }
    
    // Add remaining text
    if (currentText) {
      result.push({
        text: currentText,
        tags: [...tagStack],
      });
    }
    
    return result;
  }

  /**
   * Match formatting tags to runs using formattedRuns metadata
   * Returns a map of runIndex -> translated text for that run
   */
  private matchTagsToRuns(
    formattedChunks: Array<{ text: string; tags: Array<{ type: string; id: string }> }>,
    formattedRuns: Array<{
      text: string;
      formatting: {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        subscript: boolean;
        superscript: boolean;
        formattingId: string;
      };
      location: {
        paragraphIndex: number;
        runIndex: number;
        path: string;
      };
    }>
  ): Map<number, string> {
    const runMap = new Map<number, string>();
    
    // Create a map of formattingId -> runIndex for quick lookup
    const formattingToRunMap = new Map<string, number>();
    formattedRuns.forEach((run, idx) => {
      if (run.formatting.formattingId) {
        formattingToRunMap.set(run.formatting.formattingId, run.location.runIndex);
      }
    });
    
    // Also create a map of tag combinations to formattingId
    // Tag format: "b1" means bold with id="1", "i2" means italic with id="2"
    // We need to match tag combinations to formattingId
    const tagCombinationToFormattingId = new Map<string, string>();
    formattedRuns.forEach(run => {
      if (run.formatting.formattingId) {
        // Build tag combination string from formatting
        const tagParts: string[] = [];
        if (run.formatting.bold) tagParts.push('b');
        if (run.formatting.italic) tagParts.push('i');
        if (run.formatting.underline) tagParts.push('u');
        if (run.formatting.subscript) tagParts.push('sub');
        if (run.formatting.superscript) tagParts.push('sup');
        const tagCombo = tagParts.join('');
        tagCombinationToFormattingId.set(tagCombo, run.formatting.formattingId);
      }
    });
    
    // Distribute formatted chunks to runs
    // Strategy: Match chunks to runs by formatting tags, maintaining order
    // CRITICAL: Ensure ALL text from chunks is distributed - no truncation
    let currentRunIndex = 0;
    const usedRunIndices = new Set<number>();
    
    for (const chunk of formattedChunks) {
      // Include all text, even if it's just whitespace (preserve structure)
      const chunkText = chunk.text;
      // Only skip completely empty chunks
      if (!chunkText || chunkText.length === 0) continue;
      
      // Try to match tags to a specific run
      if (chunk.tags.length > 0) {
        // Build tag combination from chunk tags (sorted for consistency)
        const chunkTagTypes = chunk.tags.map(t => t.type).sort().join('');
        
        // Find matching run by formatting
        let matchedRunIndex: number | undefined;
        for (const run of formattedRuns) {
          const runTagTypes: string[] = [];
          if (run.formatting.bold) runTagTypes.push('b');
          if (run.formatting.italic) runTagTypes.push('i');
          if (run.formatting.underline) runTagTypes.push('u');
          if (run.formatting.subscript) runTagTypes.push('sub');
          if (run.formatting.superscript) runTagTypes.push('sup');
          const runTagCombo = runTagTypes.sort().join('');
          
          if (runTagCombo === chunkTagTypes) {
            matchedRunIndex = run.location.runIndex;
            break;
          }
        }
        
        if (matchedRunIndex !== undefined) {
          // Append to existing run text
          const existing = runMap.get(matchedRunIndex) || '';
          runMap.set(matchedRunIndex, existing + chunkText);
          usedRunIndices.add(matchedRunIndex);
          // Don't update currentRunIndex - allow multiple chunks per run
        } else {
          // No exact match, use current run index
          const existing = runMap.get(currentRunIndex) || '';
          runMap.set(currentRunIndex, existing + chunkText);
          usedRunIndices.add(currentRunIndex);
          // Move to next run for next chunk
          if (currentRunIndex < formattedRuns.length - 1) {
            currentRunIndex++;
          }
        }
      } else {
        // No tags, use current run index
        const existing = runMap.get(currentRunIndex) || '';
        runMap.set(currentRunIndex, existing + chunkText);
        usedRunIndices.add(currentRunIndex);
        // Move to next run for next chunk
        if (currentRunIndex < formattedRuns.length - 1) {
          currentRunIndex++;
        }
      }
    }
    
    // CRITICAL: Verify all chunk text was distributed
    const totalChunkText = formattedChunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    const totalRunText = Array.from(runMap.values()).reduce((sum, text) => sum + text.length, 0);
    
    if (totalChunkText !== totalRunText) {
      logger.warn({
        totalChunkText,
        totalRunText,
        difference: totalChunkText - totalRunText,
        chunkCount: formattedChunks.length,
        runCount: formattedRuns.length,
      }, 'Export: Text length mismatch in matchTagsToRuns - some text may be lost');
    }
    
    return runMap;
  }

  /**
   * Reconstruct a paragraph by surgically replacing text in runs
   * Only modifies <w:t> nodes, preserves all other XML structure
   */
  private reconstructParagraph(
    paragraphElement: Element,
    translatedText: string,
    metadata: {
      location?: {
        paragraphIndex: number;
        paragraphPath: string;
        runCount: number;
      };
      formattedRuns?: Array<{
        text: string;
        formatting: {
          bold: boolean;
          italic: boolean;
          underline: boolean;
          subscript: boolean;
          superscript: boolean;
          formattingId: string;
        };
        location: {
          paragraphIndex: number;
          runIndex: number;
          path: string;
        };
      }>;
    }
  ): void {
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    
    // Get all runs in this paragraph
    const runs = paragraphElement.getElementsByTagNameNS(namespace, 'r');
    const runArray = Array.from(runs);
    
    if (runArray.length === 0) {
      // No runs to update
      return;
    }
    
    // Check if translated text has formatting tags
    const hasFormattingTags = /<[biu]|<\/[biu]|<sub|<\/sub|<sup|<\/sup/.test(translatedText);
    
    if (hasFormattingTags && metadata.formattedRuns && metadata.formattedRuns.length > 0) {
      // Parse formatting tags from translated text
      const formattedChunks = this.parseFormattingTags(translatedText);
      
      // Match tags to runs
      const runTextMap = this.matchTagsToRuns(formattedChunks, metadata.formattedRuns);
      
      // Update runs with translated text
      // CRITICAL: Only update runs that have text assigned - preserve empty runs as-is
      for (let i = 0; i < runArray.length; i++) {
        const run = runArray[i];
        const translatedRunText = runTextMap.get(i);
        
        if (translatedRunText !== undefined && translatedRunText.length > 0) {
          // Find or create <w:t> node in this run
          const textNodes = run.getElementsByTagNameNS(namespace, 't');
          
          if (textNodes.length > 0) {
            // Update existing text node
            const textNode = textNodes[0];
            if (textNode.firstChild) {
              textNode.firstChild.nodeValue = translatedRunText;
            } else {
              const textContent = paragraphElement.ownerDocument?.createTextNode(translatedRunText);
              if (textContent) {
                textNode.appendChild(textContent);
              }
            }
          } else {
            // Create new text node if it doesn't exist
            const textNode = paragraphElement.ownerDocument?.createElementNS(namespace, 't');
            if (textNode) {
              const textContent = paragraphElement.ownerDocument?.createTextNode(translatedRunText);
              if (textContent) {
                textNode.appendChild(textContent);
                run.appendChild(textNode);
              }
            }
          }
        }
        // If translatedRunText is undefined or empty, leave the run as-is (preserves original text or formatting)
      }
      
      // CRITICAL: Verify all text was distributed
      const totalRunText = Array.from(runTextMap.values()).reduce((sum, text) => sum + (text?.length || 0), 0);
      const totalChunkText = formattedChunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
      
      if (totalRunText !== totalChunkText) {
        logger.warn({
          totalRunText,
          totalChunkText,
          difference: totalChunkText - totalRunText,
          runCount: runArray.length,
          runsWithText: runTextMap.size,
          chunkCount: formattedChunks.length,
        }, 'Export: Text length mismatch in reconstructParagraph - some text may be lost');
        
        // Fix: Add missing text to the last run with text
        if (totalRunText < totalChunkText) {
          const missingText = translatedText.substring(totalRunText);
          if (missingText.length > 0 && runTextMap.size > 0) {
            // Find the last run that has text and add missing text to it
            for (let i = runArray.length - 1; i >= 0; i--) {
              const existingText = runTextMap.get(i);
              if (existingText !== undefined) {
                runTextMap.set(i, existingText + missingText);
                // Update the run with the corrected text
                const run = runArray[i];
                const textNodes = run.getElementsByTagNameNS(namespace, 't');
                if (textNodes.length > 0) {
                  const textNode = textNodes[0];
                  if (textNode.firstChild) {
                    textNode.firstChild.nodeValue = runTextMap.get(i)!;
                  }
                }
                break;
              }
            }
          }
        }
      }
    } else {
      // Fallback: No formatting tags or no formattedRuns metadata
      // Distribute text intelligently across runs
      // CRITICAL: Ensure ALL text is distributed, no truncation
      const words = translatedText.trim().split(/\s+/);
      
      if (words.length === 0) {
        // No words to distribute
        return;
      }
      
      // Calculate words per run, ensuring last run gets all remaining words
      const wordsPerRun = Math.ceil(words.length / runArray.length);
      let wordIndex = 0;
      
      for (let i = 0; i < runArray.length; i++) {
        const run = runArray[i];
        let runText = '';
        
        if (i === runArray.length - 1) {
          // Last run gets ALL remaining words to prevent truncation
          const remainingWords = words.slice(wordIndex);
          runText = remainingWords.join(' ');
        } else {
          // Calculate how many words this run should get
          const runWords = words.slice(wordIndex, wordIndex + wordsPerRun);
          runText = runWords.join(' ');
          wordIndex += wordsPerRun;
        }
        
        // Update or create text node
        const textNodes = run.getElementsByTagNameNS(namespace, 't');
        if (textNodes.length > 0) {
          const textNode = textNodes[0];
          if (textNode.firstChild) {
            textNode.firstChild.nodeValue = runText;
          } else {
            const textContent = paragraphElement.ownerDocument?.createTextNode(runText);
            if (textContent) {
              textNode.appendChild(textContent);
            }
          }
        } else {
          const textNode = paragraphElement.ownerDocument?.createElementNS(namespace, 't');
          if (textNode) {
            const textContent = paragraphElement.ownerDocument?.createTextNode(runText);
            if (textContent) {
              textNode.appendChild(textContent);
              run.appendChild(textNode);
            }
          }
        }
      }
    }
  }

  /**
   * Extract text from a paragraph XML structure
   * Handles both standard structure and preserveOrder structure
   */
  /**
   * Check if a paragraph is part of a table of contents (TOC) field
   * TOC fields contain w:fldChar elements and w:instrText with "TOC" instruction
   * Also check for TOC styles and hyperlinks that are typical of TOC entries
   */
  private isTableOfContentsParagraph(para: any, logContext?: { parseElementIndex?: number }): boolean {
    if (!para || typeof para !== 'object') {
      return false;
    }
    
    // Get paragraph text first to check for TOC patterns
    const paraText = this.extractTextFromParagraph(para);
    
    // Check paragraph style - TOC entries often have specific styles
    const pPr = para['w:pPr'];
    let styleId = 'none';
    if (pPr && typeof pPr === 'object') {
      const pStyle = pPr['w:pStyle'];
      if (pStyle) {
        styleId = typeof pStyle === 'string' 
          ? pStyle 
          : (pStyle['@_w:val'] || '');
        if (styleId && typeof styleId === 'string' && styleId.toUpperCase().includes('TOC')) {
          // #region agent log
          logger.debug({ styleId, reason: 'TOC_style', paraTextPreview: paraText?.substring(0, 50) }, 'Parse: detected TOC paragraph by style');
          // #endregion
          return true;
        }
      }
    }
    
    // Additional heuristic: Check if paragraph text matches TOC entry pattern
    // TOC entries often have patterns like:
    // - "1. Title ......... 5" (with dots)
    // - "1. OBJECTIVES AND SCOPE 1" (without dots, but has number, text, page number)
    // - "Title ................ 5" (with dots, no leading number)
    if (paraText && paraText.trim()) {
      const trimmedText = paraText.trim();
      
      // Pattern 1: "1. Title ......... 5" - number, text, dots, page number
      const tocPattern1 = /^\d+\.\s+.+\.{3,}\s+\d+$/;
      
      // Pattern 2: "Title ................ 5" - text, dots, page number
      const tocPattern2 = /^.+\.{2,}\s+\d+$/;
      
      // Pattern 3: "Title ........" - text with dots at end (incomplete TOC)
      const tocPattern3 = /^.+\.{2,}$/;
      
      // Pattern 4: "1. OBJECTIVES AND SCOPE 1" - number, text, page number (NO dots)
      // This is a common TOC format without leader dots
      const tocPattern4 = /^\d+\.\s+.{5,100}\s+\d{1,3}$/;
      
      // Pattern 5: "1. Title 5" - short format with number, short text, page number
      const tocPattern5 = /^\d+\.\s+.{1,50}\s+\d{1,3}$/;
      
      const hasTOCPattern = tocPattern1.test(trimmedText) || 
                            tocPattern2.test(trimmedText) || 
                            tocPattern3.test(trimmedText) ||
                            tocPattern4.test(trimmedText) ||
                            tocPattern5.test(trimmedText);
      
      if (hasTOCPattern) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:999',message:'Parse: detected TOC paragraph by text pattern',data:{paraTextPreview:paraText.substring(0,50),reason:'TOC_pattern',styleId,matchedPattern:tocPattern1.test(trimmedText)?'pattern1':tocPattern2.test(trimmedText)?'pattern2':tocPattern3.test(trimmedText)?'pattern3':tocPattern4.test(trimmedText)?'pattern4':'pattern5'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
        // #endregion
        return true;
      }
    }
    
    // Check for field characters (w:fldChar) - TOC fields have begin/end markers
    const runs = para['w:r'] || [];
    const runArray = Array.isArray(runs) ? runs : (runs ? [runs] : []);
    
    let hasFieldBegin = false;
    let hasFieldEnd = false;
    let hasTOCInstruction = false;
    let hasHyperlink = false;
    let tocInstructionText = '';
    let fldCharTypes: string[] = [];
    
    for (const run of runArray) {
      if (!run || typeof run !== 'object') {
        continue;
      }
      
      // Check for field begin/end characters
      if (run['w:fldChar']) {
        const fldChar = run['w:fldChar'];
        const fldCharType = fldChar['@_w:fldCharType'] || fldChar['w:fldCharType'];
        if (fldCharType) {
          fldCharTypes.push(fldCharType);
          if (fldCharType === 'begin') {
            hasFieldBegin = true;
          } else if (fldCharType === 'end') {
            hasFieldEnd = true;
          }
        }
      }
      
      // Check for instruction text containing TOC
      if (run['w:instrText']) {
        const instrText = run['w:instrText'];
        const text = typeof instrText === 'string' 
          ? instrText 
          : (instrText['#text'] || instrText['@_#text'] || instrText['@_#text'] || '');
        if (text && typeof text === 'string') {
          if (text.toUpperCase().includes('TOC')) {
            hasTOCInstruction = true;
            tocInstructionText = text;
          }
        }
      }
      
      // Check for hyperlinks - TOC entries often contain hyperlinks
      if (run['w:hyperlink']) {
        hasHyperlink = true;
      }
    }
    
    // Also check if paragraph contains hyperlinks directly (not in runs)
    if (para['w:hyperlink']) {
      hasHyperlink = true;
    }
    
    const isTOC = hasFieldBegin || hasTOCInstruction || (hasHyperlink && runArray.length > 0);
    
    // #region agent log
    // Always log TOC detection for first 30 elements to understand the structure
    if (logContext?.parseElementIndex !== undefined && logContext.parseElementIndex <= 30) {
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1055',message:'Parse: TOC detection detailed',data:{parseElementIndex:logContext.parseElementIndex,hasFieldBegin,hasFieldEnd,hasTOCInstruction,hasHyperlink,styleId:styleId||'none',runCount:runArray.length,isTOC,detectionMethod:hasFieldBegin?'fldChar':hasTOCInstruction?'instrText':hasHyperlink?'hyperlink':'none',fldCharTypes,tocInstructionText:tocInstructionText.substring(0,100),paraTextPreview:paraText?.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    }
    // #endregion
    
    return isTOC;
  }
  
  /**
   * Check if a DOM paragraph element is part of a table of contents (TOC) field
   * 
   * CRITICAL: This must match the logic in isTableOfContentsParagraph
   */
  private isTableOfContentsParagraphDOM(element: Element, elementIndex?: number): boolean {
    if (!element) {
      return false;
    }
    
    // Get paragraph text first to check for TOC patterns
    const paraText = this.extractTextFromParagraphDOM(element);
    
    // Check paragraph style - TOC entries often have specific styles
    const pPr = element.getElementsByTagNameNS(
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'pPr'
    );
    let styleId = 'none';
    if (pPr.length > 0) {
      const pStyle = pPr[0].getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'pStyle'
      );
      if (pStyle.length > 0) {
        styleId = pStyle[0].getAttribute('w:val') || 'none';
        if (styleId && styleId.toUpperCase().includes('TOC')) {
          // #region agent log
          logger.debug({ styleId, reason: 'TOC_style', paraTextPreview: paraText?.substring(0, 50) }, 'Export: detected TOC paragraph by style');
          // #endregion
          return true;
        }
      }
    }
    
    // Additional heuristic: Check if paragraph text matches TOC entry pattern
    // TOC entries often have patterns like:
    // - "1. Title ......... 5" (with dots)
    // - "1. OBJECTIVES AND SCOPE 1" (without dots, but has number, text, page number)
    // - "Title ................ 5" (with dots, no leading number)
    if (paraText && paraText.trim()) {
      const trimmedText = paraText.trim();
      
      // Pattern 1: "1. Title ......... 5" - number, text, dots, page number
      const tocPattern1 = /^\d+\.\s+.+\.{3,}\s+\d+$/;
      
      // Pattern 2: "Title ................ 5" - text, dots, page number
      const tocPattern2 = /^.+\.{2,}\s+\d+$/;
      
      // Pattern 3: "Title ........" - text with dots at end (incomplete TOC)
      const tocPattern3 = /^.+\.{2,}$/;
      
      // Pattern 4: "1. OBJECTIVES AND SCOPE 1" - number, text, page number (NO dots)
      // This is a common TOC format without leader dots
      const tocPattern4 = /^\d+\.\s+.{5,100}\s+\d{1,3}$/;
      
      // Pattern 5: "1. Title 5" - short format with number, short text, page number
      const tocPattern5 = /^\d+\.\s+.{1,50}\s+\d{1,3}$/;
      
      const hasTOCPattern = tocPattern1.test(trimmedText) || 
                            tocPattern2.test(trimmedText) || 
                            tocPattern3.test(trimmedText) ||
                            tocPattern4.test(trimmedText) ||
                            tocPattern5.test(trimmedText);
      
      if (hasTOCPattern) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1121',message:'Export: detected TOC paragraph by text pattern',data:{paraTextPreview:paraText.substring(0,50),reason:'TOC_pattern',styleId,matchedPattern:tocPattern1.test(trimmedText)?'pattern1':tocPattern2.test(trimmedText)?'pattern2':tocPattern3.test(trimmedText)?'pattern3':tocPattern4.test(trimmedText)?'pattern4':'pattern5'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
        // #endregion
        return true;
      }
    }
    
    // Check for field characters (w:fldChar) - TOC fields have begin/end markers
    const runs = element.getElementsByTagNameNS(
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'r'
    );
    
    let hasFieldBegin = false;
    let hasFieldEnd = false;
    let hasTOCInstruction = false;
    let hasHyperlink = false;
    let tocInstructionText = '';
    let fldCharTypes: string[] = [];
    
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      
      // Check for field begin/end characters
      const fldChars = run.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'fldChar'
      );
      for (let j = 0; j < fldChars.length; j++) {
        const fldChar = fldChars[j];
        const fldCharType = fldChar.getAttribute('w:fldCharType');
        if (fldCharType) {
          fldCharTypes.push(fldCharType);
          if (fldCharType === 'begin') {
            hasFieldBegin = true;
          } else if (fldCharType === 'end') {
            hasFieldEnd = true;
          }
        }
      }
      
      // Check for instruction text containing TOC
      const instrTexts = run.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'instrText'
      );
      for (let j = 0; j < instrTexts.length; j++) {
        const instrText = instrTexts[j];
        const text = instrText.textContent || '';
        if (text.toUpperCase().includes('TOC')) {
          hasTOCInstruction = true;
          tocInstructionText = text;
        }
      }
    }
    
    // Check for hyperlinks - TOC entries often contain hyperlinks
    const hyperlinks = element.getElementsByTagNameNS(
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'hyperlink'
    );
    if (hyperlinks.length > 0) {
      hasHyperlink = true;
    }
    
    const isTOC = hasFieldBegin || hasTOCInstruction || (hasHyperlink && runs.length > 0);
    
    // #region agent log
    // Always log TOC detection for first 30 elements to understand the structure
    if (elementIndex !== undefined && typeof elementIndex === 'number' && elementIndex <= 30) {
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1182',message:'Export: TOC detection detailed',data:{elementIndex,hasFieldBegin,hasFieldEnd,hasTOCInstruction,hasHyperlink,styleId:styleId||'none',runCount:runs.length,isTOC,detectionMethod:hasFieldBegin?'fldChar':hasTOCInstruction?'instrText':hasHyperlink?'hyperlink':'none',fldCharTypes,tocInstructionText:tocInstructionText.substring(0,100),paraTextPreview:paraText?.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    }
    // #endregion
    
    return isTOC;
  }

  /**
   * Normalize text for comparison - replaces non-breaking spaces with regular spaces and trims
   * Used by both parse and export to ensure consistent empty text detection
   */
  /**
   * Aggressively normalize text for comparison to eliminate ghost segments from invisible characters.
   * Strips all non-printable characters and extensive whitespace.
   * 
   * Removes:
   * - Zero-Width Space (\u200B)
   * - Zero-Width Non-Joiner (\u200C)
   * - Zero-Width Joiner (\u200D)
   * - Zero-Width No-Break Space (\uFEFF)
   * - Non-Breaking Space (\u00A0) -> converted to regular space
   * - Carriage Return (\r)
   * - Line Feed (\n)
   * - Tab (\t)
   * - Any other control characters
   * 
   * Goal: If text contains only invisible markers or whitespace, it MUST resolve to empty string.
   */
  private normalizeTextForComparison(text: string): string {
    if (!text || typeof text !== 'string') {
      return '';
    }
    
    // Replace non-breaking space with regular space
    let normalized = text.replace(/\u00A0/g, ' ');
    
    // Remove all zero-width characters and other invisible Unicode characters
    // \u200B-\u200D: Zero-width space, non-joiner, joiner
    // \uFEFF: Zero-width no-break space (BOM)
    normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    // Remove all control characters (including \r, \n, \t)
    // Control characters are \u0000-\u001F and \u007F-\u009F
    normalized = normalized.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    
    // Normalize multiple spaces to single space
    normalized = normalized.replace(/\s+/g, ' ');
    
    // Final trim
    normalized = normalized.trim();
    
    return normalized;
  }

  private extractTextFromParagraph(para: any): string {
    // With preserveOrder, para might be an array: [{ 'w:r': {...} }, { 'w:pPr': {...} }, { 'w:r': {...} }]
    // Or it might be an object: { 'w:r': [...], 'w:pPr': {...} }
    // CRITICAL: With preserveOrder, each run is a separate array item: { 'w:r': {...} }
    // We need to collect ALL runs from the array, not just the first one
    let runs: any = null;
    let runArray: any[] = [];
    
    if (Array.isArray(para)) {
      // Collect ALL runs from the array - each item might be a run
      for (const paraItem of para) {
        if (paraItem && typeof paraItem === 'object' && 'w:r' in paraItem) {
          const runItem = paraItem['w:r'];
          // Each runItem might be a single run object or an array of runs
          if (Array.isArray(runItem)) {
            runArray.push(...runItem);
          } else if (runItem) {
            runArray.push(runItem);
          }
        }
      }
    } else if (para && typeof para === 'object') {
      runs = para['w:r'];
      runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
    }
    
    if (runArray.length === 0) return '';
    
    // HARDENED: Filter out noise runs and extract text from valid runs
    const textParts: string[] = [];
    
    for (const run of runArray) {
      if (!run || typeof run !== 'object') continue;
      
      // HARDENED: Skip noise runs (contain only proof errors, revision IDs, etc.)
      if (this.isNoiseRun(run)) {
        continue; // Skip this run entirely
      }
      
      const textNode = run['w:t'];
      if (!textNode) continue;
      
      // Handle various text node structures
      let extractedText = '';
      if (Array.isArray(textNode)) {
        extractedText = textNode
          .map((t: any) => {
            if (typeof t === 'string') return t;
            if (typeof t === 'object' && t !== null) {
              return typeof t['#text'] === 'string' ? t['#text'] : '';
            }
            return '';
          })
          .join('');
      } else if (typeof textNode === 'string') {
        extractedText = textNode;
      } else if (typeof textNode === 'object' && textNode !== null) {
        extractedText = typeof textNode['#text'] === 'string' ? textNode['#text'] : '';
      }
      
      if (extractedText && extractedText.length > 0) {
        textParts.push(extractedText);
      }
    }
    
    // HARDENED: Merge adjacent text parts (Word splits text across runs)
    // Join directly without spaces - Word includes spaces in text nodes when needed
    const joinedText = textParts.join('');
    
    // CRITICAL: Normalize text for consistent empty detection (replace non-breaking spaces, trim)
    const result = this.normalizeTextForComparison(joinedText);
    
    // #region agent log
    if (result.length > 0) {
      const isAllCaps = result === result.toUpperCase() && result.length > 1 && /^[A-Z\s]+$/.test(result);
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:804',message:'extractTextFromParagraph: final result',data:{result,resultLength:result.length,joinedLength:joinedText.length,isAllCaps},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'N'})}).catch(()=>{});
    }
    // #endregion
    
    return result;
  }

  /**
   * Extract runs from a paragraph XML structure
   * Handles both standard structure and preserveOrder structure
   * @deprecated Use extractFormattedTextFromParagraph for formatting-aware extraction
   */
  private extractRunsFromParagraph(para: any): Array<{ text: string; properties?: Record<string, unknown> }> {
    // With preserveOrder, para might be an array: [{ 'w:r': {...} }, { 'w:pPr': {...} }, { 'w:r': {...} }]
    // Or it might be an object: { 'w:r': [...], 'w:pPr': {...} }
    // CRITICAL: With preserveOrder, each run is a separate array item: { 'w:r': {...} }
    // We need to collect ALL runs from the array, not just the first one
    let runs: any = null;
    let runArray: any[] = [];
    
    if (Array.isArray(para)) {
      // Collect ALL runs from the array - each item might be a run
      for (const paraItem of para) {
        if (paraItem && typeof paraItem === 'object' && 'w:r' in paraItem) {
          const runItem = paraItem['w:r'];
          // Each runItem might be a single run object or an array of runs
          if (Array.isArray(runItem)) {
            runArray.push(...runItem);
          } else if (runItem) {
            runArray.push(runItem);
          }
        }
      }
    } else if (para && typeof para === 'object') {
      runs = para['w:r'];
      runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
    }
    
    if (runArray.length === 0) return [];
    
    const result: Array<{ text: string; properties?: Record<string, unknown> }> = [];
    
    for (const run of runArray) {
      const textNode = run['w:t'];
      if (!textNode) continue;
      
      let text = '';
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
        text = typeof textNode['#text'] === 'string' ? textNode['#text'] : '';
      }
      
      // CRITICAL: Don't trim individual runs - preserve spaces that Word includes in text nodes
      // Word splits text across runs and includes spaces in the text nodes themselves
      // We only trim the final paragraph text, not individual runs
      if (!text) continue;
      
      result.push({
        text: text,  // Store text as-is, preserving spaces
        properties: run['w:rPr'] ?? {},
      });
    }
    
    return result;
  }

  /**
   * Detect formatting properties from Run Properties (w:rPr)
   * Returns an object with detected formatting flags
   */
  private detectRunFormatting(rPr: any): {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    subscript: boolean;
    superscript: boolean;
    formattingId: string; // Unique ID for this formatting combination
  } {
    if (!rPr || typeof rPr !== 'object') {
      return {
        bold: false,
        italic: false,
        underline: false,
        subscript: false,
        superscript: false,
        formattingId: '',
      };
    }

    // Check for bold (w:b)
    const bold = !!(
      rPr['w:b'] ||
      (typeof rPr['w:b'] === 'object' && rPr['w:b'] !== null) ||
      (Array.isArray(rPr['w:b']) && rPr['w:b'].length > 0)
    );

    // Check for italic (w:i)
    const italic = !!(
      rPr['w:i'] ||
      (typeof rPr['w:i'] === 'object' && rPr['w:i'] !== null) ||
      (Array.isArray(rPr['w:i']) && rPr['w:i'].length > 0)
    );

    // Check for underline (w:u)
    const underline = !!(
      rPr['w:u'] ||
      (typeof rPr['w:u'] === 'object' && rPr['w:u'] !== null) ||
      (Array.isArray(rPr['w:u']) && rPr['w:u'].length > 0)
    );

    // Check for vertical alignment (subscript/superscript)
    // w:vertAlign with val="subscript" or val="superscript"
    let subscript = false;
    let superscript = false;
    const vertAlign = rPr['w:vertAlign'];
    if (vertAlign) {
      const val = typeof vertAlign === 'string'
        ? vertAlign
        : (vertAlign['@_w:val'] || vertAlign['w:val'] || '');
      if (typeof val === 'string') {
        const valLower = val.toLowerCase();
        subscript = valLower === 'subscript' || valLower === 'sub';
        superscript = valLower === 'superscript' || valLower === 'super';
      }
    }

    // Generate a unique formatting ID for this combination
    // Format: "b" for bold, "i" for italic, "u" for underline, "sub" for subscript, "sup" for superscript
    const formatParts: string[] = [];
    if (bold) formatParts.push('b');
    if (italic) formatParts.push('i');
    if (underline) formatParts.push('u');
    if (subscript) formatParts.push('sub');
    if (superscript) formatParts.push('sup');
    const formattingId = formatParts.length > 0 ? formatParts.join('') : '';

    return {
      bold,
      italic,
      underline,
      subscript,
      superscript,
      formattingId,
    };
  }

  /**
   * Check if a run contains only Word "noise" tags (proof errors, revision IDs, etc.)
   * These tags should be ignored during text extraction as they don't contain translatable content
   */
  private isNoiseRun(run: any): boolean {
    if (!run || typeof run !== 'object') {
      return false;
    }
    
    // Check if run has a text node - if it has text, it's not just noise
    const textNode = run['w:t'];
    if (textNode) {
      // Extract text to check if it's non-empty
      let hasText = false;
      if (typeof textNode === 'string' && textNode.trim().length > 0) {
        hasText = true;
      } else if (Array.isArray(textNode)) {
        hasText = textNode.some((t: any) => {
          let text: string;
          if (typeof t === 'string') {
            text = t;
          } else if (typeof t === 'object' && t !== null && typeof t['#text'] === 'string') {
            text = t['#text'];
          } else {
            text = '';
          }
          return typeof text === 'string' && text.trim().length > 0;
        });
      } else if (typeof textNode === 'object' && textNode !== null) {
        const text = typeof textNode['#text'] === 'string' ? textNode['#text'] : '';
        hasText = typeof text === 'string' && text.trim().length > 0;
      }
      if (hasText) {
        return false; // Has text content, not noise
      }
    }
    
    // Check for noise-only elements (proof errors, revision IDs, etc.)
    // If the run only contains these, it's noise
    const hasProofErr = !!(run['w:proofErr'] || run['w:gramStart'] || run['w:gramEnd']);
    const hasRsid = !!(run['w:rsid'] || run['w:rsidR'] || run['w:rsidRPr'] || run['w:rsidRDefault']);
    const hasLang = !!run['w:lang'];
    
    // Also check for other non-content elements
    const hasFldChar = !!run['w:fldChar'];
    const hasInstrText = !!run['w:instrText'];
    const hasNoBreakHyphen = !!run['w:noBreakHyphen'];
    const hasSoftHyphen = !!run['w:softHyphen'];
    
    // If it only has noise elements and no text, it's a noise run
    return (hasProofErr || hasRsid || hasLang || hasFldChar || hasInstrText || hasNoBreakHyphen || hasSoftHyphen) && !textNode;
  }

  /**
   * Check if a run contains noise tags (even if it also has text)
   * Used to skip processing noise tags within runs that have content
   */
  private hasNoiseTags(run: any): boolean {
    if (!run || typeof run !== 'object') {
      return false;
    }
    
    return !!(
      run['w:proofErr'] ||
      run['w:gramStart'] ||
      run['w:gramEnd'] ||
      run['w:rsid'] ||
      run['w:rsidR'] ||
      run['w:rsidRPr'] ||
      run['w:rsidRDefault'] ||
      run['w:lang'] ||
      run['w:fldChar'] ||
      run['w:instrText'] ||
      run['w:noBreakHyphen'] ||
      run['w:softHyphen']
    );
  }

  /**
   * Compare formatting between two runs to determine if they should be merged
   * Returns true if runs have identical formatting and can be merged
   */
  private hasSameFormatting(run1: any, run2: any): boolean {
    const rPr1 = run1['w:rPr'] ?? {};
    const rPr2 = run2['w:rPr'] ?? {};
    
    const formatting1 = this.detectRunFormatting(rPr1);
    const formatting2 = this.detectRunFormatting(rPr2);
    
    // Compare formatting IDs - if they match, formatting is identical
    return formatting1.formattingId === formatting2.formattingId;
  }

  /**
   * Extract formatted text from a paragraph with run-aware parsing
   * Returns text with formatting tags and location metadata for surgical replacement
   * 
   * Format tag format: <b id="1">text</b> for bold, <i id="2">text</i> for italic, etc.
   * This format is robust for LLMs and allows precise replacement during export
   * 
   * HARDENED: Now ignores Word noise tags (proof errors, revision IDs) and merges split runs
   */
  private extractFormattedTextFromParagraph(
    para: any,
    paragraphIndex: number
  ): {
    text: string;
    formattedRuns: Array<{
      text: string;
      formatting: {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        subscript: boolean;
        superscript: boolean;
        formattingId: string;
      };
      location: {
        paragraphIndex: number;
        runIndex: number;
        path: string; // Format: "p[0]/r[1]" for easy lookup
      };
      rawProperties: Record<string, unknown>;
    }>;
    metadata: {
      paragraphIndex: number;
      paragraphPath: string;
      runCount: number;
    };
  } {
    // With preserveOrder, para might be an array: [{ 'w:r': {...} }, { 'w:pPr': {...} }, { 'w:r': {...} }]
    // Or it might be an object: { 'w:r': [...], 'w:pPr': {...} }
    // CRITICAL: With preserveOrder, each run is a separate array item: { 'w:r': {...} }
    // We need to collect ALL runs from the array, not just the first one
    let runs: any = null;
    let runArray: any[] = [];
    
    if (Array.isArray(para)) {
      // Collect ALL runs from the array - each item might be a run
      for (const paraItem of para) {
        if (paraItem && typeof paraItem === 'object' && 'w:r' in paraItem) {
          const runItem = paraItem['w:r'];
          // Each runItem might be a single run object or an array of runs
          if (Array.isArray(runItem)) {
            runArray.push(...runItem);
          } else if (runItem) {
            runArray.push(runItem);
          }
        }
      }
    } else if (para && typeof para === 'object') {
      runs = para['w:r'];
      runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
    }
    
    // #region agent log
    if (paragraphIndex < 3) {
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1050',message:'extractFormattedTextFromParagraph: run extraction',data:{paragraphIndex,isArray:Array.isArray(para),runArrayLength:runArray.length,hasRuns:!!runs},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'O'})}).catch(()=>{});
    }
    // #endregion
    
    // HARDENED: Filter out noise runs (proof errors, revision IDs, etc.) and merge split runs
    // Step 1: Collect valid runs (skip noise-only runs)
    interface ProcessedRun {
      originalIndex: number;
      text: string;
      formatting: {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        subscript: boolean;
        superscript: boolean;
        formattingId: string;
      };
      rawProperties: Record<string, unknown>;
    }
    
    const processedRuns: ProcessedRun[] = [];
    
    for (let runIndex = 0; runIndex < runArray.length; runIndex++) {
      const run = runArray[runIndex];
      if (!run || typeof run !== 'object') continue;
      
      // HARDENED: Skip noise runs (contain only proof errors, revision IDs, etc.)
      if (this.isNoiseRun(run)) {
        continue; // Skip this run entirely
      }
      
      const textNode = run['w:t'];
      if (!textNode) continue;
      
      // Extract text from the run
      let text = '';
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
        text = typeof textNode['#text'] === 'string' ? textNode['#text'] : '';
      }
      
      // CRITICAL: Check if text exists, but don't trim - preserve spaces in text nodes
      // Word includes spaces in text nodes when needed (e.g., " FOR MANAGEMENT...")
      // Only skip completely empty text (no characters at all)
      if (!text || text.length === 0) continue;
      
      // Detect formatting from run properties
      const rPr = run['w:rPr'] ?? {};
      const formatting = this.detectRunFormatting(rPr);
      
      processedRuns.push({
        originalIndex: runIndex,
        text: text,  // Store text as-is, preserving spaces
        formatting,
        rawProperties: rPr,
      });
    }
    
    if (processedRuns.length === 0) {
      return {
        text: '',
        formattedRuns: [],
        metadata: {
          paragraphIndex,
          paragraphPath: `p[${paragraphIndex}]`,
          runCount: 0,
        },
      };
    }
    
    // HARDENED: Step 2 - Merge adjacent runs with the same formatting
    // This handles Word's text splitting (e.g., "LINE" + "S" becomes "LINES")
    const mergedRuns: ProcessedRun[] = [];
    let currentRun: ProcessedRun | null = null;
    
    for (const run of processedRuns) {
      if (currentRun === null) {
        // First run - start a new group
        currentRun = { ...run };
      } else if (this.hasSameFormatting(
        { 'w:rPr': currentRun.rawProperties },
        { 'w:rPr': run.rawProperties }
      )) {
        // Same formatting - merge text (Word split the word)
        currentRun.text += run.text;
      } else {
        // Different formatting - save current and start new
        mergedRuns.push(currentRun);
        currentRun = { ...run };
      }
    }
    
    // Don't forget the last run
    if (currentRun !== null) {
      mergedRuns.push(currentRun);
    }
    
    // Step 3: Build formatted output from merged runs
    const formattedRuns: Array<{
      text: string;
      formatting: {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        subscript: boolean;
        superscript: boolean;
        formattingId: string;
      };
      location: {
        paragraphIndex: number;
        runIndex: number;
        path: string;
      };
      rawProperties: Record<string, unknown>;
    }> = [];
    
    let formattedText = '';
    let formatTagCounter = 0;
    const formatTagMap = new Map<string, number>(); // Map formattingId -> tag counter
    
    for (let mergedIndex = 0; mergedIndex < mergedRuns.length; mergedIndex++) {
      const run = mergedRuns[mergedIndex];
      const text = run.text;
      
      // Generate location path using the original index of the first run in the merged group
      const locationPath = `p[${paragraphIndex}]/r[${run.originalIndex}]`;
      
      // Store formatted run information
      formattedRuns.push({
        text: text,  // Store text as-is, preserving spaces
        formatting: run.formatting,
        location: {
          paragraphIndex,
          runIndex: run.originalIndex, // Use original index for location tracking
          path: locationPath,
        },
        rawProperties: run.rawProperties,
      });
      
      // Build formatted text with tags
      // Format: <b id="1">text</b> for bold, <i id="2">text</i> for italic, etc.
      // Multiple formats can be nested: <b id="1"><i id="2">text</i></b>
      let taggedText = text;  // Use text as-is, preserving spaces
      
      if (run.formatting.formattingId) {
        // Get or create tag ID for this formatting combination
        if (!formatTagMap.has(run.formatting.formattingId)) {
          formatTagCounter++;
          formatTagMap.set(run.formatting.formattingId, formatTagCounter);
        }
        const tagId = formatTagMap.get(run.formatting.formattingId)!;
        
        // Apply tags in order: subscript/superscript first (outermost), then underline, italic, bold
        // This ensures proper nesting
        if (run.formatting.subscript) {
          taggedText = `<sub id="${tagId}">${taggedText}</sub>`;
        } else if (run.formatting.superscript) {
          taggedText = `<sup id="${tagId}">${taggedText}</sup>`;
        }
        
        if (run.formatting.underline) {
          taggedText = `<u id="${tagId}">${taggedText}</u>`;
        }
        
        if (run.formatting.italic) {
          taggedText = `<i id="${tagId}">${taggedText}</i>`;
        }
        
        if (run.formatting.bold) {
          taggedText = `<b id="${tagId}">${taggedText}</b>`;
        }
      }
      
      // Append to formatted text
      // CRITICAL: Don't add spaces between runs - Word splits text across runs for formatting
      // (e.g., "P" + "LAN" = "PLAN"). Spaces are already included in the text nodes when needed.
      // Only add space if the taggedText itself starts with a space (preserve existing spacing)
      formattedText += taggedText;
    }
    
    // CRITICAL: Normalize text for consistent empty detection (replace non-breaking spaces, trim)
    // This ensures parse() and export() agree on what constitutes empty text
    const finalText = this.normalizeTextForComparison(formattedText);
    // #region agent log
    if (paragraphIndex < 3) {
      const allCapsRuns = formattedRuns.filter(r => r.text === r.text.toUpperCase() && r.text.length > 1 && /^[A-Z\s]+$/.test(r.text));
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1120',message:'extractFormattedTextFromParagraph: final result',data:{paragraphIndex,finalText,finalTextLength:finalText.length,formattedTextLength:formattedText.length,runCount:formattedRuns.length,allCapsRunsCount:allCapsRuns.length,allCapsRuns:allCapsRuns.map(r=>({text:r.text,length:r.text.length,runIndex:r.location.runIndex}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H'})}).catch(()=>{});
    }
    // #endregion
    return {
      text: finalText,
      formattedRuns,
      metadata: {
        paragraphIndex,
        paragraphPath: `p[${paragraphIndex}]`,
        runCount: formattedRuns.length,
      },
    };
  }

  /**
   * Extract cells from a table XML structure
   */
  private extractCellsFromTable(table: any): Array<{ text: string; runs: Array<{ text: string; properties?: Record<string, unknown> }>; properties?: Record<string, unknown> }> {
    const rows = table['w:tr'] ?? [];
    const rowArray = Array.isArray(rows) ? rows : rows ? [rows] : [];
    
    const cells: Array<{ text: string; runs: Array<{ text: string; properties?: Record<string, unknown> }>; properties?: Record<string, unknown> }> = [];
    
    for (const row of rowArray) {
      if (!row) continue;
      
      const rowCells = row['w:tc'] ?? [];
      const cellArray = Array.isArray(rowCells) ? rowCells : rowCells ? [rowCells] : [];
      
      for (const cell of cellArray) {
        if (!cell) continue;
        
        // Extract paragraphs from cell
        const cellParagraphs = cell['w:p'] ?? [];
        const cellParaArray = Array.isArray(cellParagraphs) ? cellParagraphs : cellParagraphs ? [cellParagraphs] : [];
        
        // Combine text from all paragraphs in the cell
        const cellRuns: Array<{ text: string; properties?: Record<string, unknown> }> = [];
        for (const cellPara of cellParaArray) {
          if (!cellPara) continue;
          const paraRuns = this.extractRunsFromParagraph(cellPara);
          cellRuns.push(...paraRuns);
        }
        
        if (cellRuns.length > 0) {
          const cellText = cellRuns.map(r => r.text).join(' ').trim();
          if (cellText) {
            cells.push({
              text: cellText,
              runs: cellRuns,
              properties: cell['w:tcPr'] ?? {},
            });
          }
        }
      }
    }
    
    return cells;
  }

  /**
   * Split text into sentences using common sentence delimiters
   */
  private splitIntoSentences(text: string): string[] {
    // #region agent log
    logger.debug({ 
      textLength: text.length, 
      textPreview: text.substring(0, 100) 
    }, 'splitIntoSentences: entry');
    // #endregion
    // Common sentence delimiters: . ! ? followed by space or end of string
    // Also handle cases like "Dr. Smith" or "U.S.A." (abbreviations)
    const sentenceRegex = /([.!?]+)\s+/g;
    const sentences: string[] = [];
    let lastIndex = 0;
    let match;

    while ((match = sentenceRegex.exec(text)) !== null) {
      const sentence = text.substring(lastIndex, match.index + match[1].length).trim();
      if (sentence) {
        sentences.push(sentence);
      }
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    const remaining = text.substring(lastIndex).trim();
    if (remaining) {
      sentences.push(remaining);
    }

    // If no sentences found (no delimiters), return the whole text as one sentence
    const result = sentences.length > 0 ? sentences : [text];
    
    // #region agent log
    logger.debug({ sentencesCount: result.length }, 'splitIntoSentences: exit');
    // #endregion
    
    return result;
  }

  /**
   * Apply sentence segmentation to segments if needed
   */
  private applySegmentation(
    segments: Array<{ index: number; sourceText: string; type: 'paragraph' | 'table-cell'; metadata?: Record<string, unknown> }>,
    segmentationMode: 'paragraphs' | 'sentences' = 'paragraphs'
  ): Array<{ index: number; sourceText: string; type: 'paragraph' | 'table-cell'; metadata?: Record<string, unknown> }> {
    // #region agent log
    logger.debug({ 
      segmentsCount: segments.length, 
      segmentationMode,
      tableCellSegments: segments.filter(s => s.type === 'table-cell').length,
      paragraphSegments: segments.filter(s => s.type === 'paragraph').length
    }, 'applySegmentation: entry');
    // #endregion
    
    if (segmentationMode === 'paragraphs') {
      return segments;
    }

    // Split paragraphs into sentences, but keep table cells as-is
    // CRITICAL: TOC paragraphs should NEVER reach this method - they are filtered out during parse
    const sentenceSegments: Array<{ index: number; sourceText: string; type: 'paragraph' | 'table-cell'; metadata?: Record<string, unknown> }> = [];
    let newIndex = 0;
    let skippedTOCCount = 0;

    for (const segment of segments) {
      // Safety check: If somehow a TOC paragraph made it here, skip it
      // Check for TOC patterns in the text
      const text = segment.sourceText.trim();
      // Use same patterns as isTableOfContentsParagraph
      const tocPattern1 = /^\d+\.\s+.+\.{3,}\s+\d+$/; // "1. Title ......... 5"
      const tocPattern2 = /^.+\.{2,}\s+\d+$/; // "Title ................ 5"
      const tocPattern3 = /^.+\.{2,}$/; // "Title ........" (dots at end)
      const tocPattern4 = /^\d+\.\s+.{5,100}\s+\d{1,3}$/; // "1. OBJECTIVES AND SCOPE 1" (NO dots, 5-100 chars, 1-3 digit page)
      const tocPattern5 = /^\d+\.\s+.{1,50}\s+\d{1,3}$/; // "1. Title 5" (short format, 1-50 chars, 1-3 digit page)
      const looksLikeTOC = tocPattern1.test(text) || tocPattern2.test(text) || tocPattern3.test(text) || tocPattern4.test(text) || tocPattern5.test(text);
      
      if (looksLikeTOC && segment.type === 'paragraph') {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1425',message:'applySegmentation: WARNING - TOC-like segment detected, skipping',data:{segmentIndex:segment.index,textPreview:text.substring(0,50),type:segment.type,willSkip:true},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H'})}).catch(()=>{});
        // #endregion
        skippedTOCCount++;
        continue; // Skip TOC - should not have reached here
      }
      
      if (segment.type === 'table-cell') {
        // Keep table cells as-is
        sentenceSegments.push({
          ...segment,
          index: newIndex++,
        });
      } else {
        // Split paragraphs into sentences
        const sentences = this.splitIntoSentences(segment.sourceText);
        // CRITICAL: Preserve documentParagraphIndex from original segment metadata
        // This allows export to correctly group sentence segments back to their original paragraph
        const documentParagraphIndex = (segment.metadata as any)?.documentParagraphIndex ?? 
                                       (segment.metadata as any)?.originalParagraphIndex ?? 
                                       segment.index;
        for (const sentence of sentences) {
          if (sentence.trim()) {
            sentenceSegments.push({
              index: newIndex++,
              sourceText: sentence.trim(),
              type: 'paragraph',
              metadata: {
                ...segment.metadata,
                documentParagraphIndex: documentParagraphIndex, // Preserve document paragraph index
                originalParagraphIndex: segment.index, // Also keep original segment index for backward compatibility
                isSentence: true,
              },
            });
          }
        }
      }
    }
    
    // #region agent log
    if (skippedTOCCount > 0) {
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1450',message:'applySegmentation: TOC segments were filtered out',data:{skippedTOCCount,totalSegments:segments.length,outputSegments:sentenceSegments.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H'})}).catch(()=>{});
    }
    // #endregion

    // #region agent log
    logger.debug({ 
      sentenceSegmentsCount: sentenceSegments.length 
    }, 'applySegmentation: exit');
    // #endregion
    
    return sentenceSegments;
  }

  /**
   * Unified traversal method for extracting segments from document structure
   * CRITICAL: Uses the same traversal logic as export() to ensure 100% synchronization
   * Uses xmldom DOMParser (same as export) instead of fast-xml-parser
   */
  private traverseDocumentForExtraction(
    bodyElement: Element,
    context: {
      segments: DocxParagraph[];
      segmentIndex: { value: number };
      elementIndex: { value: number };
    }
  ): void {
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    
    // Iterate childNodes one by one - EXACT same logic as export
    for (let i = 0; i < bodyElement.childNodes.length; i++) {
      const node = bodyElement.childNodes[i];
      
      // Only process ELEMENT_NODE types
      if (node.nodeType !== 1) continue; // Skip text nodes, comments, etc.
      
      const element = node as Element;
      const localName = element.localName || element.nodeName.split(':').pop() || '';
      
      // CRITICAL: Increment elementIndex for ALL elements (matches export logic)
      context.elementIndex.value++;
      
      // Switch statement for different node types - EXACT same as export
      switch (localName) {
        case 'p': {
          // Handle paragraph - use DOM extraction (same as export)
          const paraText = this.extractTextFromParagraphDOM(element);
          
          // Skip TOC paragraphs
          const isTOC = this.isTableOfContentsParagraphDOM(element, context.elementIndex.value);
          if (isTOC) {
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1620',message:'[PARSE] Skipped para',data:{parseElementIndex:context.elementIndex.value,type:'paragraph',text:paraText?.substring(0,200)||'',textLength:paraText?.length||0,reason:'table_of_contents',isTOC:true,skipped:true},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'PARSE_SKIP'})}).catch(()=>{});
            // #endregion
            break; // Skip TOC
          }
          
          // CRITICAL: Use same normalization and empty check as export
          if (paraText && paraText.length > 0) {
            // Extract formatted text for metadata (needed for export reconstruction)
            // But use DOM-based extraction for consistency
            const formattedResult = this.extractFormattedTextFromParagraphDOM(element, context.elementIndex.value);
            
            const segmentIndexBefore = context.segmentIndex.value;
            context.segments.push({
              index: context.segmentIndex.value++,
              runs: formattedResult.formattedRuns.map(run => ({
                text: run.text,
                properties: run.rawProperties,
              })),
              properties: {
                // Store formatted text with tags for AI translation
                formattedText: formattedResult.text,
                // Store location metadata for surgical replacement
                location: formattedResult.metadata,
                formattedRuns: formattedResult.formattedRuns.map(run => ({
                  text: run.text,
                  formatting: run.formatting,
                  location: run.location,
                })),
                // CRITICAL: Store document paragraph index for sentence segmentation grouping during export
                documentParagraphIndex: context.elementIndex.value,
              },
            });
            
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1654',message:'[PARSE] Seg created',data:{parseElementIndex:context.elementIndex.value,segmentIndex:segmentIndexBefore,type:'paragraph',text:paraText.substring(0,200),textLength:paraText.length,skipped:false},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'PARSE_SEG'})}).catch(()=>{});
            // #endregion
          } else {
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1694',message:'[PARSE] Skipped para',data:{parseElementIndex:context.elementIndex.value,type:'paragraph',text:paraText||'',textLength:paraText?.length||0,reason:'empty_text',skipped:true},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'PARSE_SKIP'})}).catch(()=>{});
            // #endregion
          }
          break;
        }
        case 'tbl': {
          // Handle table - recursively process rows and cells (same as export)
          this.traverseTableForExtraction(element, context);
          break;
        }
        case 'sdt': {
          // Handle content control - recurse into w:sdtContent (same as export)
          const sdtContent = Array.from(element.childNodes).find(
            (n) => n.nodeType === 1 && ((n as Element).localName || (n as Element).nodeName.split(':').pop()) === 'sdtContent'
          ) as Element | undefined;
          if (sdtContent) {
            this.traverseDocumentForExtraction(sdtContent, context);
          }
          break;
        }
        case 'sectPr':
        default:
          // Ignore sectPr and other elements (same as export)
          break;
      }
    }
  }

  /**
   * Traverse table for extraction - recursively processes rows and cells
   * CRITICAL: Uses same traversal logic as export's processTableElementRecursively
   */
  private traverseTableForExtraction(
    tableElement: Element,
    context: {
      segments: DocxParagraph[];
      segmentIndex: { value: number };
      elementIndex: { value: number };
    }
  ): void {
    const elementIndex = context.elementIndex.value;
    
    // Iterate childNodes to find rows (w:tr) - NO getElementsByTagNameNS (same as export)
    for (let i = 0; i < tableElement.childNodes.length; i++) {
      const node = tableElement.childNodes[i];
      if (node.nodeType !== 1) continue;
      
      const rowElement = node as Element;
      const rowLocalName = rowElement.localName || rowElement.nodeName.split(':').pop() || '';
      
      if (rowLocalName !== 'tr') continue; // Skip non-row elements
      
      // Iterate row childNodes to find cells (w:tc) - same as export
      for (let j = 0; j < rowElement.childNodes.length; j++) {
        const cellNode = rowElement.childNodes[j];
        if (cellNode.nodeType !== 1) continue;
        
        const cellElement = cellNode as Element;
        const cellLocalName = cellElement.localName || cellElement.nodeName.split(':').pop() || '';
        
        if (cellLocalName !== 'tc') continue; // Skip non-cell elements
        
        // Extract cell text using DOM method (same as export)
        const cellText = this.extractTextFromTableCellDOM(cellElement);
        
        // CRITICAL: Use same normalization and empty check as export
        if (cellText && cellText.length > 0) {
          // Extract runs for metadata
          const runs = this.extractRunsFromTableCellDOM(cellElement);
          
          const segmentIndexBefore = context.segmentIndex.value;
          context.segments.push({
            index: context.segmentIndex.value++,
            runs: runs,
            properties: {
              isTableCell: true,
              tableIndex: context.segments.filter(s => s.properties?.isTableCell).length,
            },
          });
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1723',message:'[PARSE] Seg created',data:{parseElementIndex:elementIndex,segmentIndex:segmentIndexBefore,type:'table-cell',text:cellText.substring(0,200),textLength:cellText.length,skipped:false},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'PARSE_SEG'})}).catch(()=>{});
          // #endregion
        } else {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1745',message:'[PARSE] Skipped cell',data:{parseElementIndex:elementIndex,type:'table-cell',text:cellText||'',textLength:cellText?.length||0,reason:'empty_text',skipped:true},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'PARSE_SKIP'})}).catch(()=>{});
          // #endregion
        }
        
        // CRITICAL: Do NOT recursively process cell content - table cells are treated as single units
        // Cell text extraction already includes all paragraphs within the cell
        // Recursive traversal would cause elementIndex to increment for nested paragraphs,
        // which would desynchronize with export (which treats cells as single units)
      }
    }
  }

  /**
   * Extract runs from a table cell DOM element (for metadata)
   */
  private extractRunsFromTableCellDOM(cellElement: Element): Array<{ text: string; properties?: Record<string, unknown> }> {
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const paragraphs = cellElement.getElementsByTagNameNS(namespace, 'p');
    const runs: Array<{ text: string; properties?: Record<string, unknown> }> = [];
    
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      const paraRuns = para.getElementsByTagNameNS(namespace, 'r');
      for (let j = 0; j < paraRuns.length; j++) {
        const run = paraRuns[j];
        if (this.isNoiseRunDOM(run)) continue;
        const text = this.getRunTextFromDOMRun(run);
        if (text && text.length > 0) {
          runs.push({ text, properties: {} });
        }
      }
    }
    
    return runs;
  }

  /**
   * Extract formatted text from paragraph DOM element (for parse metadata)
   * Similar to extractFormattedTextFromParagraph but works with DOM
   */
  private extractFormattedTextFromParagraphDOM(paraElement: Element, paragraphIndex: number): {
    text: string;
    formattedRuns: Array<{
      text: string;
      formatting: {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        subscript: boolean;
        superscript: boolean;
        formattingId: string;
      };
      location: {
        paragraphIndex: number;
        runIndex: number;
        path: string;
      };
      rawProperties: Record<string, unknown>;
    }>;
    metadata: {
      paragraphIndex: number;
      paragraphPath: string;
      runCount: number;
    };
  } {
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const runs = paraElement.getElementsByTagNameNS(namespace, 'r');
    const formattedRuns: Array<{
      text: string;
      formatting: {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        subscript: boolean;
        superscript: boolean;
        formattingId: string;
      };
      location: {
        paragraphIndex: number;
        runIndex: number;
        path: string;
      };
      rawProperties: Record<string, unknown>;
    }> = [];
    
    let runIndex = 0;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (this.isNoiseRunDOM(run)) continue;
      
      const text = this.getRunTextFromDOMRun(run);
      if (text && text.length > 0) {
        const rPr = run.getElementsByTagNameNS(namespace, 'rPr')[0];
        const formatting = this.getRunFormattingFromDOM(rPr);
        
        formattedRuns.push({
          text,
          formatting,
          location: {
            paragraphIndex,
            runIndex,
            path: `p[${paragraphIndex}].r[${runIndex}]`,
          },
          rawProperties: rPr ? this.getRunPropertiesFromDOM(rPr) : {},
        });
        runIndex++;
      }
    }
    
    const formattedText = formattedRuns.map(r => r.text).join('');
    const finalText = this.normalizeTextForComparison(formattedText);
    
    return {
      text: finalText,
      formattedRuns,
      metadata: {
        paragraphIndex,
        paragraphPath: `p[${paragraphIndex}]`,
        runCount: formattedRuns.length,
      },
    };
  }

  /**
   * Get run formatting from DOM rPr element
   */
  private getRunFormattingFromDOM(rPr: Element | undefined): {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    subscript: boolean;
    superscript: boolean;
    formattingId: string;
  } {
    if (!rPr) {
      return { bold: false, italic: false, underline: false, subscript: false, superscript: false, formattingId: '' };
    }
    
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const bold = !!rPr.getElementsByTagNameNS(namespace, 'b')[0];
    const italic = !!rPr.getElementsByTagNameNS(namespace, 'i')[0];
    const underline = !!rPr.getElementsByTagNameNS(namespace, 'u')[0];
    const vertAlign = rPr.getElementsByTagNameNS(namespace, 'vertAlign')[0];
    const subscript = vertAlign && (vertAlign as Element).getAttribute('w:val') === 'subscript';
    const superscript = vertAlign && (vertAlign as Element).getAttribute('w:val') === 'superscript';
    
    const formattingId = [bold ? 'b' : '', italic ? 'i' : '', underline ? 'u' : '', subscript ? 'sub' : '', superscript ? 'sup' : ''].filter(Boolean).join('');
    
    return { bold, italic, underline, subscript, superscript, formattingId };
  }

  /**
   * Get run properties from DOM rPr element
   */
  private getRunPropertiesFromDOM(rPr: Element): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    
    if (rPr.getElementsByTagNameNS(namespace, 'b')[0]) props['w:b'] = {};
    if (rPr.getElementsByTagNameNS(namespace, 'i')[0]) props['w:i'] = {};
    if (rPr.getElementsByTagNameNS(namespace, 'u')[0]) props['w:u'] = {};
    
    return props;
  }

  async parse(buffer: Buffer, options?: { segmentationMode?: 'paragraphs' | 'sentences' }): Promise<ParsedFileResult> {
    // #region agent log
    logger.debug({ 
      hasOptions: !!options, 
      optionsSegmentationMode: options?.segmentationMode, 
      bufferLength: buffer?.length 
    }, 'DocxHandler.parse: entry');
    // #endregion
    
    const segmentationMode = options?.segmentationMode || 'paragraphs';
    
    // #region agent log
    logger.debug({ segmentationMode }, 'DocxHandler.parse: segmentationMode determined');
    // #endregion
    try {
      // CRITICAL: Use xmldom DOMParser (same as export) instead of fast-xml-parser
      // This ensures 100% synchronization between parse and export traversal
      
      const zip = await JSZip.loadAsync(buffer);
      const documentXml = await zip.file('word/document.xml')?.async('string');
      if (!documentXml) {
        throw new Error('Invalid DOCX: missing word/document.xml');
      }

      // Parse with DOMParser (same as export)
      const domParser = new DOMParser();
      const doc = domParser.parseFromString(documentXml, 'text/xml');
      
      if (!doc || !doc.documentElement) {
        throw new Error('Invalid DOCX: failed to parse document.xml');
      }
      
      // Find body element
      const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      const bodyElements = doc.getElementsByTagNameNS(namespace, 'body');
      if (!bodyElements || bodyElements.length === 0) {
        throw new Error('Invalid DOCX: missing w:body element');
      }
      
      const bodyElement = bodyElements[0] as Element;
      
      // CRITICAL: Use unified traversal method (same as export)
      // This ensures 100% synchronization between parse and export
      const segments: DocxParagraph[] = [];
      const context = {
        segments,
        segmentIndex: { value: 0 },
        elementIndex: { value: 0 },
      };
      
      this.traverseDocumentForExtraction(bodyElement, context);
      
      // #region agent log
      logger.debug({
        totalParseElements: context.elementIndex.value,
        totalSegments: segments.length,
        paragraphSegments: segments.filter(s => !s.properties?.isTableCell).length,
        tableCellSegments: segments.filter(s => s.properties?.isTableCell).length,
        segmentIndices: segments.slice(0, 20).map(s => s.index),
      }, 'Parse: completed element processing (unified traversal)');
      // #endregion
      
      logger.info(
        {
          totalSegments: segments.length,
          paragraphs: segments.filter(s => !s.properties?.isTableCell).length,
          tableCells: segments.filter(s => s.properties?.isTableCell).length,
        },
        'Extracted segments from DOCX using XML parsing'
      );
      
      if (segments.length === 0) {
        throw new Error('Document body is empty or could not be parsed');
      }
      
      // Convert to ParsedFileResult format
      const parsedSegments = segments.map((para) => {
        const isTableCell = para.properties?.isTableCell === true;
        const segmentType = (isTableCell ? 'table-cell' : 'paragraph') as 'paragraph' | 'table-cell';
        
        // Use formatted text if available (contains formatting tags), otherwise fall back to plain text
        const formattedText = para.properties?.formattedText as string | undefined;
        const sourceText = formattedText || para.runs.map((r) => r.text).join(' ');
        
        // #region agent log
        // Log first 20 segments to verify type is set correctly
        if (para.index < 20) {
          logger.debug({
            segmentIndex: para.index,
            isTableCell,
            hasIsTableCellProperty: para.properties?.isTableCell !== undefined,
            propertiesKeys: para.properties ? Object.keys(para.properties) : [],
            segmentType,
            hasFormattedText: !!formattedText,
            textPreview: sourceText.substring(0, 50),
            hasFormattingTags: formattedText ? formattedText.includes('<') : false,
          }, 'Parse: converting segment to ParsedSegment format');
        }
        // #endregion
        
        return {
          index: para.index,
          sourceText,
          type: segmentType,
          metadata: {
            runs: para.runs,
            paragraphProperties: para.properties ?? {},
            // Preserve location metadata for surgical replacement during export
            location: para.properties?.location,
            formattedRuns: para.properties?.formattedRuns,
            ...(isTableCell && para.properties && {
              tableIndex: para.properties.tableIndex,
            }),
          },
        };
      });
      
      // #region agent log
      logger.debug({ 
        parsedSegmentsCount: parsedSegments.length, 
        segmentationMode 
      }, 'DocxHandler.parse: before applySegmentation');
      // #endregion
      
      // Apply sentence segmentation if needed
      const finalSegments = this.applySegmentation(parsedSegments, segmentationMode);
      
      // #region agent log
      // CRITICAL: Verify NO TOC paragraphs made it into segments
      // Check first 50 segments for any TOC-like patterns
      const potentialTOCSegments = finalSegments.slice(0, 50).filter(seg => {
        const text = seg.sourceText.trim();
        // Use same patterns as isTableOfContentsParagraph
        const tocPattern1 = /^\d+\.\s+.+\.{3,}\s+\d+$/; // "1. Title ......... 5"
        const tocPattern2 = /^.+\.{2,}\s+\d+$/; // "Title ................ 5"
        const tocPattern3 = /^.+\.{2,}$/; // "Title ........" (dots at end)
        const tocPattern4 = /^\d+\.\s+.{5,100}\s+\d{1,3}$/; // "1. OBJECTIVES AND SCOPE 1" (NO dots, 5-100 chars, 1-3 digit page)
        const tocPattern5 = /^\d+\.\s+.{1,50}\s+\d{1,3}$/; // "1. Title 5" (short format, 1-50 chars, 1-3 digit page)
        return tocPattern1.test(text) || tocPattern2.test(text) || tocPattern3.test(text) || tocPattern4.test(text) || tocPattern5.test(text);
      });
      
      if (potentialTOCSegments.length > 0) {
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1772',message:'Parse: WARNING - potential TOC segments found in final segments',data:{potentialTOCCount:potentialTOCSegments.length,potentialTOCSegments:potentialTOCSegments.map(s=>({index:s.index,textPreview:s.sourceText.substring(0,50),type:s.type}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'G'})}).catch(()=>{});
      }
      
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1772',message:'Parse: after applySegmentation - final verification',data:{finalSegmentsCount:finalSegments.length,parsedSegmentsCount:parsedSegments.length,segmentationMode,potentialTOCSegmentsFound:potentialTOCSegments.length>0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'G'})}).catch(()=>{});
      
      logger.debug({ 
        finalSegmentsCount: finalSegments.length,
        potentialTOCSegmentsFound: potentialTOCSegments.length > 0
      }, 'DocxHandler.parse: after applySegmentation');
      // #endregion
      
      const totalWords = finalSegments.reduce((acc, seg) => acc + seg.sourceText.split(/\s+/).filter(Boolean).length, 0);
      
      return {
        segments: finalSegments,
        metadata: {
          type: 'docx',
          paragraphCount: finalSegments.filter(s => s.type === 'paragraph').length,
          tableCellCount: finalSegments.filter(s => s.type === 'table-cell').length,
          segmentationMode,
        },
        totalWords,
      };
    } catch (error) {
      // #region agent log
      logger.error({ 
        errorMessage: error instanceof Error ? error.message : String(error), 
        errorStack: error instanceof Error ? error.stack?.substring(0, 500) : undefined 
      }, 'DocxHandler.parse: error caught');
      // #endregion
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
    }
  ): void {
    const elementIndex = context.elementIndex.value;
    let segmentIndex = context.segmentIndex.value;
    
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
      const segmentMetadata = segment.metadata as any;
      
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
          // Mismatch detected - log warning and skip this node
          logger.warn({
            message: '[Mismatch] DOM text does not match segment text',
            elementIndex,
            segmentIndex,
            domText: paraText.substring(0, 200),
            segmentText: segmentText.substring(0, 200),
            plainSegmentText: plainSegmentText.substring(0, 200),
            normalizedDomText: normalizedDomText.substring(0, 200),
            normalizedSegmentText: normalizedSegmentText.substring(0, 200),
          });
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2847',message:'[Mismatch] DOM: "..." vs Segment: "..."',data:{elementIndex,segmentIndex,domText:paraText.substring(0,200),segmentText:segmentText.substring(0,200),plainSegmentText:plainSegmentText.substring(0,200),normalizedDomText:normalizedDomText.substring(0,200),normalizedSegmentText:normalizedSegmentText.substring(0,200),skipped:true},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'MISMATCH'})}).catch(()=>{});
          // #endregion
          return; // Skip this node - don't increment segmentIndex, continue traversal to find correct match
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
      }
      // If no metadata found, fall back to single segment (simplified for now)
    }
    
    // Apply translation
    if (translatedText !== undefined && translatedText !== null && translatedText.trim().length > 0) {
      // #region agent log
      // TRAVERSAL TRACE: Log every paragraph translation injection
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2613',message:'[EXPORT] Seg injection',data:{elementIndex,segmentIndex,type:'paragraph',text:paraText.substring(0,200),textLength:paraText.length,translatedText:translatedText.substring(0,200),translatedLength:translatedText.length,skipped:false},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'EXPORT_SEG'})}).catch(()=>{});
      // #endregion
      
      // Segment already retrieved above for verification, reuse it
      const segmentMetadata = segment?.metadata as any;
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
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2627',message:'[EXPORT] Seg no translation',data:{elementIndex,segmentIndex,type:'paragraph',text:paraText.substring(0,200),textLength:paraText.length,reason:'no_translation',skipped:false},timestamp:Date.now(),sessionId:'debug-session',runId:'traversal-trace',hypothesisId:'EXPORT_NO_TRANS'})}).catch(()=>{});
      // #endregion
    }
    
    // Increment segmentIndex
    context.segmentIndex.value = segmentIndex + segmentsToSkip + 1;
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
        context.segmentIndex.value++;
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

    // Parse XML using DOM parser (reliable for modifications)
    const domParser = new DOMParser();
    const doc = domParser.parseFromString(documentXml, 'text/xml');
    
    // Check for parsing errors
    const parserError = doc.getElementsByTagName('parsererror');
    if (parserError.length > 0) {
      throw new Error('Failed to parse DOCX XML: ' + parserError[0].textContent);
    }

    // Find the document element
    const documentElement = doc.documentElement;
    if (!documentElement || documentElement.nodeName !== 'w:document') {
      throw new Error('Invalid DOCX: missing or invalid w:document element');
    }

    // Find the body element
    const bodyElements = documentElement.getElementsByTagNameNS(
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'body'
    );
    if (bodyElements.length === 0) {
      throw new Error('Invalid DOCX: missing w:body element');
    }
    const bodyElement = bodyElements[0];

    // Create segment map for quick lookup
    // Also create a map of segment types to know which segments are table cells
    const segmentMap = new Map(options.segments.map((seg) => [seg.index, seg.targetText]));
    const segmentTypeMap = new Map(options.segments.map((seg) => [seg.index, seg.segmentType || 'paragraph']));
    
    // CRITICAL: Create a map of documentParagraphIndex -> segment indices for sentence segmentation grouping
    // This allows us to correctly group sentence segments back to their original paragraphs
    const paragraphToSegmentsMap = new Map<number, number[]>();
    for (const seg of options.segments) {
      const docParaIndex = (seg.metadata as any)?.documentParagraphIndex;
      if (docParaIndex !== undefined && docParaIndex !== null) {
        if (!paragraphToSegmentsMap.has(docParaIndex)) {
          paragraphToSegmentsMap.set(docParaIndex, []);
        }
        paragraphToSegmentsMap.get(docParaIndex)!.push(seg.index);
      }
    }
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2298',message:'Export: paragraphToSegmentsMap built',data:{totalSegments:options.segments.length,segmentsWithDocumentParagraphIndex:Array.from(paragraphToSegmentsMap.keys()).length,paragraphToSegmentsMapSize:paragraphToSegmentsMap.size,firstFewParagraphMappings:Array.from(paragraphToSegmentsMap.entries()).slice(0,5).map(([paraIdx,segIndices])=>({paragraphIndex:paraIdx,segmentIndices:segIndices.slice(0,10),segmentCount:segIndices.length})),sampleSegmentMetadata:options.segments.slice(0,5).map((seg,idx)=>({segmentIndex:seg.index,hasMetadata:!!seg.metadata,documentParagraphIndex:(seg.metadata as any)?.documentParagraphIndex,originalParagraphIndex:(seg.metadata as any)?.originalParagraphIndex,isSentence:(seg.metadata as any)?.isSentence,metadataKeys:seg.metadata?Object.keys(seg.metadata):[]}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'M'})}).catch(()=>{});
    // #endregion
    
    // #region agent log
    logger.debug({ 
      totalSegments: options.segments.length, 
      segmentMapSize: segmentMap.size, 
      segmentIndices: Array.from(segmentMap.keys()).slice(0, 10), 
      firstFewTranslations: Array.from(segmentMap.entries()).slice(0, 3).map(([idx, text]) => ({ idx, text: text.substring(0, 30), textLength: text.length })) 
    }, 'Export: DOM-based export started');
    // #endregion

    logger.debug({ 
      totalSegments: options.segments.length,
      segmentIndices: Array.from(segmentMap.keys()).slice(0, 10),
      firstFewTranslations: Array.from(segmentMap.entries()).slice(0, 3).map(([idx, text]) => ({ idx, text: text.substring(0, 30) }))
    }, 'Starting DOM-based export with translations');

    // Process elements in document order (same as parse method)
    // CRITICAL: segmentIndex must match the order of segments as they were created during parse
    // If segmentation was by sentences, multiple segments map to one paragraph
    let segmentIndex = 0;
    let processedParagraphs = 0;
    let processedTables = 0;
    let skippedNoText = 0;
    let elementIndex = 0; // Track position in document - MUST match parseElementIndex from parse()
    
    // CRITICAL ALIGNMENT REQUIREMENTS:
    // 1. elementIndex MUST increment for every element in bodyChildren (paragraph, table, other)
    //    This must match parseElementIndex from parse() method
    // 2. Both methods must skip the same elements:
    //    - TOC paragraphs (detected by isTableOfContentsParagraphDOM)
    //    - Empty paragraphs (detected by extractTextFromParagraphDOM().trim() === '')
    //    - Empty table cells (detected by extractTextFromTableCellDOM().trim() === '')
    // 3. Text extraction must be consistent:
    //    - extractTextFromParagraphDOM() now uses the same logic as extractTextFromParagraph()
    //    - Both filter noise runs using isNoiseRunDOM() / isNoiseRun()
    //    - Both extract text using getRunTextFromDOMRun() / getRunText() equivalents
    // 4. Traversal order must match:
    //    - Parse: Iterates bodyChildren array from object-based parsing
    //    - Export: Iterates bodyChildren array from DOM childNodes (filtered to ELEMENT_NODE only)
    //    - Both should produce the same order if XML is well-formed

    // Check if document was likely segmented by sentences
    const likelySentenceSegmented = options.metadata?.likelySentenceSegmented === true;
    
    // Get all child nodes of body (paragraphs, tables, etc.)
    // CRITICAL: Order must match the order during parse
    // During parse, we process elements in document order, so we must do the same here
    // Filter to ELEMENT_NODE only to exclude text nodes, comments, etc.
    const bodyChildren = Array.from(bodyElement.childNodes).filter(
      (node) => node.nodeType === 1 // ELEMENT_NODE
    ) as Element[];
    
    // #region agent log
    logger.debug({ 
      likelySentenceSegmented,
      totalSegments: segmentMap.size,
      totalBodyElements: bodyChildren.length
    }, 'Export: starting element processing');
    // #endregion
    
    // #region agent log
    const totalBodyElements = bodyChildren.length;
    const paragraphElements = bodyChildren.filter(el => {
      const localName = el.localName || el.nodeName.split(':').pop();
      return localName === 'p';
    }).length;
    const tableElements = bodyChildren.filter(el => {
      const localName = el.localName || el.nodeName.split(':').pop();
      return localName === 'tbl';
    }).length;
    
    // Log the order of first few elements to verify it matches parse order
    const firstFewElements = bodyChildren.slice(0, 20).map((el, idx) => {
      const localName = el.localName || el.nodeName.split(':').pop();
      const text = localName === 'p' 
        ? this.extractTextFromParagraphDOM(el)?.substring(0, 30) || ''
        : localName === 'tbl' 
          ? '[TABLE]'
          : localName || 'unknown';
      const hasText = localName === 'p' 
        ? (this.extractTextFromParagraphDOM(el)?.trim().length || 0) > 0
        : localName === 'tbl'
          ? true // Tables always have structure
          : false;
      return { 
        index: idx, 
        type: localName, 
        textPreview: text,
        hasText,
        willBeProcessed: hasText || localName === 'tbl'
      };
    });
    
    logger.debug({ 
      totalBodyElements,
      paragraphElements,
      tableElements,
      segmentMapSize: segmentMap.size,
      expectedSegments: options.segments.length,
      firstFewElements,
      segmentIndices: Array.from(segmentMap.keys()).slice(0, 20)
    }, 'Export: body structure analyzed');
    // #endregion

    // CRITICAL: Use recursive traversal instead of flat loop to match parse() method exactly
    // This ensures nodes are visited in the exact same order as parse() method
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const context = {
      segmentIndex: { value: segmentIndex },
      elementIndex: { value: elementIndex },
      segmentMap,
      segmentTypeMap,
      paragraphToSegmentsMap,
      options,
      likelySentenceSegmented,
      processedParagraphs: { value: processedParagraphs },
      processedTables: { value: processedTables },
      namespace,
    };
    this.processContainerNodeRecursively(bodyElement, context);
    
    // Update counters from context objects
    segmentIndex = context.segmentIndex.value;
    elementIndex = context.elementIndex.value;
    processedParagraphs = context.processedParagraphs.value;
    processedTables = context.processedTables.value;

    /* OLD FLAT LOOP - REPLACED WITH RECURSIVE TRAVERSAL ABOVE
    for (const element of bodyChildren) {
      elementIndex++;
      const localName = element.localName || element.nodeName.split(':').pop();
      
      // #region agent log
      if (elementIndex <= 20 || elementIndex % 50 === 0) {
        const textPreview = localName === 'p' 
          ? this.extractTextFromParagraphDOM(element)?.substring(0, 30) || ''
          : localName === 'tbl'
            ? '[TABLE]'
            : '';
        logger.debug({ 
          elementIndex,
          totalElements: bodyChildren.length,
          localName,
          currentSegmentIndex: segmentIndex,
          segmentMapSize: segmentMap.size,
          textPreview,
          hasSegmentForIndex: segmentMap.has(segmentIndex)
        }, 'Export: processing element');
      }
      // #endregion
      
      // Process paragraphs
      if (localName === 'p') {
        // Skip table of contents paragraphs - they are auto-generated and shouldn't be translated
        const isTOC = this.isTableOfContentsParagraphDOM(element, elementIndex);
        if (isTOC) {
          // #region agent log
          const paraText = this.extractTextFromParagraphDOM(element);
          // Check field structure before preserving
          const runsBefore = element.getElementsByTagNameNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'r'
          );
          const fldCharsBefore = Array.from(runsBefore).flatMap(run => 
            Array.from(run.getElementsByTagNameNS(
              'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
              'fldChar'
            ))
          );
          const instrTextsBefore = Array.from(runsBefore).flatMap(run => 
            Array.from(run.getElementsByTagNameNS(
              'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
              'instrText'
            ))
          );
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2330',message:'Export: preserving TOC paragraph',data:{elementIndex,segmentIndex,reason:'table_of_contents',skipped:true,paraTextPreview:paraText?.substring(0,50)||'',runCount:runsBefore.length,fldCharCount:fldCharsBefore.length,instrTextCount:instrTextsBefore.length,willPreserve:true},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          // Preserve TOC paragraphs - they weren't included in segments during parse, so leave them untouched
          continue;
        }
        
        // #region agent log
        // Log first few paragraphs to see their structure and compare with parse
        // Also log paragraphs around first table to debug index misalignment
        if (elementIndex <= 20 || (processedTables === 0 && elementIndex <= 30)) {
          const paraText = this.extractTextFromParagraphDOM(element);
          const pPr = element.getElementsByTagNameNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'pPr'
          );
          let styleId = 'none';
          if (pPr.length > 0) {
            const pStyle = pPr[0].getElementsByTagNameNS(
              'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
              'pStyle'
            );
            if (pStyle.length > 0) {
              styleId = pStyle[0].getAttribute('w:val') || 'none';
            }
          }
          const currentSegmentType = segmentTypeMap.get(segmentIndex) || 'paragraph';
          logger.debug({
            elementIndex,
            segmentIndex,
            hasText: !!(paraText && paraText.trim()),
            textLength: paraText?.length || 0,
            textPreview: paraText?.substring(0, 50) || '',
            styleId,
            isTOC,
            segmentType: currentSegmentType,
            hasSegmentForIndex: segmentMap.has(segmentIndex),
            segmentTextPreview: segmentMap.get(segmentIndex)?.substring(0, 50) || 'missing',
            willProcess: !!(paraText && paraText.trim() && !isTOC),
            nextFewSegmentTypes: Array.from({ length: 3 }, (_, i) => ({
              index: segmentIndex + i,
              type: segmentTypeMap.get(segmentIndex + i) || 'unknown',
              hasInMap: segmentMap.has(segmentIndex + i)
            }))
          }, 'Export: paragraph analysis');
        }
        // #endregion
        
        const paraText = this.extractTextFromParagraphDOM(element);
        
        // CRITICAL: Only process paragraphs that have text
        // This matches the parse logic which only creates segments for paragraphs with text
        // Empty paragraphs, headings without text, etc. should be skipped to maintain index alignment
        if (!paraText || !paraText.trim()) {
          // #region agent log
          logger.debug({ 
            elementIndex,
            segmentIndex,
            reason: 'empty_paragraph',
            skipped: true
          }, 'Export: skipping empty paragraph (no text)');
          // #endregion
          // Skip empty paragraphs - they weren't included in segments during parse
          continue;
        }
        
        // Check if we have a segment for this index
        // If segmentIndex is beyond the map size, we've run out of segments
        if (segmentIndex >= segmentMap.size) {
          // #region agent log
          logger.warn({ 
            elementIndex,
            segmentIndex,
            segmentMapSize: segmentMap.size,
            paraTextPreview: paraText.substring(0, 50),
            reason: 'segment_index_out_of_bounds'
          }, 'Export: segmentIndex exceeds segmentMap size - stopping paragraph processing');
          // #endregion
          // No more segments - stop processing paragraphs
          break;
        }
        
        // #region agent log
        // Check if paragraph has list properties (w:numPr) - CRITICAL for preserving list formatting
        const numPr = element.getElementsByTagNameNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'numPr'
        );
        const hasListProperties = numPr.length > 0;
        const pPr = element.getElementsByTagNameNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'pPr'
        );
        const hasParagraphProperties = pPr.length > 0;
        
        logger.debug({ 
          elementIndex,
          segmentIndex, 
          paraTextLength: paraText.length,
          hasText: true,
          hasListProperties,
          hasParagraphProperties,
          paraTextPreview: paraText.substring(0, 50),
          segmentMapHasIndex: segmentMap.has(segmentIndex),
          segmentMapValue: segmentMap.get(segmentIndex)?.substring(0, 30)
        }, 'Export: processing paragraph element with text');
        // #endregion
        // If likely sentence-segmented, collect all consecutive sentence segments for this paragraph
        // CRITICAL: Only collect sentence segments for paragraphs, NOT for table cells
        // Table cells should always use single segment (they are never sentence-segmented)
        let translatedText = segmentMap.get(segmentIndex);
        let segmentsToSkip = 0;
        
        // #region agent log
        logger.debug({
          elementIndex,
          segmentIndex,
          likelySentenceSegmented,
          hasTranslation: translatedText !== undefined && translatedText !== null,
          paraTextLength: paraText.length,
          segmentMapSize: segmentMap.size,
          isParagraph: true
        }, 'Export: determining translation for paragraph');
        // #endregion
        
        // CRITICAL: Only apply sentence segmentation logic to paragraphs, not table cells
        // Table cells are never segmented by sentences (see applySegmentation method)
        // ALWAYS use heuristic for paragraphs with text longer than 200 chars (likely sentence-segmented)
        // This ensures we collect all sentence segments even if metadata is missing
        // We're in the paragraph processing loop, so this is definitely a paragraph, not a table cell
        const shouldUseHeuristic = likelySentenceSegmented || paraText.length > 200;
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2562',message:'Export: checking if should use heuristic',data:{elementIndex,segmentIndex,likelySentenceSegmented,paraTextLength:paraText.length,shouldUseHeuristic},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'V'})}).catch(()=>{});
        // #endregion
        
        if (shouldUseHeuristic) {
          // CRITICAL FIX: Use documentParagraphIndex metadata to correctly group sentence segments
          // Look up all segments that belong to this paragraph (elementIndex) using paragraphToSegmentsMap
          const segmentIndicesForThisParagraph = paragraphToSegmentsMap.get(elementIndex);
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2583',message:'Export: checking paragraphToSegmentsMap for elementIndex',data:{elementIndex,segmentIndex,hasMapping:paragraphToSegmentsMap.has(elementIndex),segmentIndicesForThisParagraph:segmentIndicesForThisParagraph||null,segmentCount:segmentIndicesForThisParagraph?.length||0,paragraphToSegmentsMapSize:paragraphToSegmentsMap.size,sampleKeys:Array.from(paragraphToSegmentsMap.keys()).slice(0,10)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'N'})}).catch(()=>{});
          // #endregion
          
          if (segmentIndicesForThisParagraph && segmentIndicesForThisParagraph.length > 0) {
            // Collect all sentence segments for this paragraph using metadata
            const sentenceSegments: string[] = [];
            let maxSegmentIndex = segmentIndex;
            
            for (const segIdx of segmentIndicesForThisParagraph) {
              const segText = segmentMap.get(segIdx);
              const segType = segmentTypeMap.get(segIdx) || 'paragraph';
              
              // CRITICAL: Only collect paragraph segments, skip table cells
              if (segType === 'table-cell' || segType === 'cell') {
                continue;
              }
              
              if (segText !== undefined && segText !== null && segText.trim().length > 0) {
                sentenceSegments.push(segText.trim());
                // Track the highest segment index we've processed
                if (segIdx > maxSegmentIndex) {
                  maxSegmentIndex = segIdx;
                }
              }
            }
            
            // #region agent log
            logger.debug({
              elementIndex,
              segmentIndex,
              segmentsFound: segmentIndicesForThisParagraph.length,
              segmentsCollected: sentenceSegments.length,
              segmentIndices: segmentIndicesForThisParagraph.slice(0, 10),
              firstFewTexts: sentenceSegments.slice(0, 3).map(t => t.substring(0, 30))
            }, 'Export: grouped sentence segments by documentParagraphIndex');
            // #endregion
            
            if (sentenceSegments.length > 0) {
              // Join all sentence segments with spaces to reconstruct the paragraph
              translatedText = sentenceSegments.join(' ');
              
              // CRITICAL: Calculate segmentsToSkip based on how many segments we actually processed
              // Find the next segment index that's not in segmentIndicesForThisParagraph
              let nextSegmentIndex = segmentIndex;
              while (nextSegmentIndex < segmentMap.size) {
                if (!segmentIndicesForThisParagraph.includes(nextSegmentIndex)) {
                  break;
                }
                nextSegmentIndex++;
              }
              segmentsToSkip = nextSegmentIndex - segmentIndex - 1;
              
              // #region agent log
              logger.debug({ 
                elementIndex,
                segmentIndex,
                segmentsCollected: sentenceSegments.length,
                segmentsToSkip,
                reconstructedTextLength: translatedText.length,
                originalParaLength: paraText.length,
                nextSegmentIndex
              }, 'Export: sentence segments joined using metadata');
              // #endregion
            } else {
              // No segments found for this paragraph - fall back to single segment
              // #region agent log
              logger.warn({ 
                elementIndex,
                segmentIndex,
                reason: 'no_segments_found_in_metadata',
                segmentIndicesForThisParagraph: segmentIndicesForThisParagraph.length
              }, 'Export: no sentence segments found in metadata, using single segment');
              // #endregion
            }
          } else {
            // No metadata found - fall back to heuristic approach for backward compatibility
            // #region agent log
            logger.debug({ 
              elementIndex,
              segmentIndex,
              reason: 'no_metadata_found',
              hasMetadata: paragraphToSegmentsMap.has(elementIndex)
            }, 'Export: no documentParagraphIndex metadata found, using heuristic fallback');
            // #endregion
            
            // Fallback: Collect all consecutive segments that belong to this paragraph
            // CRITICAL: We must collect ALL segments for this paragraph, even if some don't have translations
            // The segmentMap contains targetText which is: targetFinal ?? targetMt ?? sourceText
            // So even untranslated segments will have their sourceText in the map
            const sentenceSegments: string[] = [];
            let nextIndex = segmentIndex;
          
          // Heuristic: collect segments until we've likely covered this paragraph
          // Stop if we've collected too many (safety limit) or if we run out
          // The original paragraph text length gives us a hint about how many sentences it had
          const originalParaLength = paraText.length;
          const avgSentenceLength = 80; // Lower estimate to allow more sentences per paragraph
          const estimatedSentences = Math.max(1, Math.ceil(originalParaLength / avgSentenceLength));
          const maxSentencesPerParagraph = Math.min(estimatedSentences + 5, 30); // Increased safety limit to allow more sentences
          
          // Collect all sentence segments for this paragraph
          // CRITICAL: The problem is that we need to know how many segments belong to THIS paragraph
          // The heuristic approach is unreliable. Instead, we should:
          // 1. Start collecting from segmentIndex
          // 2. Continue until we've collected enough text to match the original paragraph length
          // 3. OR until we hit a segment that clearly belongs to the next paragraph (much longer than expected)
          
          // Better approach: collect segments until the combined length matches the original paragraph
          // This is more reliable than using a fixed estimate
          let collectedTextLength = 0;
          const targetLength = originalParaLength; // We want to match the original paragraph length
          const tolerance = 0.5; // Allow 50% difference (translation can be longer/shorter)
          const minTargetLength = targetLength * 0.7; // Minimum we need to collect (70% of original) - increased from 60%
          const maxTargetLength = targetLength * (1 + tolerance); // Maximum we should collect (150% of original)
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2687',message:'Export: starting heuristic segment collection',data:{elementIndex,segmentIndex,originalParaLength,targetLength,minTargetLength,maxTargetLength,tolerance},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'O'})}).catch(()=>{});
          // #endregion
          
          while (nextIndex < segmentMap.size && sentenceSegments.length < maxSentencesPerParagraph) {
            const nextText = segmentMap.get(nextIndex);
            const nextSegmentType = segmentTypeMap.get(nextIndex) || 'paragraph';
            const isNextSegmentTableCell = nextSegmentType === 'table-cell' || nextSegmentType === 'cell';
            
            // CRITICAL: Stop collecting if we hit a table cell - it belongs to a table, not this paragraph
            if (isNextSegmentTableCell) {
              // #region agent log
              logger.debug({ 
                stoppingIndex: nextIndex,
                reason: 'hit_table_cell',
                collectedSegments: sentenceSegments.length,
                collectedTextLength,
                targetLength,
                nextSegmentType
              }, 'Export: stopping collection - hit table cell segment');
              // #endregion
              break;
            }
            
            // #region agent log
            if (sentenceSegments.length < 10 || nextIndex === segmentIndex || (elementIndex === 12 && sentenceSegments.length < 20)) {
              fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2725',message:'Export: collecting sentence segments (heuristic)',data:{elementIndex,collectingIndex:nextIndex,hasText:nextText!==undefined&&nextText!==null,textLength:nextText?.trim().length||0,textPreview:nextText?.substring(0,50),collectedSoFar:sentenceSegments.length,collectedTextLength,targetLength,remainingTarget:targetLength-collectedTextLength,nextSegmentType},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'Q'})}).catch(()=>{});
            }
            // #endregion
            
            if (nextText !== undefined && nextText !== null) {
              const textLength = nextText.trim().length;
              
              // Check if adding this segment would exceed the max target length significantly
              // If the next segment alone is much longer than the remaining target, it might belong to next paragraph
              const remainingTarget = targetLength - collectedTextLength;
              const wouldExceedMax = collectedTextLength + textLength > maxTargetLength;
              
              // CRITICAL: Only stop if ALL of these conditions are met:
              // 1. We've collected at least 80% of the target length (we've got most of the paragraph)
              // 2. AND the next segment would make us exceed the max target length (150% of original)
              // 3. AND the next segment is MUCH longer than what's remaining (more than 4x - be very lenient)
              // 4. AND we've already collected a substantial amount (at least 85% of target)
              // This ensures we only stop when we're very confident the next segment belongs to a different paragraph
              const hasCollectedSubstantialAmount = collectedTextLength >= targetLength * 0.85; // At least 85% collected
              const isNextSegmentWayTooLong = textLength > remainingTarget * 4; // More than 4x remaining - very unlikely to be part of this paragraph
              
              if (hasCollectedSubstantialAmount && wouldExceedMax && isNextSegmentWayTooLong) {
                // This segment is way too long and would exceed max significantly - likely belongs to next paragraph
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2727',message:'Export: stopping collection - segment way too long and would exceed max',data:{elementIndex,stoppingIndex:nextIndex,segmentLength:textLength,remainingTarget,collectedTextLength,wouldExceedMax,hasCollectedSubstantialAmount,isNextSegmentWayTooLong},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'R'})}).catch(()=>{});
                // #endregion
                break;
              }
              
              if (textLength > 0) {
                sentenceSegments.push(nextText.trim());
                collectedTextLength += textLength;
              } else {
                // Empty segment - account for it but don't add to text
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2745',message:'Export: found empty segment, accounting for index',data:{elementIndex,emptySegmentIndex:nextIndex},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'U'})}).catch(()=>{});
                // #endregion
              }
              nextIndex++;
              
              // CRITICAL: Continue collecting until we've reached very close to the target length
              // Stop only if we've exceeded max significantly (170%+ of original) OR if we're extremely close to target (98%+)
              // We want to collect as much as possible to match the original paragraph
              const isExtremelyCloseToTarget = collectedTextLength >= targetLength * 0.98; // 98% of target - extremely close
              const hasExceededMaxSignificantly = collectedTextLength > maxTargetLength * 1.2; // 120% of max (180% of original) - way too much
              
              if (isExtremelyCloseToTarget || hasExceededMaxSignificantly) {
                // We've collected enough to match the paragraph (98%+) OR way too much - stop
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2756',message:'Export: stopping collection - reached target or exceeded max',data:{elementIndex,stoppingIndex:nextIndex,collectedTextLength,targetLength,minTargetLength,maxTargetLength,isExtremelyCloseToTarget,hasExceededMaxSignificantly},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'S'})}).catch(()=>{});
                // #endregion
                break;
              }
            } else {
              // If segment is missing from map entirely, stop collecting
              // #region agent log
              fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2764',message:'Export: segment missing from map, stopping collection',data:{elementIndex,missingSegmentIndex:nextIndex,collectedSegments:sentenceSegments.length,collectedTextLength,minTargetLength},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'T'})}).catch(()=>{});
              // #endregion
              break;
            }
          }
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2815',message:'Export: heuristic segment collection completed',data:{elementIndex,segmentIndex,finalCollectedSegments:sentenceSegments.length,finalCollectedTextLength:collectedTextLength,targetLength,minTargetLength,maxTargetLength,reachedMinimum:collectedTextLength>=minTargetLength,exceededMaximum:collectedTextLength>maxTargetLength},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'P'})}).catch(()=>{});
          // #endregion
          
          // Join all collected segments with spaces to reconstruct the paragraph
          // CRITICAL: segmentsToSkip must account for ALL segments we processed, not just those with text
          const segmentsProcessed = nextIndex - segmentIndex;
          
          // #region agent log
          // Log segment types that were collected to detect if we accidentally collected table cells
          const collectedSegmentTypes = Array.from({ length: segmentsProcessed }, (_, i) => {
            const idx = segmentIndex + i;
            return {
              index: idx,
              type: segmentTypeMap.get(idx) || 'unknown',
              text: segmentMap.get(idx)?.substring(0, 30) || 'missing'
            };
          });
          logger.debug({
            elementIndex,
            segmentIndex,
            segmentsProcessed,
            segmentsCollected: sentenceSegments.length,
            collectedSegmentTypes: collectedSegmentTypes.slice(0, 10), // Log first 10
            hasTableCellInCollection: collectedSegmentTypes.some(s => s.type === 'table-cell' || s.type === 'cell'),
            originalParaLength,
            collectedTextLength
          }, 'Export: sentence segments collection summary');
          // #endregion
          
          if (sentenceSegments.length > 0) {
            translatedText = sentenceSegments.join(' ');
            // segmentsToSkip = number of additional segments beyond the first one
            segmentsToSkip = segmentsProcessed - 1;
            
            // #region agent log
            logger.debug({ 
              elementIndex,
              segmentIndex,
              segmentsProcessed,
              segmentsCollected: sentenceSegments.length,
              segmentsToSkip,
              reconstructedTextLength: translatedText.length,
              originalParaLength,
              collectedTextLength,
              lengthMatch: Math.abs(translatedText.length - originalParaLength) / originalParaLength,
              nextSegmentType: segmentTypeMap.get(nextIndex) || 'unknown',
              nextSegmentIndex: nextIndex
            }, 'Export: sentence segments joined');
            // #endregion
          } else {
            // No segments found in map - this shouldn't happen, but use original text
            translatedText = undefined;
            segmentsToSkip = segmentsProcessed > 0 ? segmentsProcessed - 1 : 0;
            
            // #region agent log
            logger.warn({ 
              elementIndex,
              segmentIndex,
              segmentsProcessed,
              segmentsToSkip,
              originalParaLength,
              nextSegmentType: segmentTypeMap.get(nextIndex) || 'unknown'
            }, 'Export: no sentence segments found for paragraph (heuristic fallback)');
            // #endregion
          }
        }
      } else {
        // Regular paragraph segmentation - use single segment
        translatedText = segmentMap.get(segmentIndex);
      }
        
        // #region agent log
        logger.debug({ 
          segmentIndex, 
          likelySentenceSegmented,
          hasTranslatedText: translatedText !== undefined && translatedText !== null,
          translatedTextLength: translatedText?.length,
          segmentsToSkip,
          originalParaLength: paraText.length,
          segmentMapSize: segmentMap.size
        }, 'Export: paragraph translation determined');
        // #endregion
        
        // #region agent log
        if (segmentIndex < 3) {
          // Check formatting before replacement
          const runsBefore = element.getElementsByTagNameNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'r'
          );
          const formattingInfo = Array.from(runsBefore).map((run, idx) => {
            const rPr = run.getElementsByTagNameNS(
              'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
              'rPr'
            );
            if (rPr.length > 0) {
              const rPrElement = rPr[0];
              const children = Array.from(rPrElement.childNodes)
                .filter(n => n.nodeType === 1) // ELEMENT_NODE
                .map(n => (n as Element).localName || (n as Element).nodeName);
              return { runIndex: idx, formatting: children };
            }
            return { runIndex: idx, formatting: [] };
          }).filter(f => f.formatting.length > 0);
          
          logger.debug({ 
            segmentIndex, 
            extractedText: paraText.substring(0, 50), 
            hasTranslation: translatedText !== undefined && translatedText !== null, 
            translation: translatedText?.substring(0, 50), 
            runsCount: runsBefore.length, 
            formattingInfo 
          }, 'Export: processing paragraph DOM');
        }
        // #endregion
        
        // Use translated text if available, otherwise keep original text (don't replace)
        // IMPORTANT: If translatedText is undefined/null/empty, we keep the original text
        // This ensures no text is lost even if segments weren't translated
        // CRITICAL: Use surgical reconstruction if location metadata is available
        // This preserves formatting by matching tags to runs
        if (translatedText !== undefined && translatedText !== null && translatedText.trim().length > 0) {
          // Check if we have location metadata for surgical reconstruction
          const segment = options.segments.find(s => s.index === segmentIndex);
          const segmentMetadata = segment?.metadata as any;
          const hasLocationMetadata = segmentMetadata?.location || segmentMetadata?.formattedRuns;
          
          if (hasLocationMetadata) {
            // Use surgical reconstruction with location metadata
            // #region agent log
            logger.debug({ 
              segmentIndex, 
              beforeReplace: {
                originalText: paraText.substring(0, 50),
                translation: translatedText.substring(0, 50),
                hasListProps: hasListProperties,
                translationLength: translatedText.length,
                originalLength: paraText.length,
                hasLocationMetadata: true,
                hasFormattedRuns: !!segmentMetadata?.formattedRuns,
                runCount: segmentMetadata?.location?.runCount || 0,
                hasFormattingTags: /<[biu]|<\/[biu]|<sub|<\/sub|<sup|<\/sup/.test(translatedText),
              }
            }, 'Export: using surgical reconstruction with location metadata');
            // #endregion
            
            this.reconstructParagraph(element, translatedText.trim(), segmentMetadata || {});
            processedParagraphs++;
          } else {
            // Fallback to existing method if no location metadata
            // #region agent log
            logger.debug({ 
              segmentIndex, 
              beforeReplace: {
                originalText: paraText.substring(0, 50),
                translation: translatedText.substring(0, 50),
                hasListProps: hasListProperties,
                translationLength: translatedText.length,
                originalLength: paraText.length,
                hasLocationMetadata: false,
              }
            }, 'Export: using fallback text replacement (no location metadata)');
            // #endregion
            
            // #region agent log
            const paraTextBefore = this.extractTextFromParagraphDOM(element);
            if (elementIndex === 1 || (paraTextBefore && (paraTextBefore.includes('PLAN FOR MANAGEMENT') || paraTextBefore.includes('500 kV OVERHEAD')))) {
              fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2988',message:'Export: calling replaceTextInParagraphDOM',data:{elementIndex,segmentIndex,paraTextBefore,translatedText,paraTextBeforeLength:paraTextBefore?.length,translatedTextLength:translatedText?.trim().length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'AA'})}).catch(()=>{});
            }
            // #endregion
            this.replaceTextInParagraphDOM(element, translatedText.trim());
            processedParagraphs++;
          }
          
          // #region agent log
          const afterText = this.extractTextFromParagraphDOM(element);
          if (elementIndex === 1 || (afterText && (afterText.includes('PLAN FOR MANAGEMENT') || afterText.includes('500 kV OVERHEAD')))) {
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:2993',message:'Export: after replaceTextInParagraphDOM',data:{elementIndex,segmentIndex,afterText,afterTextLength:afterText?.length,translatedTextLength:translatedText?.trim().length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'BB'})}).catch(()=>{});
          }
          const numPrAfter = element.getElementsByTagNameNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'numPr'
          );
          logger.debug({ 
            segmentIndex, 
            usedTranslation: true,
            textLength: translatedText.trim().length,
            originalLength: paraText.length,
            afterReplace: {
              extractedText: afterText.substring(0, 50),
              hasListPropsAfter: numPrAfter.length > 0,
              listPropsPreserved: hasListProperties === (numPrAfter.length > 0)
            }
          }, 'Export: paragraph updated with translation');
          // #endregion
        } else {
          // Keep original text if no translation available - don't replace, just skip
          // This preserves the original text in the document
          // #region agent log
          logger.debug({ 
            segmentIndex, 
            usedTranslation: false,
            originalTextLength: paraText.length,
            hasTranslation: translatedText !== undefined && translatedText !== null,
            translatedTextValue: translatedText,
            willKeepOriginal: true
          }, 'Export: paragraph kept original (no translation)');
          // #endregion
          // Don't increment processedParagraphs since we didn't modify it
        }
        
        // #region agent log
        if (segmentIndex < 3 && translatedText) {
          const verifyText = this.extractTextFromParagraphDOM(element);
          // Check formatting after replacement
          const runsAfter = element.getElementsByTagNameNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'r'
          );
          const formattingInfoAfter = Array.from(runsAfter).map((run, idx) => {
            const rPr = run.getElementsByTagNameNS(
              'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
              'rPr'
            );
            if (rPr.length > 0) {
              const rPrElement = rPr[0];
              const children = Array.from(rPrElement.childNodes)
                .filter(n => n.nodeType === 1) // ELEMENT_NODE
                .map(n => (n as Element).localName || (n as Element).nodeName);
              return { runIndex: idx, formatting: children };
            }
            return { runIndex: idx, formatting: [] };
          }).filter(f => f.formatting.length > 0);
          
          logger.debug({ 
            segmentIndex, 
            originalText: paraText.substring(0, 50), 
            translation: translatedText ? translatedText.substring(0, 50) : null, 
            verifiedText: verifyText.substring(0, 50), 
            matches: translatedText ? verifyText.includes(translatedText.trim().substring(0, 30)) : false, 
            runsCountAfter: runsAfter.length, 
            formattingInfoAfter 
          }, 'Export: paragraph DOM updated');
        }
        // #endregion
        // Increment segmentIndex, skipping merged segments if sentence-segmented
        // CRITICAL: segmentsToSkip is the number of ADDITIONAL segments we collected beyond the first one
        // So if we collected 3 segments (indices 0, 1, 2), segmentsToSkip = 2, and we increment by 3 total
        const previousSegmentIndex = segmentIndex;
        segmentIndex += segmentsToSkip + 1;
        
        // #region agent log
        logger.debug({ 
          elementIndex,
          previousSegmentIndex,
          segmentsToSkip,
          newSegmentIndex: segmentIndex,
          likelySentenceSegmented,
          paragraphProcessed: true,
          totalSegmentsRemaining: segmentMap.size - segmentIndex
        }, 'Export: segmentIndex incremented after paragraph');
        // #endregion
      } else if (localName === 'tbl') {
        // Process tables
        // CRITICAL: Table cells are NEVER segmented by sentences
        // Each table cell uses exactly ONE segment (see applySegmentation method)
        // #region agent log
        logger.debug({ 
          elementIndex,
          segmentIndex,
          tableIndex: processedTables,
          likelySentenceSegmented,
          segmentMapHasIndex: segmentMap.has(segmentIndex),
          segmentTypeAtIndex: segmentTypeMap.get(segmentIndex) || 'unknown',
          nextFewSegmentTypes: Array.from({ length: 5 }, (_, i) => ({
            index: segmentIndex + i,
            type: segmentTypeMap.get(segmentIndex + i) || 'unknown',
            hasInMap: segmentMap.has(segmentIndex + i)
          })),
          note: 'Table cells use single segments, never sentence-segmented'
        }, 'Export: processing table element');
        // #endregion
        processedTables++;
        const rows = element.getElementsByTagNameNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'tr'
        );
        
        // #region agent log
        logger.debug({ 
          tableFound: true, 
          rowCount: rows.length, 
          segmentIndex 
        }, 'Export: found table DOM');
        // #endregion
        
        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
          const row = rows[rowIdx];
          const cells = row.getElementsByTagNameNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'tc'
          );
          
          for (let cellIdx = 0; cellIdx < cells.length; cellIdx++) {
            const cell = cells[cellIdx];
            const cellText = this.extractTextFromTableCellDOM(cell);
            
            // CRITICAL: Only process cells that have text AND have a corresponding segment
            // This matches the parse logic which only creates segments for cells with text
            // extractTextFromTableCellDOM already normalizes (replaces \u00A0 and trims)
            if (!cellText || cellText.length === 0) {
              // #region agent log
              logger.debug({ 
                elementIndex,
                tableIndex: processedTables,
                rowIndex: rowIdx,
                cellIndex: cellIdx,
                segmentIndex,
                reason: 'empty_cell',
                skipped: true
              }, 'Export: skipping empty table cell (no text)');
              // #endregion
              // Skip empty cells - they weren't included in segments during parse
              continue;
            }
            
            // Check if we have a segment for this index
            if (segmentIndex >= segmentMap.size) {
              // #region agent log
              logger.warn({ 
                elementIndex,
                tableIndex: processedTables,
                rowIndex: rowIdx,
                cellIndex: cellIdx,
                segmentIndex,
                segmentMapSize: segmentMap.size,
                cellTextPreview: cellText.substring(0, 30),
                reason: 'segment_index_out_of_bounds'
              }, 'Export: segmentIndex exceeds segmentMap size - stopping table cell processing');
              // #endregion
              // No more segments - stop processing cells
              break;
            }
            
            // CRITICAL: Table cells always use single segment (never sentence-segmented)
            // Do NOT apply sentence segmentation logic here - just get the single segment
            // Verify that this segment is actually a table cell by checking segmentType
            const cellSegmentType = segmentTypeMap.get(segmentIndex) || 'paragraph';
            const isActuallyTableCell = cellSegmentType === 'table-cell' || cellSegmentType === 'cell';
            
            // #region agent log
            // Always log for first table to debug index misalignment
            if (processedTables === 1 && (rowIdx < 2 || cellIdx < 3)) {
              logger.debug({
                elementIndex,
                tableIndex: processedTables,
                rowIndex: rowIdx,
                cellIndex: cellIdx,
                segmentIndex,
                cellSegmentType,
                isActuallyTableCell,
                cellTextPreview: cellText.substring(0, 50),
                segmentTextPreview: segmentMap.get(segmentIndex)?.substring(0, 50) || 'missing',
                previousSegmentTypes: Array.from({ length: 3 }, (_, i) => ({
                  index: segmentIndex - 3 + i,
                  type: segmentTypeMap.get(segmentIndex - 3 + i) || 'unknown',
                  text: segmentMap.get(segmentIndex - 3 + i)?.substring(0, 30) || 'missing'
                })),
                nextSegmentTypes: Array.from({ length: 3 }, (_, i) => ({
                  index: segmentIndex + 1 + i,
                  type: segmentTypeMap.get(segmentIndex + 1 + i) || 'unknown',
                  text: segmentMap.get(segmentIndex + 1 + i)?.substring(0, 30) || 'missing'
                }))
              }, 'Export: first table cell detailed analysis');
            }
            // #endregion
            
            if (!isActuallyTableCell) {
              // #region agent log
              logger.warn({
                elementIndex,
                tableIndex: processedTables,
                rowIndex: rowIdx,
                cellIndex: cellIdx,
                segmentIndex,
                expectedType: 'table-cell',
                actualType: cellSegmentType,
                cellTextPreview: cellText.substring(0, 50),
                segmentTextPreview: segmentMap.get(segmentIndex)?.substring(0, 50) || 'missing',
                note: 'Segment type mismatch - table cell in DOM but segmentType is not table-cell'
              }, 'Export: segment type mismatch for table cell');
              // #endregion
            }
            
            const translatedText = segmentMap.get(segmentIndex);
            
            // #region agent log
            logger.debug({ 
              elementIndex,
              tableIndex: processedTables,
              rowIndex: rowIdx,
              cellIndex: cellIdx,
              segmentIndex, 
              cellText: cellText.substring(0, 30), 
              hasTranslation: translatedText !== undefined && translatedText !== null, 
              translation: translatedText?.substring(0, 30),
              segmentMapHasIndex: segmentMap.has(segmentIndex),
              segmentType: cellSegmentType,
              isTableCell: true,
              isActuallyTableCell,
              note: 'Table cells use single segments, never sentence-segmented'
            }, 'Export: processing table cell DOM');
            // #endregion
              
            if (translatedText !== undefined && translatedText !== null && translatedText.trim().length > 0) {
              this.replaceTextInTableCellDOM(cell, translatedText.trim());
              
              // #region agent log
              if (segmentIndex < 5) {
                const verifyText = this.extractTextFromTableCellDOM(cell);
                logger.debug({ 
                  segmentIndex, 
                  originalText: cellText.substring(0, 30), 
                  translation: translatedText.substring(0, 30), 
                  verifiedText: verifyText.substring(0, 30), 
                  matches: verifyText.includes(translatedText.trim().substring(0, 20)) 
                }, 'Export: table cell DOM updated');
              }
              // #endregion
            }
            // #region agent log
            logger.debug({ 
              elementIndex,
              tableIndex: processedTables,
              rowIndex: rowIdx,
              cellIndex: cellIdx,
              segmentIndexBefore: segmentIndex,
              segmentIndexAfter: segmentIndex + 1
            }, 'Export: table cell segmentIndex increment');
            // #endregion
              
            segmentIndex++;
          }
        }
      } else {
        // #region agent log
        // Other element types (sectPr, etc.) - skip but log
        logger.debug({ 
          elementIndex,
          localName,
          segmentIndex,
          elementType: 'other'
        }, 'Export: skipping non-paragraph/table element');
        // #endregion
      }
    }
    END OF OLD FLAT LOOP */

    // #region agent log
    const segmentsUsed = Array.from(segmentMap.keys()).filter(idx => {
      const text = segmentMap.get(idx);
      return text !== undefined && text !== null && text.trim().length > 0;
    }).length;
    const segmentsUnused = segmentMap.size - segmentsUsed;
    const segmentsProcessed = segmentIndex;
    // #endregion
    
    logger.info({ 
      segmentsProcessed,
      totalSegmentsInMap: segmentMap.size,
      segmentsUsed,
      segmentsUnused,
      processedParagraphs,
      processedTables,
      skippedNoText,
      totalBodyElements: bodyChildren.length
    }, 'Finished updating document with translations using DOM');

    // Serialize the modified DOM back to XML
    // CRITICAL: XMLSerializer should preserve all attributes and structure
    const serializer = new XMLSerializer();
    
    // #region agent log - Check formatting before serialization
    if (segmentIndex > 0) {
      // Check a sample paragraph for formatting preservation
      const samplePara = bodyElement.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'p'
      )[0];
      if (samplePara) {
        const sampleRuns = samplePara.getElementsByTagNameNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'r'
        );
        const formattingCheck = Array.from(sampleRuns).slice(0, 3).map((run, idx) => {
          const rPr = run.getElementsByTagNameNS(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'rPr'
          );
          if (rPr.length > 0) {
            const rPrElement = rPr[0];
            // Get all child elements with their attributes
            const children = Array.from(rPrElement.childNodes)
              .filter(n => n.nodeType === 1) // ELEMENT_NODE
              .map(n => {
                const el = n as Element;
                const attrs: Record<string, string> = {};
                if (el.attributes) {
                  for (let i = 0; i < el.attributes.length; i++) {
                    const attr = el.attributes[i];
                    attrs[attr.name] = attr.value;
                  }
                }
                return {
                  name: el.localName || el.nodeName,
                  attributes: attrs
                };
              });
            return { runIndex: idx, formatting: children };
          }
          return { runIndex: idx, formatting: [] };
        }).filter(f => f.formatting.length > 0);
        
        logger.debug({ formattingCheck }, 'Export: Before serialization - formatting check');
      }
    }
    // #endregion
    
    const updatedXml = serializer.serializeToString(doc);
    
    // #region agent log
    const firstTranslation = Array.from(segmentMap.entries())[0]?.[1] || '';
    const finalXmlHasTranslation = updatedXml.includes(firstTranslation.substring(0, 30));
    
    // Check if formatting is preserved in serialized XML
    const hasBold = updatedXml.includes('<w:b') || updatedXml.includes('<w:b/>');
    const hasItalic = updatedXml.includes('<w:i') || updatedXml.includes('<w:i/>');
    const hasUnderline = updatedXml.includes('<w:u');
    const hasColor = updatedXml.includes('<w:color');
    const hasSize = updatedXml.includes('<w:sz');
    
    // Verify TOC field structure is preserved in final XML
    const hasTOCFieldChars = updatedXml.includes('w:fldCharType="begin"') || updatedXml.includes('w:fldCharType=\'begin\'');
    const hasTOCInstrText = updatedXml.includes('TOC') && updatedXml.includes('w:instrText');
    const tocFieldCharCount = (updatedXml.match(/w:fldCharType="begin"/g) || []).length;
    const tocInstrTextCount = (updatedXml.match(/w:instrText[^>]*>.*TOC/gi) || []).length;
    
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:3079',message:'Export: DOM serialization complete - TOC verification',data:{finalXmlHasTranslation,firstTranslation:firstTranslation.substring(0,30),finalXmlLength:updatedXml.length,formattingPreserved:{hasBold,hasItalic,hasUnderline,hasColor,hasSize},tocPreserved:{hasTOCFieldChars,hasTOCInstrText,tocFieldCharCount,tocInstrTextCount}},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    
    logger.debug({ 
      finalXmlHasTranslation, 
      firstTranslation: firstTranslation.substring(0, 30), 
      finalXmlLength: updatedXml.length, 
      formattingPreserved: { hasBold, hasItalic, hasUnderline, hasColor, hasSize },
      tocPreserved: { hasTOCFieldChars, hasTOCInstrText, tocFieldCharCount, tocInstrTextCount }
    }, 'Export: DOM serialization complete');
    // #endregion

    // PRESERVE all other files in the DOCX (styles.xml, settings.xml, etc.)
    // The zip already contains all original files, we only update document.xml
    zip.file('word/document.xml', updatedXml);
    
    // Generate the DOCX buffer with all original files preserved
    return Buffer.from(await zip.generateAsync({ 
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 } // Standard DOCX compression level
    }));
  }
}
