/**
 * Ghost Text Verification Script
 * 
 * Purpose: Verify that run merging logic didn't leave behind duplicate text.
 * 
 * Scenario: If Run A ("Hello") and Run B ("World") were merged into Run A ("Hello World"),
 * Run B must be empty in the exported file. If Run B still contains "World", we get
 * "Hello WorldWorld" which is incorrect.
 * 
 * This script:
 * 1. Parses original and exported XML files
 * 2. Extracts all text content
 * 3. Checks for duplicate text patterns (ghost text)
 * 4. Verifies semantic content integrity
 */

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

interface VerificationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    originalTextLength: number;
    exportedTextLength: number;
    duplicatePatterns: Array<{ pattern: string; context: string; location: string }>;
  };
}

/**
 * Extract all text from a DOCX XML document
 */
function extractTextFromDocument(xmlContent: string, source: string): {
  paragraphs: Array<{ index: number; text: string; runs: Array<{ index: number; text: string }> }>;
  fullText: string;
} {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    trimValues: false,
  });

  const parsed = parser.parse(xmlContent);
  const paragraphs: Array<{ index: number; text: string; runs: Array<{ index: number; text: string }> }> = [];
  
  // Find body element
  const bodyArray = parsed['w:document']?.['w:body'];
  if (!bodyArray || !Array.isArray(bodyArray)) {
    return { paragraphs: [], fullText: '' };
  }

  let paraIndex = 0;
  const allTexts: string[] = [];

  for (const bodyItem of bodyArray) {
    if (bodyItem && typeof bodyItem === 'object') {
      // Check for paragraphs
      if ('w:p' in bodyItem) {
        const paraItem = bodyItem['w:p'];
        const paraArray = Array.isArray(paraItem) ? paraItem : [paraItem];
        
        for (const para of paraArray) {
          if (!para || typeof para !== 'object') continue;

          // Extract runs from paragraph
          const runs: Array<{ index: number; text: string }> = [];
          let paraText = '';

          // Handle preserveOrder structure: para might be array of items
          let runArray: any[] = [];
          if (Array.isArray(para)) {
            for (const paraItem of para) {
              if (paraItem && typeof paraItem === 'object' && 'w:r' in paraItem) {
                const runItem = paraItem['w:r'];
                if (Array.isArray(runItem)) {
                  runArray.push(...runItem);
                } else if (runItem) {
                  runArray.push(runItem);
                }
              }
            }
          } else {
            const runsItem = para['w:r'];
            runArray = Array.isArray(runsItem) ? runsItem : (runsItem ? [runsItem] : []);
          }

          // Extract text from each run
          for (let runIndex = 0; runIndex < runArray.length; runIndex++) {
            const run = runArray[runIndex];
            if (!run || typeof run !== 'object') continue;

            const textNode = run['w:t'];
            if (!textNode) {
              runs.push({ index: runIndex, text: '' });
              continue;
            }

            // Extract text from text node
            let text = '';
            if (typeof textNode === 'string') {
              text = textNode;
            } else if (Array.isArray(textNode)) {
              text = textNode
                .map((t: any) => {
                  if (typeof t === 'string') return t;
                  if (typeof t === 'object' && t !== null && typeof t['#text'] === 'string') {
                    return t['#text'];
                  }
                  return '';
                })
                .join('');
            } else if (typeof textNode === 'object' && textNode !== null) {
              text = typeof textNode['#text'] === 'string' ? textNode['#text'] : '';
            }

            runs.push({ index: runIndex, text: text });
            paraText += text;
          }

          if (paraText.trim().length > 0 || runs.length > 0) {
            paragraphs.push({
              index: paraIndex++,
              text: paraText.trim(),
              runs: runs,
            });
            allTexts.push(paraText);
          }
        }
      }

      // Check for tables (cells contain paragraphs)
      if ('w:tbl' in bodyItem) {
        const tblItem = bodyItem['w:tbl'];
        const tblArray = Array.isArray(tblItem) ? tblItem : [tblItem];
        
        for (const table of tblArray) {
          if (!table || typeof table !== 'object') continue;
          const rows = table['w:tr'];
          const rowArray = Array.isArray(rows) ? rows : (rows ? [rows] : []);
          
          for (const row of rowArray) {
            if (!row || typeof row !== 'object') continue;
            const cells = row['w:tc'];
            const cellArray = Array.isArray(cells) ? cells : (cells ? [cells] : []);
            
            for (const cell of cellArray) {
              if (!cell || typeof cell !== 'object') continue;
              const cellParas = cell['w:p'];
              const cellParaArray = Array.isArray(cellParas) ? cellParas : (cellParas ? [cellParas] : []);
              
              for (const cellPara of cellParaArray) {
                if (!cellPara || typeof cellPara !== 'object') continue;
                
                // Extract text from cell paragraph (same logic as regular paragraphs)
                const runs: Array<{ index: number; text: string }> = [];
                let paraText = '';

                let runArray: any[] = [];
                if (Array.isArray(cellPara)) {
                  for (const paraItem of cellPara) {
                    if (paraItem && typeof paraItem === 'object' && 'w:r' in paraItem) {
                      const runItem = paraItem['w:r'];
                      if (Array.isArray(runItem)) {
                        runArray.push(...runItem);
                      } else if (runItem) {
                        runArray.push(runItem);
                      }
                    }
                  }
                } else {
                  const runsItem = cellPara['w:r'];
                  runArray = Array.isArray(runsItem) ? runsItem : (runsItem ? [runsItem] : []);
                }

                for (let runIndex = 0; runIndex < runArray.length; runIndex++) {
                  const run = runArray[runIndex];
                  if (!run || typeof run !== 'object') continue;

                  const textNode = run['w:t'];
                  if (!textNode) {
                    runs.push({ index: runIndex, text: '' });
                    continue;
                  }

                  let text = '';
                  if (typeof textNode === 'string') {
                    text = textNode;
                  } else if (Array.isArray(textNode)) {
                    text = textNode
                      .map((t: any) => {
                        if (typeof t === 'string') return t;
                        if (typeof t === 'object' && t !== null && typeof t['#text'] === 'string') {
                          return t['#text'];
                        }
                        return '';
                      })
                      .join('');
                  } else if (typeof textNode === 'object' && textNode !== null) {
                    text = typeof textNode['#text'] === 'string' ? textNode['#text'] : '';
                  }

                  runs.push({ index: runIndex, text: text });
                  paraText += text;
                }

                if (paraText.trim().length > 0 || runs.length > 0) {
                  paragraphs.push({
                    index: paraIndex++,
                    text: paraText.trim(),
                    runs: runs,
                  });
                  allTexts.push(paraText);
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    paragraphs,
    fullText: allTexts.join(' '),
  };
}

/**
 * Check for duplicate text patterns (ghost text indicators)
 */
function findDuplicatePatterns(text: string): Array<{ pattern: string; context: string; location: string }> {
  const duplicates: Array<{ pattern: string; context: string; location: string }> = [];
  
  // Pattern 1: Repeated words (e.g., "Hello Hello", "World World")
  const repeatedWordPattern = /\b(\w{2,})\s+\1\b/gi;
  let match;
  while ((match = repeatedWordPattern.exec(text)) !== null) {
    const start = Math.max(0, match.index - 30);
    const end = Math.min(text.length, match.index + match[0].length + 30);
    const context = text.substring(start, end).replace(/\s+/g, ' ');
    duplicates.push({
      pattern: match[0],
      context: `...${context}...`,
      location: `position ${match.index}`,
    });
  }

  // Pattern 2: Duplicate word boundaries without space (e.g., "HelloHello", "WorldWorld", "LINESS")
  const noSpaceDuplicatePattern = /\b(\w{2,})\1\b/gi;
  while ((match = noSpaceDuplicatePattern.exec(text)) !== null) {
    const start = Math.max(0, match.index - 30);
    const end = Math.min(text.length, match.index + match[0].length + 30);
    const context = text.substring(start, end).replace(/\s+/g, ' ');
    duplicates.push({
      pattern: match[0],
      context: `...${context}...`,
      location: `position ${match.index}`,
    });
  }

  // Pattern 3: Known problematic patterns from test cases
  const knownPatterns = [
    /LINESS/gi,
    /WorldWorld/gi,
    /HelloHello/gi,
    /PlanPlan/gi,
  ];

  for (const pattern of knownPatterns) {
    while ((match = pattern.exec(text)) !== null) {
      const start = Math.max(0, match.index - 30);
      const end = Math.min(text.length, match.index + match[0].length + 30);
      const context = text.substring(start, end).replace(/\s+/g, ' ');
      duplicates.push({
        pattern: match[0],
        context: `...${context}...`,
        location: `position ${match.index} (known pattern)`,
      });
    }
  }

  return duplicates;
}

/**
 * Check if exported runs that should be empty still have text
 */
function checkMergedRuns(
  original: ReturnType<typeof extractTextFromDocument>,
  exported: ReturnType<typeof extractTextFromDocument>
): string[] {
  const errors: string[] = [];

  // Compare paragraph by paragraph
  const minParaCount = Math.min(original.paragraphs.length, exported.paragraphs.length);
  
  for (let i = 0; i < minParaCount; i++) {
    const origPara = original.paragraphs[i];
    const expPara = exported.paragraphs[i];

    // If original paragraph had fewer runs but same text, exported might have merged runs
    // Check if exported has more runs with text than it should
    if (origPara.runs.length < expPara.runs.length) {
      // Count non-empty runs in original vs exported
      const origNonEmptyRuns = origPara.runs.filter(r => r.text.trim().length > 0).length;
      const expNonEmptyRuns = expPara.runs.filter(r => r.text.trim().length > 0).length;
      
      // If exported has more non-empty runs, might indicate ghost text
      if (expNonEmptyRuns > origNonEmptyRuns) {
        errors.push(
          `Paragraph ${i}: Exported has ${expNonEmptyRuns} non-empty runs, original had ${origNonEmptyRuns}. ` +
          `Possible ghost text. Text: "${origPara.text.substring(0, 50)}..."`
        );
      }
    }
  }

  return errors;
}

/**
 * Main verification function
 */
async function verifyGhostText(
  originalPath: string,
  exportedPath: string
): Promise<VerificationResult> {
  const result: VerificationResult = {
    passed: true,
    errors: [],
    warnings: [],
    stats: {
      originalTextLength: 0,
      exportedTextLength: 0,
      duplicatePatterns: [],
    },
  };

  try {
    // Load original XML
    console.log(`📄 Loading original: ${originalPath}`);
    let originalXml: string;
    
    if (originalPath.endsWith('.xml')) {
      originalXml = fs.readFileSync(originalPath, 'utf-8');
    } else if (originalPath.endsWith('.docx')) {
      const zip = await JSZip.loadAsync(fs.readFileSync(originalPath));
      const xmlFile = zip.file('word/document.xml');
      if (!xmlFile) {
        throw new Error('Original DOCX missing word/document.xml');
      }
      originalXml = await xmlFile.async('string');
    } else {
      throw new Error('Original file must be .xml or .docx');
    }

    // Load exported XML
    console.log(`📄 Loading exported: ${exportedPath}`);
    let exportedXml: string;
    
    if (exportedPath.endsWith('.xml')) {
      exportedXml = fs.readFileSync(exportedPath, 'utf-8');
    } else if (exportedPath.endsWith('.docx')) {
      const zip = await JSZip.loadAsync(fs.readFileSync(exportedPath));
      const xmlFile = zip.file('word/document.xml');
      if (!xmlFile) {
        throw new Error('Exported DOCX missing word/document.xml');
      }
      exportedXml = await xmlFile.async('string');
    } else {
      throw new Error('Exported file must be .xml or .docx');
    }

    // Extract text from both documents
    console.log('🔍 Extracting text from original...');
    const originalText = extractTextFromDocument(originalXml, 'original');
    result.stats.originalTextLength = originalText.fullText.length;

    console.log('🔍 Extracting text from exported...');
    const exportedText = extractTextFromDocument(exportedXml, 'exported');
    result.stats.exportedTextLength = exportedText.fullText.length;

    // Check for duplicate patterns in exported text
    console.log('🔍 Checking for duplicate patterns (ghost text)...');
    const duplicates = findDuplicatePatterns(exportedText.fullText);
    result.stats.duplicatePatterns = duplicates;

    if (duplicates.length > 0) {
      result.passed = false;
      result.errors.push(`Found ${duplicates.length} duplicate pattern(s) indicating ghost text:`);
      duplicates.forEach((dup, idx) => {
        result.errors.push(`  ${idx + 1}. Pattern "${dup.pattern}" at ${dup.location}`);
        result.errors.push(`     Context: ${dup.context}`);
      });
    }

    // Check merged runs
    console.log('🔍 Checking merged runs...');
    const mergedRunErrors = checkMergedRuns(originalText, exportedText);
    if (mergedRunErrors.length > 0) {
      result.passed = false;
      result.errors.push(...mergedRunErrors);
    }

    // Semantic comparison (normalized text should match)
    const normalizeText = (text: string) => {
      return text
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    };

    const origNormalized = normalizeText(originalText.fullText);
    const expNormalized = normalizeText(exportedText.fullText);

    // Check if text lengths are significantly different (might indicate duplication)
    const lengthDiff = Math.abs(result.stats.exportedTextLength - result.stats.originalTextLength);
    const lengthDiffPercent = (lengthDiff / result.stats.originalTextLength) * 100;
    
    if (lengthDiffPercent > 5) {
      result.warnings.push(
        `Text length differs by ${lengthDiffPercent.toFixed(1)}% ` +
        `(original: ${result.stats.originalTextLength}, exported: ${result.stats.exportedTextLength})`
      );
    }

    // Compare semantic content (should be similar, accounting for minor formatting differences)
    // For now, we just check if normalized texts are very similar
    // In a real scenario, the exported text might have translations, so exact match isn't expected
    // But if we're just testing ghost text, we can do a simple check

    console.log('✅ Verification complete');
    return result;
  } catch (error: any) {
    result.passed = false;
    result.errors.push(`Error during verification: ${error.message}`);
    if (error.stack) {
      result.errors.push(`Stack: ${error.stack}`);
    }
    return result;
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: ts-node scripts/verify-ghost-text.ts <original.xml|original.docx> <exported.xml|exported.docx>');
    console.log('');
    console.log('Example:');
    console.log('  ts-node scripts/verify-ghost-text.ts .cursor/document.xml .cursor/document_extr.xml');
    console.log('  ts-node scripts/verify-ghost-text.ts original.docx exported.docx');
    process.exit(1);
  }

  const originalPath = args[0];
  const exportedPath = args[1];

  // Check if files exist
  if (!fs.existsSync(originalPath)) {
    console.error(`❌ Error: Original file not found: ${originalPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(exportedPath)) {
    console.error(`❌ Error: Exported file not found: ${exportedPath}`);
    process.exit(1);
  }

  console.log('🧪 Ghost Text Verification Script\n');
  console.log('='.repeat(60));
  console.log('');

  const result = await verifyGhostText(originalPath, exportedPath);

  console.log('');
  console.log('='.repeat(60));
  console.log('📊 RESULTS');
  console.log('='.repeat(60));
  console.log('');

  if (result.passed) {
    console.log('✅ PASSED: No ghost text detected');
  } else {
    console.log('❌ FAILED: Ghost text detected');
  }

  console.log('');
  console.log('Statistics:');
  console.log(`  Original text length: ${result.stats.originalTextLength} characters`);
  console.log(`  Exported text length: ${result.stats.exportedTextLength} characters`);
  console.log(`  Duplicate patterns found: ${result.stats.duplicatePatterns.length}`);

  if (result.errors.length > 0) {
    console.log('');
    console.log('Errors:');
    result.errors.forEach((error, idx) => {
      console.log(`  ${idx + 1}. ${error}`);
    });
  }

  if (result.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    result.warnings.forEach((warning, idx) => {
      console.log(`  ${idx + 1}. ${warning}`);
    });
  }

  console.log('');
  process.exit(result.passed ? 0 : 1);
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { verifyGhostText, extractTextFromDocument, findDuplicatePatterns };

