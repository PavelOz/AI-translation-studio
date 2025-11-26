import JSZip from 'jszip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import mammoth from 'mammoth';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileHandler, ParsedFileResult, ExportOptions } from './types';
import { env } from '../env';
import { logger } from '../logger';

const execAsync = promisify(exec);

/**
 * Execute LibreOffice command with isolated user profile
 */
async function execLibreOfficeWithIsolatedProfile(
  command: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise(async (resolve, reject) => {
    const timeout = options.timeout || 30000;
    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout;
    let tempProfileDir: string | null = null;

    try {
      const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const customProfileDir = path.join(os.tmpdir(), `lo_profile_${uniqueId}`);
      await fs.mkdir(customProfileDir, { recursive: true });
      tempProfileDir = customProfileDir;
      
      let profileUrl: string;
      if (process.platform === 'win32') {
        let fixedPath = customProfileDir.replace(/\\/g, '/');
        if (fixedPath.startsWith('/') && fixedPath.match(/^\/[A-Za-z]:/)) {
          fixedPath = fixedPath.substring(1);
        }
        profileUrl = `file:///${fixedPath}`;
      } else {
        const unixPath = customProfileDir.startsWith('/') ? customProfileDir : '/' + customProfileDir;
        profileUrl = `file://${unixPath}`;
      }
      
      let executable = command;
      if (process.platform === 'win32' && executable.endsWith('soffice.exe')) {
        executable = executable.replace('soffice.exe', 'soffice.com');
      }

      const isolatedArgs = [
        `-env:UserInstallation=${profileUrl}`,
        '--headless',
        '--nologo',
        '--nodefault',
        '--norestore',
        '--nolockcheck',
        '--nofirststartwizard',
        ...args.filter(arg => !arg.startsWith('--headless') && !arg.startsWith('--invisible') && !arg.startsWith('--nodefault') && !arg.startsWith('--norestore'))
      ];

      const cleanEnv = { ...(options.env || process.env) };
      if (process.platform === 'win32') {
        delete cleanEnv.SAL_USE_VCLPLUGIN;
      }

      if (process.platform === 'win32') {
        const child = spawn(executable, isolatedArgs, {
          env: cleanEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsVerbatimArguments: false,
          windowsHide: true,
        });

        try {
          child.stdin.write('\n');
          child.stdin.end();
        } catch (e) {
            // Ignore
        }

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });

        child.on('error', (error) => {
          if (timeoutId) clearTimeout(timeoutId);
          if (tempProfileDir) try { fsSync.rmSync(tempProfileDir, { recursive: true, force: true }); } catch (e) {}
          reject(error);
        });

        child.on('close', (code) => {
          if (timeoutId) clearTimeout(timeoutId);
          if (tempProfileDir) try { fsSync.rmSync(tempProfileDir, { recursive: true, force: true }); } catch (e) {}
          
          if (code === 0 || stdout || stderr) {
            resolve({ stdout, stderr });
          } else {
            reject(new Error(`LibreOffice process exited with code ${code}. Stderr: ${stderr.substring(0, 500)}`));
          }
        });

        timeoutId = setTimeout(() => {
          child.kill();
          if (tempProfileDir) try { fsSync.rmSync(tempProfileDir, { recursive: true, force: true }); } catch (e) {}
          reject(new Error(`LibreOffice command timed out after ${timeout}ms`));
        }, timeout);
      } else {
        // Unix implementation
        const child = spawn(command, isolatedArgs, {
          env: options.env || process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const sendEnter = () => {
          if (child.stdin && !child.stdin.destroyed && child.killed === false) {
            try { child.stdin.write('\n\n\n'); } catch (e) {}
          }
        };
        sendEnter();
        const enterInterval = setInterval(sendEnter, 100);

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });

        child.on('error', (error) => {
          clearInterval(enterInterval);
          if (timeoutId) clearTimeout(timeoutId);
          if (tempProfileDir) try { fsSync.rmSync(tempProfileDir, { recursive: true, force: true }); } catch (e) {}
          reject(error);
        });

        child.on('close', (code) => {
          clearInterval(enterInterval);
          if (timeoutId) clearTimeout(timeoutId);
          if (tempProfileDir) try { fsSync.rmSync(tempProfileDir, { recursive: true, force: true }); } catch (e) {}
          
          if (code === 0 || stdout || stderr) {
            resolve({ stdout, stderr });
          } else {
            reject(new Error(`LibreOffice process exited with code ${code}. Stderr: ${stderr.substring(0, 500)}`));
          }
        });

        timeoutId = setTimeout(() => {
          child.kill();
          if (tempProfileDir) try { fsSync.rmSync(tempProfileDir, { recursive: true, force: true }); } catch (e) {}
          reject(new Error(`LibreOffice command timed out after ${timeout}ms`));
        }, timeout);
      }
    } catch (error) {
      if (tempProfileDir) try { fsSync.rmSync(tempProfileDir, { recursive: true, force: true }); } catch (e) {}
      reject(error);
    }
  });
}

type DocxParagraph = {
  index: number;
  runs: Array<{
    text: string;
    properties?: Record<string, unknown>;
    originalNode: any; // Reference to the 'w:r' object in the preserved structure
  }>;
  properties?: Record<string, unknown>;
};

export class DocxHandler implements FileHandler {
  private parser = new XMLParser({ 
    ignoreAttributes: false, 
    attributeNamePrefix: '@_', 
    preserveOrder: true, 
    trimValues: false,
  });
  private builder = new XMLBuilder({ 
    ignoreAttributes: false, 
    attributeNamePrefix: '@_', 
    format: false, // Keep false to preserve whitespace exactly
    preserveOrder: true, 
  });
  private libreOfficeCommand: string | null = null;

  supports(mimeType: string | undefined, extension: string): boolean {
    return extension === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  // ... (keeping parseWithMammoth, isLibreOfficeAvailable, getLibreOfficeStatus, parseWithLibreOffice, parseHtmlFromLibreOffice, extractTextFromHtml, extractTextFromMammothElement same as original to save space, assuming they are correct for Import logic) ...
  // RE-INSERTING ESSENTIAL METHODS FOR CONTEXT - They are used in Import fallback

    private async parseWithMammoth(buffer: Buffer): Promise<ParsedFileResult> {
        // (Implementation identical to your provided code)
        // Shortened here for brevity, assume original implementation
        // ... 
        return { segments: [], metadata: {}, totalWords: 0 } as any; // Placeholder for this response block, use original
    }

    // ... (Skipping full implementations of LibreOffice/Mammoth helpers to focus on the FIX for parse/export) ...

  /**
   * Helper to find a specific child tag in an ordered array (preserveOrder format)
   */
  private findChild(array: any[], tagName: string): any | undefined {
    if (!Array.isArray(array)) return undefined;
    const found = array.find(item => item && typeof item === 'object' && tagName in item);
    return found ? found[tagName] : undefined;
  }

  /**
   * Helper to find ALL child tags of a specific type in an ordered array
   */
  private findChildren(array: any[], tagName: string): any[] {
    if (!Array.isArray(array)) return [];
    return array
      .filter(item => item && typeof item === 'object' && tagName in item)
      .map(item => item[tagName]); // Return the content of the tag
  }
  
  /**
   * Helper to return the wrapper objects { 'w:r': ... } for update purposes
   */
  private findChildrenWrappers(array: any[], tagName: string): any[] {
    if (!Array.isArray(array)) return [];
    return array.filter(item => item && typeof item === 'object' && tagName in item);
  }

  /**
   * Extract plain text from a paragraph node (preserveOrder structure)
   */
  private extractTextFromParagraphNode(paraContent: any[]): string {
    if (!Array.isArray(paraContent)) return '';

    // In preserveOrder, paraContent is an array of children: [{ "w:pPr": ... }, { "w:r": ... }, ...]
    const runs = this.findChildren(paraContent, 'w:r');
    
    return runs.map(runContent => {
      // runContent is the array of children of w:r
      if (!Array.isArray(runContent)) return '';
      
      const textNode = this.findChild(runContent, 'w:t');
      
      // textNode can be a string (if simple text) or an array (if has attributes like xml:space)
      if (typeof textNode === 'string') return textNode;
      if (Array.isArray(textNode)) {
          // It might contain attributes or just text object
          const textObj = textNode.find(t => t['#text']);
          return textObj ? textObj['#text'] : '';
      }
      return '';
    }).join('');
  }

  /**
   * Extract run objects for processing
   */
  private extractRunsFromParagraphNode(paraContent: any[]): Array<{ text: string, originalNode: any }> {
    if (!Array.isArray(paraContent)) return [];

    // We need the WRAPPERS { "w:r": [...] } to be able to identify them later or use them
    const runWrappers = this.findChildrenWrappers(paraContent, 'w:r');
    
    const results: Array<{ text: string, originalNode: any }> = [];

    for (const wrapper of runWrappers) {
      const runContent = wrapper['w:r'];
      if (!Array.isArray(runContent)) continue;

      const textNode = this.findChild(runContent, 'w:t');
      let text = '';

      if (typeof textNode === 'string') {
        text = textNode;
      } else if (Array.isArray(textNode)) {
        const textObj = textNode.find(t => t['#text']);
        if (textObj) text = textObj['#text'];
      }

      if (text) {
        results.push({ text, originalNode: wrapper });
      }
    }
    return results;
  }

  async parse(buffer: Buffer): Promise<ParsedFileResult> {
      // Fallback XML parsing logic
      const zip = await JSZip.loadAsync(buffer);
      const documentXml = await zip.file('word/document.xml')?.async('string');
      if (!documentXml) throw new Error('Invalid DOCX');

      const parsed = this.parser.parse(documentXml);
      
      // Traverse to Body
      // Structure: [{ "w:document": [ { "w:body": [ ... ] } ] }]
      const docWrapper = this.findChild(parsed, 'w:document');
      const bodyWrapper = this.findChild(docWrapper, 'w:body');

      if (!bodyWrapper || !Array.isArray(bodyWrapper)) {
          throw new Error('Invalid DOCX structure');
      }

      const segments: DocxParagraph[] = [];
      let segmentIndex = 0;

      for (const element of bodyWrapper) {
        // element is like { "w:p": [...] } or { "w:tbl": [...] }
        
        if ('w:p' in element) {
          const paraContent = element['w:p'];
          const text = this.extractTextFromParagraphNode(paraContent);
          
          if (text && text.trim()) {
            segments.push({
              index: segmentIndex++,
              runs: this.extractRunsFromParagraphNode(paraContent),
              properties: {}
            });
          }
        } 
        else if ('w:tbl' in element) {
           const tblContent = element['w:tbl'];
           const rows = this.findChildren(tblContent, 'w:tr');
           
           for (const rowContent of rows) {
             const cells = this.findChildren(rowContent, 'w:tc');
             for (const cellContent of cells) {
               const cellParas = this.findChildrenWrappers(cellContent, 'w:p'); // Get wrappers to match Loop structure
               
               for (const cellParaWrapper of cellParas) {
                 const cellParaContent = cellParaWrapper['w:p'];
                 const text = this.extractTextFromParagraphNode(cellParaContent);
                 if (text && text.trim()) {
                   segments.push({
                     index: segmentIndex++,
                     runs: this.extractRunsFromParagraphNode(cellParaContent),
                     properties: { isTableCell: true }
                   });
                 }
               }
             }
           }
        }
      }

      const parsedSegments = segments.map(seg => ({
        index: seg.index,
        sourceText: seg.runs.map(r => r.text).join(''),
        type: seg.properties?.isTableCell ? 'table-cell' : 'paragraph',
        metadata: {}
      }));

      return {
        segments: parsedSegments as any,
        metadata: { type: 'docx' },
        totalWords: 0
      };
  }

  async export(options: ExportOptions): Promise<Buffer> {
    if (!options.originalBuffer) throw new Error('Buffer required');

    const zip = await JSZip.loadAsync(options.originalBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    if (!documentXml) throw new Error('Invalid DOCX');

    const parsed = this.parser.parse(documentXml);

    // Locate Body
    const docWrapper = this.findChild(parsed, 'w:document');
    if (!docWrapper) throw new Error('Missing w:document');
    
    const bodyContent = this.findChild(docWrapper, 'w:body');
    if (!bodyContent) throw new Error('Missing w:body');

    const segmentMap = new Map(options.segments.map((seg) => [seg.index, seg.targetText]));
    let segmentIndex = 0;

    // Recursive function to process elements
    const processContent = (contentArray: any[]) => {
      for (const element of contentArray) {
        if ('w:p' in element) {
          const paraContent = element['w:p'];
          const text = this.extractTextFromParagraphNode(paraContent);

          if (text && text.trim()) {
            const translatedText = segmentMap.get(segmentIndex);
            
            if (translatedText && translatedText.trim()) {
              this.updateParagraphWithTranslation(paraContent, translatedText.trim());
            }
            segmentIndex++;
          }
        } 
        else if ('w:tbl' in element) {
          const tblContent = element['w:tbl'];
          const rows = this.findChildren(tblContent, 'w:tr');
          for (const rowContent of rows) {
             const cells = this.findChildren(rowContent, 'w:tc');
             for (const cellContent of cells) {
               // Cell content is a list of elements (p, tbl, etc)
               processContent(cellContent);
             }
          }
        }
      }
    };

    processContent(bodyContent);

    const updatedXml = this.builder.build(parsed);
    zip.file('word/document.xml', updatedXml);

    return Buffer.from(await zip.generateAsync({ 
      type: 'nodebuffer',
      compression: 'DEFLATE'
    }));
  }

  /**
   * Updates a paragraph structure with translated text
   * Preserves the FIRST run's formatting and removes subsequent text runs
   */
  private updateParagraphWithTranslation(paraContent: any[], translation: string) {
    if (!Array.isArray(paraContent)) return;

    // 1. Identify all "w:r" (run) wrappers that contain text "w:t"
    const textRunIndices: number[] = [];
    
    paraContent.forEach((child, index) => {
      if ('w:r' in child) {
        const runContent = child['w:r'];
        if (Array.isArray(runContent)) {
           const hasText = runContent.some(item => 'w:t' in item);
           if (hasText) {
             textRunIndices.push(index);
           }
        }
      }
    });

    if (textRunIndices.length === 0) return;

    // 2. Update the FIRST text run with the full translation
    const firstRunIndex = textRunIndices[0];
    const firstRunWrapper = paraContent[firstRunIndex];
    const firstRunContent = firstRunWrapper['w:r']; // This is an array

    // Find the w:t node within the run
    const textNodeIndex = firstRunContent.findIndex((item: any) => 'w:t' in item);
    
    if (textNodeIndex !== -1) {
       // Replace/Update w:t
       // If preserving whitespace is needed, we usually use an object with xml:space
       // But simpler approach: { "w:t": [{ "#text": translation }, { ":@": { "xml:space": "preserve" } }] }
       // Based on fast-xml-parser preserveOrder, we just set the value.
       
       // Note: To be safe with attributes, we construct a new w:t node
       firstRunContent[textNodeIndex] = {
         "w:t": [
           { "#text": translation },
           { ":@": { "xml:space": "preserve" } } // Ensure whitespace is kept
         ]
       };
    }

    // 3. Remove all subsequent text runs to avoid duplication
    // Iterate backwards to not mess up indices
    for (let i = textRunIndices.length - 1; i > 0; i--) {
      const indexToRemove = textRunIndices[i];
      paraContent.splice(indexToRemove, 1);
    }
  }
}