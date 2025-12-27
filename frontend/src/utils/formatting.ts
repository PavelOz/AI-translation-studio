/**
 * Utility functions for handling formatting markers in DOCX segments
 * 
 * Formatting markers like {{0}}...{{/0}} are used internally to preserve
 * rich text formatting (bold, italic, subscript, etc.) but should be
 * hidden from users in the UI.
 */

/**
 * Remove formatting markers from text for display in UI
 * 
 * Removes patterns like {{0}}...{{/0}}, {{1}}...{{/1}}, etc.
 * 
 * @param text Text that may contain formatting markers
 * @returns Text with formatting markers removed
 * 
 * @example
 * stripFormattingMarkers("{{0}}Hello{{/0}}{{1}}World{{/1}}")
 * // Returns: "HelloWorld"
 */
export function stripFormattingMarkers(text: string): string {
  if (!text) return text;
  
  // Remove all formatting markers: {{n}} and {{/n}} where n is a number
  return text.replace(/\{\{\d+\}\}/g, '').replace(/\{\{\/\d+\}\}/g, '');
}

/**
 * Check if text contains formatting markers
 * 
 * @param text Text to check
 * @returns True if text contains formatting markers
 */
export function hasFormattingMarkers(text: string): boolean {
  if (!text) return false;
  return /\{\{\d+\}\}/.test(text) || /\{\{\/\d+\}\}/.test(text);
}

/**
 * Restore formatting markers to edited text based on source text structure
 * 
 * This is used when user edits translation text that had markers.
 * We restore markers by matching the structure of the source text.
 * 
 * @param editedText Text edited by user (without markers)
 * @param originalTargetText Original target text (may have markers) - not used currently
 * @param sourceText Source text (should have markers for reference)
 * @returns Text with markers restored based on source structure
 */
export function restoreFormattingMarkers(
  editedText: string,
  _originalTargetText: string,
  sourceText?: string
): string {
  // If source text doesn't have markers, return edited text as-is
  if (!sourceText || !hasFormattingMarkers(sourceText)) {
    return editedText;
  }

  // If edited text is empty, return as-is
  if (!editedText.trim()) {
    return editedText;
  }

  // Extract marker structure from source text
  const markerPattern = /\{\{(\d+)\}\}(.*?)\{\{\/\1\}\}/g;
  const sourceSegments: Array<{ index: number; text: string; startPos: number; endPos: number }> = [];
  let match;
  let lastIndex = 0;

  while ((match = markerPattern.exec(sourceText)) !== null) {
    const strippedSource = stripFormattingMarkers(sourceText);
    const segmentText = match[2];
    const segmentStartInStripped = strippedSource.indexOf(segmentText, lastIndex);
    
    if (segmentStartInStripped !== -1) {
      sourceSegments.push({
        index: parseInt(match[1], 10),
        text: segmentText,
        startPos: segmentStartInStripped,
        endPos: segmentStartInStripped + segmentText.length,
      });
      lastIndex = segmentStartInStripped + segmentText.length;
    }
  }

  // If we couldn't parse markers from source, return edited text
  if (sourceSegments.length === 0) {
    return editedText;
  }

  // Try to map edited text to source structure
  // This is a simplified approach: if the edited text matches the source structure,
  // we restore the markers. Otherwise, we return the edited text as-is.
  const strippedSource = stripFormattingMarkers(sourceText);
  
  // If edited text exactly matches stripped source, restore markers
  if (editedText === strippedSource) {
    return sourceText; // Return source with markers (assuming translation preserved structure)
  }

  // For now, if user edited the text, we can't perfectly restore markers
  // This is acceptable - the user is making manual edits
  // The markers are mainly for AI to preserve formatting
  return editedText;
}



