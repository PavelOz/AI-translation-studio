import DiffMatchPatch from 'diff-match-patch';
import { stripFormattingMarkers } from './formatting';

/**
 * Check if a string is a number (including numbers with separators like dates, contract numbers)
 */
function isNumeric(str: string): boolean {
  if (!str || !str.trim()) return false;
  // Remove common separators and check if remaining is numeric
  const cleaned = str.replace(/[\s\/\-_\.]/g, '');
  return /^\d+$/.test(cleaned) && cleaned.length > 0;
}

/**
 * Extract all numbers from a string (for finding and replacing)
 */
function extractNumbers(text: string): Array<{ value: string; startIndex: number; endIndex: number }> {
  const numbers: Array<{ value: string; startIndex: number; endIndex: number }> = [];
  let currentNumber = '';
  let startIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (/\d/.test(char)) {
      if (currentNumber === '') {
        startIndex = i;
      }
      currentNumber += char;
    } else {
      if (currentNumber.length > 0) {
        numbers.push({
          value: currentNumber,
          startIndex,
          endIndex: i - 1,
        });
        currentNumber = '';
        startIndex = -1;
      }
    }
  }

  // Don't forget the last number if text ends with digits
  if (currentNumber.length > 0) {
    numbers.push({
      value: currentNumber,
      startIndex,
      endIndex: text.length - 1,
    });
  }

  return numbers;
}

/**
 * Find and replace a number in text, preserving context
 */
function replaceNumberInText(
  text: string,
  oldNumber: string,
  newNumber: string
): string {
  // Find all occurrences of the number
  const numbers = extractNumbers(text);
  
  // Find the number that matches oldNumber
  for (const num of numbers) {
    if (num.value === oldNumber) {
      // Replace at this position
      return (
        text.substring(0, num.startIndex) +
        newNumber +
        text.substring(num.endIndex + 1)
      );
    }
  }

  // If exact match not found, try fuzzy replacement
  // Look for the number pattern in context
  const regex = new RegExp(`\\b${oldNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  if (regex.test(text)) {
    return text.replace(regex, newNumber);
  }

  return text;
}

/**
 * Process a TM match to generate visual diff and repair numbers/dates
 */
export function processTmMatch(
  inputSource: string, // The text we are translating
  tmSource: string,    // The source text found in TM
  tmTarget: string    // The translation found in TM
): {
  diffHtml: string;      // HTML for displaying the Source column with visual diff
  repairedTarget: string; // The translation (potentially fixed)
  isRepaired: boolean;    // True if we changed numbers
} {
  const dmp = new DiffMatchPatch();
  
  // Strip formatting markers before processing (they shouldn't appear in the diff)
  const cleanInputSource = stripFormattingMarkers(inputSource);
  const cleanTmSource = stripFormattingMarkers(tmSource);
  const cleanTmTarget = stripFormattingMarkers(tmTarget);
  
  // Calculate diff between input source and TM source (using cleaned text)
  const diffs = dmp.diff_main(cleanTmSource, cleanInputSource);
  dmp.diff_cleanupSemantic(diffs);

  // Generate HTML for visual diff
  let diffHtml = '';
  const repairs: Array<{ oldNumber: string; newNumber: string }> = [];

  // First pass: identify number repairs needed
  for (let i = 0; i < diffs.length; i++) {
    const [operation, text] = diffs[i];
    
    if (operation === -1) {
      // DELETE: text removed from TM source
      const nextDiff = i + 1 < diffs.length ? diffs[i + 1] : null;
      
      if (nextDiff && nextDiff[0] === 1 && isNumeric(text) && isNumeric(nextDiff[1])) {
        // DELETE followed by INSERT, both numeric - this is a number change
        repairs.push({
          oldNumber: text.trim(),
          newNumber: nextDiff[1].trim(),
        });
      }
    }
  }

  // Second pass: generate HTML with styling
  for (let i = 0; i < diffs.length; i++) {
    const [operation, text] = diffs[i];
    const escapedText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    if (operation === 0) {
      // EQUAL: unchanged text
      diffHtml += escapedText;
    } else if (operation === -1) {
      // DELETE: text in TM but not in input (red strikethrough)
      diffHtml += `<span class="diff-del">${escapedText}</span>`;
    } else if (operation === 1) {
      // INSERT: text in input but not in TM (green highlight)
      diffHtml += `<span class="diff-add">${escapedText}</span>`;
    }
  }

  // Apply repairs to target text
  // Work with cleaned target for number replacement, then preserve formatting markers if they existed
  let repairedTarget = cleanTmTarget;
  let isRepaired = false;

  for (const repair of repairs) {
    const beforeRepair = repairedTarget;
    repairedTarget = replaceNumberInText(
      repairedTarget,
      repair.oldNumber,
      repair.newNumber
    );
    
    if (beforeRepair !== repairedTarget) {
      isRepaired = true;
    }
  }
  
  // If original target had formatting markers, we need to preserve them
  // For now, we'll return the cleaned repaired target
  // The component will handle formatting marker preservation if needed
  // (Formatting markers are typically preserved by the backend/segment service)

  return {
    diffHtml: diffHtml || cleanTmSource, // Fallback to original if no diff (use cleaned version)
    repairedTarget,
    isRepaired,
  };
}
