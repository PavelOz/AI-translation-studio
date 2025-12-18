/**
 * Traversal Trace Debug Script
 * 
 * Purpose: Compare parse() and export() traversal to identify index mismatches
 * 
 * This script:
 * 1. Runs parse() and logs every segment creation/skip
 * 2. Runs export() and logs every translation injection/skip
 * 3. Compares the logs side-by-side to find the first divergence
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocxHandler } from '../src/utils/file-handlers/docx.handler';

interface ParseTrace {
  elementIndex: number;
  segmentIndex?: number;
  type: 'paragraph' | 'table-cell' | 'skip';
  text: string;
  reason?: string;
  isTOC?: boolean;
}

interface ExportTrace {
  elementIndex: number;
  segmentIndex: number;
  type: 'paragraph' | 'table-cell' | 'skip';
  text: string;
  reason?: string;
  isTOC?: boolean;
  translatedText?: string;
}

class TraversalTracer {
  private parseTraces: ParseTrace[] = [];
  private exportTraces: ExportTrace[] = [];
  
  addParseTrace(trace: ParseTrace) {
    this.parseTraces.push(trace);
    // Just add to internal array - logs are already written by instrumentation
  }
  
  addExportTrace(trace: ExportTrace) {
    this.exportTraces.push(trace);
    // Just add to internal array - logs are already written by instrumentation
  }
  
  compareAndReport(): void {
    console.log('\n' + '='.repeat(80));
    console.log('TRAVERSAL COMPARISON REPORT');
    console.log('='.repeat(80) + '\n');
    
    // Find parse segments (non-skipped)
    const parseSegments = this.parseTraces.filter(t => t.segmentIndex !== undefined);
    // Find export segments (non-skipped)
    const exportSegments = this.exportTraces.filter(t => t.type !== 'skip');
    
    console.log(`Parse created ${parseSegments.length} segments`);
    console.log(`Export processed ${exportSegments.length} segments\n`);
    
    // Compare segment by segment
    const maxLength = Math.max(parseSegments.length, exportSegments.length);
    let firstDivergence: number | null = null;
    
    for (let i = 0; i < maxLength; i++) {
      const parseSeg = parseSegments[i];
      const exportSeg = exportSegments[i];
      
      if (!parseSeg && exportSeg) {
        firstDivergence = i;
        console.log(`❌ MISMATCH at Segment Index #${i}!`);
        console.log(`   Parse: MISSING (no segment)`);
        console.log(`   Export: Seg #${exportSeg.segmentIndex} | Element #${exportSeg.elementIndex} | Text: "${exportSeg.text.substring(0, 100)}"`);
        break;
      }
      
      if (parseSeg && !exportSeg) {
        firstDivergence = i;
        console.log(`❌ MISMATCH at Segment Index #${i}!`);
        console.log(`   Parse: Seg #${parseSeg.segmentIndex} | Element #${parseSeg.elementIndex} | Text: "${parseSeg.text.substring(0, 100)}"`);
        console.log(`   Export: MISSING (no segment)`);
        break;
      }
      
      if (parseSeg && exportSeg) {
        // Normalize text for comparison (trim whitespace)
        const parseTextNorm = parseSeg.text.trim();
        const exportTextNorm = exportSeg.text.trim();
        
        if (parseTextNorm !== exportTextNorm) {
          firstDivergence = i;
          console.log(`❌ MISMATCH at Segment Index #${i}!`);
          console.log(`   Parse Seg #${parseSeg.segmentIndex}: "${parseTextNorm.substring(0, 100)}${parseTextNorm.length > 100 ? '...' : ''}"`);
          console.log(`   Export Seg #${exportSeg.segmentIndex}: "${exportTextNorm.substring(0, 100)}${exportTextNorm.length > 100 ? '...' : ''}"`);
          break;
        }
      }
      
      // Log matching segments (first 10 only)
      if (i < 10 && parseSeg && exportSeg) {
        console.log(`✓ Seg #${i}: Match - "${parseSeg.text.substring(0, 50)}${parseSeg.text.length > 50 ? '...' : ''}"`);
      }
    }
    
    if (firstDivergence === null && parseSegments.length === exportSegments.length) {
      console.log('\n✅ No divergences found! All segments match.');
    } else if (firstDivergence === null) {
      console.log(`\n⚠️  Segment count mismatch: Parse=${parseSegments.length}, Export=${exportSegments.length}`);
      console.log('    Check the detailed traces above for skipped elements.');
    }
    
    // Analyze skipped elements
    console.log('\n' + '-'.repeat(80));
    console.log('SKIPPED ELEMENTS ANALYSIS');
    console.log('-'.repeat(80));
    
    const parseSkipped = this.parseTraces.filter(t => t.segmentIndex === undefined);
    const exportSkipped = this.exportTraces.filter(t => t.type === 'skip');
    
    console.log(`Parse skipped ${parseSkipped.length} elements`);
    console.log(`Export skipped ${exportSkipped.length} elements\n`);
    
    // Compare skipped elements by elementIndex
    const parseSkippedByIndex = new Map(parseSkipped.map(t => [t.elementIndex, t]));
    const exportSkippedByIndex = new Map(exportSkipped.map(t => [t.elementIndex, t]));
    
    const allElementIndices = new Set([
      ...parseSkippedByIndex.keys(),
      ...exportSkippedByIndex.keys()
    ]);
    
    // Also check if Export has segment traces (non-skip) for these elementIndices
    const exportSegmentsByIndex = new Map(
      this.exportTraces
        .filter(t => t.type !== 'skip')
        .map(t => [t.elementIndex, t])
    );
    
    // Also include elementIndices from export segments to catch cases where Export processed but Parse skipped
    const allElementIndicesWithSegments = new Set([
      ...allElementIndices,
      ...exportSegmentsByIndex.keys()
    ]);
    
    let skipMismatches = 0;
    for (const elementIndex of Array.from(allElementIndicesWithSegments).sort((a, b) => a - b)) {
      const parseSkip = parseSkippedByIndex.get(elementIndex);
      const exportSkip = exportSkippedByIndex.get(elementIndex);
      const exportSegment = exportSegmentsByIndex.get(elementIndex);
      
      // Both skipped - this is correct, no mismatch
      if (parseSkip && exportSkip) {
        // Both skipped - this is correct alignment
        continue;
      }
      
      // Parse skipped but Export processed (has segment, no skip)
      if (parseSkip && !exportSkip && exportSegment) {
        console.log(`⚠️  Element #${elementIndex}: Parse skipped but Export processed`);
        console.log(`    Parse reason: ${parseSkip.reason || 'Unknown'} | Text: "${parseSkip.text.substring(0, 50)}"`);
        console.log(`    Export segment: type=${exportSegment.type}, segIdx=${exportSegment.segmentIndex}, text="${exportSegment.text.substring(0, 50)}"`);
        skipMismatches++;
      } else if (parseSkip && !exportSkip && !exportSegment) {
        // Parse skipped, Export also skipped (no segment, no skip trace - might be a bug in logging)
        console.log(`⚠️  Element #${elementIndex}: Parse skipped but Export has no trace (possible logging bug)`);
        console.log(`    Parse reason: ${parseSkip.reason || 'Unknown'} | Text: "${parseSkip.text.substring(0, 50)}"`);
        skipMismatches++;
      } else if (!parseSkip && exportSkip) {
        console.log(`⚠️  Element #${elementIndex}: Export skipped but Parse processed`);
        console.log(`    Export reason: ${exportSkip.reason || 'Unknown'} | Text: "${exportSkip.text.substring(0, 50)}"`);
        skipMismatches++;
      }
    }
    
    if (skipMismatches === 0) {
      console.log('✅ All skipped elements match between Parse and Export');
    }
    
    console.log('\n' + '='.repeat(80));
  }
  
  getTraces() {
    return {
      parse: this.parseTraces,
      export: this.exportTraces,
    };
  }
}


/**
 * Parse debug logs from the log file
 */
function parseDebugLogs(logPath: string): { parse: ParseTrace[]; export: ExportTrace[] } {
  const parseTraces: ParseTrace[] = [];
  const exportTraces: ExportTrace[] = [];
  
  if (!fs.existsSync(logPath)) {
    console.warn(`⚠️  Log file not found: ${logPath}`);
    return { parse: parseTraces, export: exportTraces };
  }
  
  const logContent = fs.readFileSync(logPath, 'utf-8');
  const lines = logContent.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      
      // Filter for traversal trace entries
      if (entry.runId !== 'traversal-trace') continue;
      
      const location = entry.location || '';
      const message = entry.message || '';
      const data = entry.data || {};
      
      // Parse traces
      if (message.includes('[PARSE] Seg created')) {
        parseTraces.push({
          elementIndex: data.parseElementIndex || data.elementIndex || 0,
          segmentIndex: data.segmentIndex,
          type: data.type === 'table-cell' ? 'table-cell' : 'paragraph',
          text: data.text || '',
        });
      } else if (message.includes('[PARSE] Skipped')) {
        parseTraces.push({
          elementIndex: data.parseElementIndex || data.elementIndex || 0,
          type: data.type === 'table-cell' ? 'table-cell' : 'paragraph',
          text: data.text || '',
          reason: data.reason || 'unknown',
          isTOC: data.isTOC || false,
        });
      }
      
      // Export traces
      if (message.includes('[EXPORT] Seg injection')) {
        exportTraces.push({
          elementIndex: data.elementIndex || 0,
          segmentIndex: data.segmentIndex || 0,
          type: data.type === 'table-cell' ? 'table-cell' : 'paragraph',
          text: data.text || '',
          translatedText: data.translatedText || '',
        });
      } else if (message.includes('[EXPORT] Skipped')) {
        exportTraces.push({
          elementIndex: data.elementIndex || 0,
          segmentIndex: data.segmentIndex || 0,
          type: 'skip',
          text: data.text || '',
          reason: data.reason || 'unknown',
          isTOC: data.isTOC || false,
        });
      } else if (message.includes('[EXPORT] Seg no translation')) {
        exportTraces.push({
          elementIndex: data.elementIndex || 0,
          segmentIndex: data.segmentIndex || 0,
          type: data.type === 'table-cell' ? 'table-cell' : 'paragraph',
          text: data.text || '',
        });
      }
    } catch (e) {
      // Skip invalid JSON lines
      continue;
    }
  }
  
  // Sort by segmentIndex (for segments) or elementIndex (for skips)
  parseTraces.sort((a, b) => {
    if (a.segmentIndex !== undefined && b.segmentIndex !== undefined) {
      return a.segmentIndex - b.segmentIndex;
    }
    return a.elementIndex - b.elementIndex;
  });
  
  exportTraces.sort((a, b) => {
    if (a.type === 'skip' && b.type === 'skip') {
      return a.elementIndex - b.elementIndex;
    }
    return a.segmentIndex - b.segmentIndex;
  });
  
  return { parse: parseTraces, export: exportTraces };
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage: ts-node scripts/debug-docx-traversal.ts <docx-file>');
    console.log('');
    console.log('Example:');
    console.log('  ts-node scripts/debug-docx-traversal.ts test.docx');
    process.exit(1);
  }

  const docxPath = args[0];
  // Log file is at workspace root, not in backend directory
  const workspaceRoot = path.resolve(__dirname, '../..');
  const logPath = path.join(workspaceRoot, '.cursor', 'debug.log');

  if (!fs.existsSync(docxPath)) {
    console.error(`❌ Error: File not found: ${docxPath}`);
    process.exit(1);
  }

  // Clear existing log file
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '');
    console.log('📝 Cleared existing log file\n');
  }

  console.log('🔍 DOCX Traversal Trace Debug Script\n');
  console.log(`File: ${docxPath}`);
  console.log(`Log: ${logPath}\n`);
  console.log('='.repeat(80));
  console.log('PHASE 1: PARSE');
  console.log('='.repeat(80) + '\n');

  const handler = new DocxHandler();
  
  // Read file
  const fileBuffer = fs.readFileSync(docxPath);
  
  // Phase 1: Parse
  let parseResult;
  try {
    parseResult = await handler.parse(fileBuffer);
    console.log(`✅ Parse completed: ${parseResult.segments.length} segments created\n`);
  } catch (error: any) {
    console.error(`❌ Parse failed: ${error.message}`);
    process.exit(1);
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 2: EXPORT');
  console.log('='.repeat(80) + '\n');
  
  // Phase 2: Export with dummy translations (use original text)
  const dummySegments = parseResult.segments.map(seg => ({
    index: seg.index,
    targetText: seg.sourceText, // Use original text as translation
    segmentType: seg.type,
    metadata: seg.metadata,
  }));
  
  try {
    await handler.export({
      segments: dummySegments,
      originalBuffer: fileBuffer,
      metadata: parseResult.metadata,
    });
    console.log(`✅ Export completed\n`);
  } catch (error: any) {
    console.error(`❌ Export failed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
  
  // Wait a bit for logs to be written
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 3: PARSE LOGS AND COMPARE');
  console.log('='.repeat(80) + '\n');
  
  // Phase 3: Parse logs and compare
  const { parse: parseTraces, export: exportTraces } = parseDebugLogs(logPath);
  
  console.log(`Found ${parseTraces.filter(t => t.segmentIndex !== undefined).length} parse segments`);
  console.log(`Found ${exportTraces.filter(t => t.type !== 'skip').length} export segments\n`);
  
  // Create tracer and populate with parsed traces
  const tracer = new TraversalTracer();
  parseTraces.forEach(trace => tracer.addParseTrace(trace));
  exportTraces.forEach(trace => tracer.addExportTrace(trace));
  
  // Compare
  tracer.compareAndReport();
  
  console.log('\n✅ Debug script completed');
  console.log(`\nFull logs available in: ${logPath}`);
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { TraversalTracer, ParseTrace, ExportTrace };

