import JSZip from 'jszip';
import { XMLParser, XMLBuilder, XMLBuilderOptions } from 'fast-xml-parser';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
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
 * This prevents recovery dialogs and "press Enter to continue" prompts
 * by using a temporary, isolated LibreOffice profile
 */
async function execLibreOfficeWithIsolatedProfile(
  command: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  // Create a temporary directory for isolated LibreOffice profile
  // This prevents recovery dialogs and "press Enter" prompts
  return new Promise(async (resolve, reject) => {
    const timeout = options.timeout || 30000;
    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout;
    let tempProfileDir: string | null = null;

    try {
      // Create temporary directory for isolated LibreOffice profile with unique ID
      // Use timestamp + random string for better uniqueness
      const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const customProfileDir = path.join(os.tmpdir(), `lo_profile_${uniqueId}`);
      await fs.mkdir(customProfileDir, { recursive: true });
      tempProfileDir = customProfileDir;
      
      logger.debug({ tempProfileDir, command }, 'Created temporary profile directory for LibreOffice');
      
      // Convert Windows path to file:// URL format for LibreOffice
      // CRITICAL: LibreOffice on Windows requires file:///C:/Users/... format (with three slashes)
      // Without this triple slash, LibreOffice ignores the UserInstallation flag
      let profileUrl: string;
      if (process.platform === 'win32') {
        // Windows: convert C:\path\to\dir to file:///C:/path/to/dir
        // Replace backslashes with forward slashes
        let fixedPath = customProfileDir.replace(/\\/g, '/');
        // Remove leading slash if present (we'll add it in file:// URL)
        // For Windows drive paths (C:/...), we want file:///C:/... (three slashes)
        // file:// (2 slashes) + / (1 slash) + C:/path = file:///C:/path
        if (fixedPath.startsWith('/') && fixedPath.match(/^\/[A-Za-z]:/)) {
          // Path is /C:/path, remove the leading slash
          fixedPath = fixedPath.substring(1);
        }
        // CRITICAL: Use file:// with three slashes for Windows
        // Format: file:///C:/Users/... (file:// + / + C:/path)
        profileUrl = `file:///${fixedPath}`;
      } else {
        // Unix: convert /path/to/dir to file:///path/to/dir
        // Ensure leading slash for Unix paths
        const unixPath = customProfileDir.startsWith('/') ? customProfileDir : '/' + customProfileDir;
        profileUrl = `file://${unixPath}`;
      }
      
      logger.debug({ profileUrl, originalPath: tempProfileDir }, 'LibreOffice profile URL formatted');

      // CRITICAL FIX: On Windows, use soffice.com instead of soffice.exe
      // soffice.exe is a GUI app (Subsystem: Windows) that doesn't attach to console properly
      // soffice.com is a Console app (Subsystem: Console) designed for command-line operations
      let executable = command;
      if (process.platform === 'win32' && executable.endsWith('soffice.exe')) {
        executable = executable.replace('soffice.exe', 'soffice.com');
        logger.debug({ original: command, using: executable }, 'Switched to soffice.com for Windows console mode');
      }

      // Add -env:UserInstallation flag to isolate the profile
      // Use proper LibreOffice flags to prevent recovery dialogs
      const isolatedArgs = [
        `-env:UserInstallation=${profileUrl}`, // Isolated profile (prevents recovery dialogs)
        '--headless',
        '--nologo',
        '--nodefault',
        '--norestore',
        '--nolockcheck',
        '--nofirststartwizard',
        ...args.filter(arg => !arg.startsWith('--headless') && !arg.startsWith('--invisible') && !arg.startsWith('--nodefault') && !arg.startsWith('--norestore')) // Remove duplicates
      ];

      logger.debug(
        { 
          command: executable, 
          profileDir: tempProfileDir,
          profileUrl,
          args: isolatedArgs.slice(0, 4)
        },
        'Executing LibreOffice with isolated profile'
      );

      // CRITICAL FIX: Clean environment variables for Windows
      // Remove SAL_USE_VCLPLUGIN=gen (Linux-specific, causes hangs on Windows)
      const cleanEnv = { ...(options.env || process.env) };
      if (process.platform === 'win32') {
        delete cleanEnv.SAL_USE_VCLPLUGIN; // Remove 'gen' on Windows - let Windows use default GDI/DirectX backend
      }

      // On Windows, use spawn directly without shell for better control
      if (process.platform === 'win32') {
        // Use spawn directly without shell - Node.js handles argument escaping
        const child = spawn(executable, isolatedArgs, {
          env: cleanEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsVerbatimArguments: false, // Let Node.js handle escaping
          windowsHide: true, // Hide window on Windows
        });

        // CRITICAL FIX: Close stdin immediately to prevent hang
        // LibreOffice waits for EOF signal. If stdin stays open, it hangs forever.
        // Send one newline just in case, then immediately END the stream.
        try {
          child.stdin.write('\n');
          child.stdin.end(); // This sends EOF and tells LibreOffice "No more input coming, proceed."
        } catch (e) {
          // Ignore errors if stdin is already closed
          if ((e as NodeJS.ErrnoException).code !== 'EPIPE') {
            logger.debug({ error: e }, 'Error closing LibreOffice stdin');
          }
        }

        // Log process start
        logger.debug({ pid: child.pid, executable, args: isolatedArgs.slice(0, 3) }, 'LibreOffice process spawned');

        child.stdout.on('data', (data) => {
          const text = data.toString();
          stdout += text;
          logger.debug({ pid: child.pid, output: text.substring(0, 500) }, 'LibreOffice stdout');
        });

        child.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          logger.debug({ pid: child.pid, output: text.substring(0, 500) }, 'LibreOffice stderr');
        });

        child.on('error', (error) => {
          if (timeoutId) clearTimeout(timeoutId);
          
          // Clean up temporary profile directory on error
          if (tempProfileDir) {
            try {
              fsSync.rmSync(tempProfileDir, { recursive: true, force: true });
            } catch (cleanupError) {
              logger.warn({ profileDir: tempProfileDir, error: cleanupError }, 'Failed to clean up temporary profile on spawn error');
            }
          }
          
          logger.error({ error, command, args: isolatedArgs.slice(0, 3) }, 'LibreOffice spawn error');
          reject(error);
        });

        child.on('close', (code) => {
          if (timeoutId) clearTimeout(timeoutId);
          
          // Clean up temporary profile directory
          if (tempProfileDir) {
            try {
              fsSync.rmSync(tempProfileDir, { recursive: true, force: true });
              logger.debug({ profileDir: tempProfileDir }, 'Cleaned up temporary LibreOffice profile');
            } catch (cleanupError) {
              logger.warn({ profileDir: tempProfileDir, error: cleanupError }, 'Failed to clean up temporary profile');
            }
          }

          logger.debug(
            { code, stdoutLength: stdout.length, stderrLength: stderr.length },
            'LibreOffice process closed'
          );
          
          // On Windows, LibreOffice --version may exit with code 0 without output
          // Consider it success if exit code is 0, even without stdout/stderr
          if (code === 0) {
            resolve({ stdout, stderr });
          } else if (stdout || stderr) {
            // Also accept if there's any output (for compatibility)
            resolve({ stdout, stderr });
          } else {
            reject(new Error(`LibreOffice process exited with code ${code}. Stderr: ${stderr.substring(0, 500)}`));
          }
        });

        timeoutId = setTimeout(() => {
          child.kill();
          
          // Clean up temporary profile directory
          if (tempProfileDir) {
            try {
              fsSync.rmSync(tempProfileDir, { recursive: true, force: true });
            } catch (cleanupError) {
              logger.warn({ profileDir: tempProfileDir, error: cleanupError }, 'Failed to clean up temporary profile on timeout');
            }
          }
          
          reject(new Error(`LibreOffice command timed out after ${timeout}ms`));
        }, timeout);
      } else {
        // Linux/Mac: use spawn with isolated profile
        const child = spawn(command, isolatedArgs, {
          env: options.env || process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Aggressively send Enter keys immediately and frequently
        // This prevents "press Enter" dialogs that appear before we can react
        let processClosed = false;
        const sendEnter = () => {
          if (processClosed) return;
          if (child.stdin && !child.stdin.destroyed && child.killed === false) {
            try {
              // Send multiple Enter keys at once
              child.stdin.write('\n\n\n\n\n\n\n\n\n\n');
            } catch (error) {
              // Ignore EPIPE errors (process already closed)
              if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
                logger.debug({ error }, 'Error sending Enter to LibreOffice stdin');
              }
            }
          }
        };
        
        // Send Enter immediately multiple times
        sendEnter();
        sendEnter();
        sendEnter();
        
        // Send Enter very frequently (every 100ms) to catch any dialogs
        const enterInterval = setInterval(sendEnter, 100);

        child.stdout.on('data', (data) => {
          const text = data.toString();
          stdout += text;
          logger.debug({ output: text.substring(0, 200) }, 'LibreOffice stdout');
        });

        child.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          logger.debug({ output: text.substring(0, 200) }, 'LibreOffice stderr');
        });

        child.on('error', (error) => {
          clearInterval(enterInterval);
          if (timeoutId) clearTimeout(timeoutId);
          
          // Clean up temporary profile directory on error
          if (tempProfileDir) {
            try {
              fsSync.rmSync(tempProfileDir, { recursive: true, force: true });
            } catch (cleanupError) {
              logger.warn({ profileDir: tempProfileDir, error: cleanupError }, 'Failed to clean up temporary profile on spawn error');
            }
          }
          
          logger.error({ error, command, args: isolatedArgs.slice(0, 3) }, 'LibreOffice spawn error');
          reject(error);
        });

        child.on('close', (code) => {
          if (timeoutId) clearTimeout(timeoutId);
          
          // Clean up temporary profile directory
          if (tempProfileDir) {
            try {
              fsSync.rmSync(tempProfileDir, { recursive: true, force: true });
              logger.debug({ profileDir: tempProfileDir }, 'Cleaned up temporary LibreOffice profile');
            } catch (cleanupError) {
              logger.warn({ profileDir: tempProfileDir, error: cleanupError }, 'Failed to clean up temporary profile');
            }
          }

          logger.debug(
            { code, stdoutLength: stdout.length, stderrLength: stderr.length },
            'LibreOffice process closed'
          );

          if (code === 0 || stdout || stderr) {
            resolve({ stdout, stderr });
          } else {
            reject(new Error(`LibreOffice process exited with code ${code}. Stderr: ${stderr.substring(0, 500)}`));
          }
        });

        // Set timeout
        timeoutId = setTimeout(() => {
          child.kill();
          
          // Clean up temporary profile directory
          if (tempProfileDir) {
            try {
              fsSync.rmSync(tempProfileDir, { recursive: true, force: true });
            } catch (cleanupError) {
              logger.warn({ profileDir: tempProfileDir, error: cleanupError }, 'Failed to clean up temporary profile on timeout');
            }
          }
          
          reject(new Error(`LibreOffice command timed out after ${timeout}ms`));
        }, timeout);
      }
    } catch (error) {
      // Clean up temporary profile directory on error
      if (tempProfileDir) {
        try {
          fsSync.rmSync(tempProfileDir, { recursive: true, force: true });
        } catch (cleanupError) {
          logger.warn({ profileDir: tempProfileDir, error: cleanupError }, 'Failed to clean up temporary profile on error');
        }
      }
      reject(error);
    }
  });
}

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
  private libreOfficeCommand: string | null = null;

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
   * Check if LibreOffice is available on the system
   */
  private async isLibreOfficeAvailable(): Promise<boolean> {
    if (!env.useLibreOffice) {
      logger.debug('LibreOffice is disabled in configuration (USE_LIBRE_OFFICE=false)');
      return false;
    }

    // If we already found the command, use it
    if (this.libreOfficeCommand) {
      return true;
    }

    logger.info('Checking for LibreOffice availability...');

    try {
      // First, check if the file exists
      try {
        await fs.access(env.libreOfficePath);
      } catch (accessError) {
        logger.debug({ path: env.libreOfficePath }, 'LibreOffice executable not found at configured path');
        throw new Error(`LibreOffice executable not found at ${env.libreOfficePath}`);
      }

      // Try the configured path first
      // CRITICAL: Clean environment - remove SAL_USE_VCLPLUGIN on Windows
      const envVars: NodeJS.ProcessEnv = {
        ...process.env,
        SAL_DISABLE_OPENCL: '1',
        SAL_NO_SYSTEM_FILE_LOCKING: '1',
      };
      // Remove Linux-specific VCL plugin on Windows (causes hangs)
      if (process.platform === 'win32') {
        delete envVars.SAL_USE_VCLPLUGIN;
      } else {
        envVars.SAL_USE_VCLPLUGIN = 'gen';
      }

      const versionOutput = await execLibreOfficeWithIsolatedProfile(
        env.libreOfficePath,
        ['--headless', '--nodefault', '--norestore', '--version'],
        { timeout: 30000, env: envVars } // Increased timeout for first launch (may take longer)
      );
      
      this.libreOfficeCommand = env.libreOfficePath;
      logger.info(
        { 
          path: env.libreOfficePath,
          version: versionOutput.stdout?.trim() || 'unknown'
        },
        'LibreOffice found and ready to use'
      );
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug({ 
        path: env.libreOfficePath, 
        error: errorMessage,
        errorType: error instanceof Error ? error.constructor.name : typeof error
      }, 'Configured LibreOffice path not found, trying alternatives...');
      
      // Try common LibreOffice command names as fallback
      const commonCommands = process.platform === 'win32' 
        ? [
            'soffice.exe',
            'soffice',
            'libreoffice.exe',
            // Common Windows installation paths
            'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
            'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
          ]
        : ['libreoffice', 'soffice'];
      
      for (const cmd of commonCommands) {
        try {
          // CRITICAL: Clean environment - remove SAL_USE_VCLPLUGIN on Windows
          const envVars: NodeJS.ProcessEnv = {
            ...process.env,
            SAL_DISABLE_OPENCL: '1',
            SAL_NO_SYSTEM_FILE_LOCKING: '1',
          };
          // Remove Linux-specific VCL plugin on Windows (causes hangs)
          if (process.platform === 'win32') {
            delete envVars.SAL_USE_VCLPLUGIN;
          } else {
            envVars.SAL_USE_VCLPLUGIN = 'gen';
          }
          
          const versionOutput = await execLibreOfficeWithIsolatedProfile(
            cmd,
            ['--headless', '--nodefault', '--norestore', '--version'],
            { timeout: 30000, env: envVars } // Increased timeout for first launch (may take longer)
          );
          
          // Store the full command path for later use
          this.libreOfficeCommand = cmd;
          logger.info(
            { 
              path: cmd,
              version: versionOutput.stdout?.trim() || 'unknown'
            },
            'LibreOffice found and ready to use'
          );
          return true;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.debug({ 
            command: cmd, 
            error: errorMessage 
          }, 'LibreOffice command failed, trying next...');
          // Continue to next command
        }
      }
      
      logger.warn(
        { 
          configuredPath: env.libreOfficePath,
          platform: process.platform 
        },
        'LibreOffice is not available. Falling back to XML parsing for DOCX files.'
      );
      return false;
    }
  }

  /**
   * Get LibreOffice status (for diagnostics)
   */
  public async getLibreOfficeStatus(): Promise<{
    enabled: boolean;
    available: boolean;
    command?: string;
    configuredPath: string;
  }> {
    const enabled = env.useLibreOffice;
    const available = enabled ? await this.isLibreOfficeAvailable() : false;
    
    return {
      enabled,
      available,
      command: this.libreOfficeCommand || undefined,
      configuredPath: env.libreOfficePath,
    };
  }

  /**
   * Parse DOCX using LibreOffice (headless mode) for best quality and order preservation
   * LibreOffice uses the actual rendering engine, so it preserves order perfectly
   */
  private async parseWithLibreOffice(buffer: Buffer): Promise<ParsedFileResult> {
    const segments: Array<{
      index: number;
      sourceText: string;
      type: 'paragraph' | 'table-cell';
      metadata?: Record<string, unknown>;
    }> = [];

    let segmentIndex = 0;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docx-parse-'));
    const inputFile = path.join(tempDir, 'input.docx');
    const outputDir = path.join(tempDir, 'output');

    try {
      // Write buffer to temporary file
      await fs.writeFile(inputFile, buffer);
      
      // CRITICAL: Create output directory before LibreOffice conversion
      // LibreOffice doesn't create the directory automatically
      await fs.mkdir(outputDir, { recursive: true });

      // Convert DOCX to HTML using LibreOffice
      // --headless: run without GUI
      // --nodefault: don't load default template
      // --norestore: don't restore documents (prevents recovery dialogs)
      // --nolockcheck: don't check file locks
      // --invisible: run invisibly (additional to headless)
      // --convert-to html: convert to HTML format
      // --outdir: specify output directory
      // Use the found LibreOffice command
      // If stored command is just 'soffice.exe' without path, prefer full path from env
      let libreOfficeCmd = this.libreOfficeCommand || env.libreOfficePath;
      
      // If command is just 'soffice.exe' without path, use full path from env
      if ((libreOfficeCmd === 'soffice.exe' || libreOfficeCmd === 'soffice') && env.libreOfficePath) {
        libreOfficeCmd = env.libreOfficePath;
        logger.debug(
          { 
            original: this.libreOfficeCommand,
            using: libreOfficeCmd 
          },
          'Using full path from configuration instead of short command'
        );
      }
      
      logger.debug(
        { 
          inputFile, 
          outputDir, 
          command: libreOfficeCmd 
        },
        'Starting LibreOffice conversion'
      );
      
      // Escape paths properly for Windows
      const inputPath = inputFile.replace(/\\/g, '/');
      const outputPath = outputDir.replace(/\\/g, '/');
      
      // Set environment variables for headless operation
      const envVars = {
        ...process.env,
        // Force headless VCL plugin (prevents GUI dialogs)
        SAL_USE_VCLPLUGIN: 'gen',
        // Disable recovery dialogs
        SAL_DISABLE_OPENCL: '1',
      };
      
      // Use spawn with auto-confirm to handle "press Enter" prompts
      // Note: If "press Enter" still appears, it might be a recovery dialog
      // In that case, consider using -env:UserInstallation for profile isolation
      logger.debug(
        { 
          command: libreOfficeCmd,
          args: ['--headless', '--nodefault', '--norestore', '--nolockcheck', '--invisible', '--convert-to', 'html', '...', '--outdir', '...']
        },
        'Calling LibreOffice with auto-confirm for Enter prompts'
      );
      
      const result = await execLibreOfficeWithIsolatedProfile(
        libreOfficeCmd,
        [
          '--headless',
          '--nodefault',
          '--norestore',
          '--nolockcheck',
          '--invisible',
          '--convert-to',
          'html',
          inputPath,
          '--outdir',
          outputPath,
        ],
        {
          timeout: 30000,
          env: envVars,
        }
      );

      logger.debug(
        { 
          stdout: result.stdout?.substring(0, 200) || '',
          stderr: result.stderr?.substring(0, 200) || ''
        },
        'LibreOffice conversion completed'
      );

      // Find the generated HTML file
      const files = await fs.readdir(outputDir);
      const htmlFile = files.find(f => f.endsWith('.html'));
      
      if (!htmlFile) {
        throw new Error('LibreOffice did not generate HTML file');
      }

      const htmlPath = path.join(outputDir, htmlFile);
      const htmlContent = await fs.readFile(htmlPath, 'utf-8');

      // Parse HTML to extract text segments
      // LibreOffice generates HTML with proper structure, preserving order
      const htmlSegments = this.parseHtmlFromLibreOffice(htmlContent);

      for (const htmlSeg of htmlSegments) {
        if (htmlSeg.text && htmlSeg.text.trim()) {
          segments.push({
            index: segmentIndex++,
            sourceText: htmlSeg.text.trim(),
            type: htmlSeg.type,
            metadata: htmlSeg.metadata || {},
          });
        }
      }

      if (segments.length === 0) {
        throw new Error('No segments extracted from document using LibreOffice');
      }

      logger.info(
        {
          totalSegments: segments.length,
          paragraphs: segments.filter(s => s.type === 'paragraph').length,
          tableCells: segments.filter(s => s.type === 'table-cell').length,
        },
        'LibreOffice successfully parsed DOCX file'
      );

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
    } finally {
      // Clean up temporary files
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('Failed to clean up temporary files:', cleanupError);
      }
    }
  }

  /**
   * Parse HTML generated by LibreOffice to extract text segments
   * LibreOffice generates well-structured HTML that preserves document order
   * This method processes elements in the order they appear in the HTML
   */
  private parseHtmlFromLibreOffice(html: string): Array<{ text: string; type: 'paragraph' | 'table-cell'; metadata?: Record<string, unknown> }> {
    const segments: Array<{ text: string; type: 'paragraph' | 'table-cell'; metadata?: Record<string, unknown> }> = [];

    // Remove style and script tags
    let cleanHtml = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    cleanHtml = cleanHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    // Find body content (LibreOffice wraps content in body tag)
    const bodyMatch = cleanHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1] : cleanHtml;

    // Find all block-level elements (p, table) in order
    // Use a more sophisticated approach to preserve order
    const blockElementRegex = /<(p|table)[^>]*>([\s\S]*?)<\/\1>/gi;
    const elementPositions: Array<{ type: 'p' | 'table'; index: number; content: string }> = [];
    
    let match;
    while ((match = blockElementRegex.exec(bodyContent)) !== null) {
      elementPositions.push({
        type: match[1] === 'p' ? 'p' : 'table',
        index: match.index,
        content: match[2],
      });
    }

    // Sort by position to ensure correct order
    elementPositions.sort((a, b) => a.index - b.index);

    let tableIndex = 0;
    for (const element of elementPositions) {
      if (element.type === 'p') {
        // Process paragraph
        const text = this.extractTextFromHtml(element.content);
        if (text && text.trim()) {
          segments.push({
            text,
            type: 'paragraph',
          });
        }
      } else if (element.type === 'table') {
        // Process table - extract cells in order
        const tableHtml = element.content;
        // Find all table rows first
        const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
          const rowHtml = rowMatch[1];
          // Extract cells from this row
          const cellRegex = /<td[^>]*>(.*?)<\/td>/gis;
          let cellMatch;
          while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
            const cellText = this.extractTextFromHtml(cellMatch[1]);
            if (cellText && cellText.trim()) {
              segments.push({
                text: cellText,
                type: 'table-cell',
                metadata: {
                  tableIndex,
                },
              });
            }
          }
        }
        tableIndex++;
      }
    }

    // If no block elements found, try to extract any text content
    if (segments.length === 0) {
      const text = this.extractTextFromHtml(bodyContent);
      if (text && text.trim()) {
        segments.push({
          text,
          type: 'paragraph',
        });
      }
    }

    return segments;
  }

  /**
   * Extract plain text from HTML content, removing all tags
   */
  private extractTextFromHtml(html: string): string {
    // Remove all HTML tags
    let text = html.replace(/<[^>]+>/g, ' ');
    // Decode HTML entities
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/&#x([a-f\d]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    
    // Normalize whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    return text;
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
   * Extract text from a paragraph XML structure
   * Handles both standard structure and preserveOrder structure
   */
  private extractTextFromParagraph(para: any): string {
    // With preserveOrder, para might be an array: [{ 'w:r': {...} }, { 'w:pPr': {...} }]
    // Or it might be an object: { 'w:r': [...], 'w:pPr': {...} }
    let runs: any = null;
    
    if (Array.isArray(para)) {
      // Find the first item that has runs
      for (const paraItem of para) {
        if (paraItem && typeof paraItem === 'object' && 'w:r' in paraItem) {
          runs = paraItem['w:r'];
          break;
        }
      }
    } else if (para && typeof para === 'object') {
      runs = para['w:r'];
    }
    
    if (!runs) return '';
    
    const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
    
    return runArray
      .map((run: any) => {
        const textNode = run['w:t'];
        if (!textNode) return '';
        
        // Handle various text node structures
        if (Array.isArray(textNode)) {
          return textNode
            .map((t: any) => {
              if (typeof t === 'string') return t;
              if (typeof t === 'object' && t !== null) {
                return typeof t['#text'] === 'string' ? t['#text'] : '';
              }
              return '';
            })
            .join('');
        } else if (typeof textNode === 'string') {
          return textNode;
        } else if (typeof textNode === 'object' && textNode !== null) {
          return typeof textNode['#text'] === 'string' ? textNode['#text'] : '';
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  /**
   * Extract runs from a paragraph XML structure
   * Handles both standard structure and preserveOrder structure
   */
  private extractRunsFromParagraph(para: any): Array<{ text: string; properties?: Record<string, unknown> }> {
    // With preserveOrder, para might be an array: [{ 'w:r': {...} }, { 'w:pPr': {...} }]
    // Or it might be an object: { 'w:r': [...], 'w:pPr': {...} }
    let runs: any = null;
    
    if (Array.isArray(para)) {
      // Find the first item that has runs
      for (const paraItem of para) {
        if (paraItem && typeof paraItem === 'object' && 'w:r' in paraItem) {
          runs = paraItem['w:r'];
          break;
        }
      }
    } else if (para && typeof para === 'object') {
      runs = para['w:r'];
    }
    
    if (!runs) return [];
    
    const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
    
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
      
      const trimmedText = text ? text.trim() : '';
      if (!trimmedText) continue;
      
      result.push({
        text: trimmedText,
        properties: run['w:rPr'] ?? {},
      });
    }
    
    return result;
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

  async parse(buffer: Buffer): Promise<ParsedFileResult> {
    try {
      // Try LibreOffice first if enabled and available (best quality)
      if (await this.isLibreOfficeAvailable()) {
        try {
          return await this.parseWithLibreOffice(buffer);
        } catch (libreOfficeError) {
          console.warn('LibreOffice parsing failed, falling back to XML parsing:', libreOfficeError);
          // Fall through to XML parsing
        }
      }

      // Use XML parsing with preserveOrder enabled
      // This maintains the exact order of paragraphs and tables as they appear in the document
      
      const zip = await JSZip.loadAsync(buffer);
      const documentXml = await zip.file('word/document.xml')?.async('string');
      if (!documentXml) {
        throw new Error('Invalid DOCX: missing word/document.xml');
      }

      // Parse with preserveOrder: true
      // Structure can be: { 'w:document': [...] } or [{ 'w:document': [...] }]
      const parsed = this.parser.parse(documentXml);
      
      // Access document structure
      // With preserveOrder: true, root can be an array or object
      let document: any;
      
      if (Array.isArray(parsed)) {
        // Root is an array - find w:document in the array elements
        for (const item of parsed) {
          if (item && typeof item === 'object' && 'w:document' in item) {
            document = item['w:document'];
            break;
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        // Root is an object - access w:document directly
        document = parsed['w:document'];
      }
      
      if (!document || !Array.isArray(document) || document.length === 0) {
        throw new Error('Invalid DOCX: missing w:document element');
      }

      // With preserveOrder, body is in an array preserving order
      // Structure: [{ 'w:body': [{ 'w:p': {...} }, { 'w:tbl': {...} }, ...] }]
      const bodyArray = document[0]['w:body'];
      if (!bodyArray || !Array.isArray(bodyArray) || bodyArray.length === 0) {
        throw new Error('Invalid DOCX: missing or empty w:body element');
      }

      // With preserveOrder, bodyArray is an array: [{ 'w:body': [...] }]
      // bodyArray[0] contains the body object, which has the children array
      const bodyObj = bodyArray[0];
      
      // Extract the ordered children array from the body
      // With preserveOrder, the body object contains 'w:body' key with the ordered children array
      // Structure: { 'w:body': [{ 'w:p': {...} }, { 'w:tbl': {...} }, ...] }
      let bodyChildren: any[] = [];
      
      if (bodyObj && typeof bodyObj === 'object') {
        // The body object contains 'w:body' with the ordered children array
        if (bodyObj['w:body'] && Array.isArray(bodyObj['w:body'])) {
          bodyChildren = bodyObj['w:body'];
        } else {
          // Fallback: if structure is different, try to extract children directly
          // Sometimes the body object itself might be the array
          bodyChildren = bodyArray;
        }
      } else {
        // If bodyObj is not an object, bodyArray itself might be the children array
        bodyChildren = bodyArray;
      }
      
      // bodyChildren is now an array of objects like:
      // [{ 'w:p': {...} }, { 'w:tbl': {...} }, { 'w:p': {...} }]
      // This preserves the exact order from the XML
      
      const segments: DocxParagraph[] = [];
      let segmentIndex = 0;

      // Process elements in order
      for (const element of bodyChildren) {
        // Check if this is a paragraph
        if (element['w:p']) {
          const para = element['w:p'];
          const text = this.extractTextFromParagraph(para);
          if (text && text.trim()) {
            const runs = this.extractRunsFromParagraph(para);
            segments.push({
              index: segmentIndex++,
              runs,
              properties: para['w:pPr'] || {},
            });
          }
        }
        // Check if this is a table
        else if (element['w:tbl']) {
          const table = element['w:tbl'];
          const tableCells = this.extractCellsFromTable(table);
          
          for (const cell of tableCells) {
            if (cell.text && cell.text.trim()) {
              segments.push({
                index: segmentIndex++,
                runs: cell.runs,
                properties: {
                  isTableCell: true,
                  tableIndex: segments.filter(s => s.properties?.isTableCell).length,
                  cellProperties: cell.properties,
                },
              });
            }
          }
        }
      }
      
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
        return {
          index: para.index,
          sourceText: para.runs.map((r) => r.text).join(' '),
          type: (isTableCell ? 'table-cell' : 'paragraph') as 'paragraph' | 'table-cell',
          metadata: {
            runs: para.runs,
            paragraphProperties: para.properties ?? {},
            ...(isTableCell && para.properties && {
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
   */
  private extractTextFromParagraphDOM(paraElement: Element): string {
    const textNodes = paraElement.getElementsByTagNameNS(
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      't'
    );
    const texts: string[] = [];
    for (let i = 0; i < textNodes.length; i++) {
      const textNode = textNodes[i];
      if (textNode.firstChild && textNode.firstChild.nodeType === 3) { // TEXT_NODE
        texts.push(textNode.firstChild.nodeValue || '');
      }
    }
    return texts.join('');
  }

  /**
   * Extract runs with their formatting from a paragraph DOM element
   * Returns array of { run: Element, textNode: Element | null, text: string, hasFormatting: boolean }
   * Includes ALL runs, even those without text but with formatting
   */
  private extractRunsWithFormattingDOM(paraElement: Element): Array<{
    run: Element;
    textNode: Element | null;
    text: string;
    hasFormatting: boolean;
  }> {
    const runs = paraElement.getElementsByTagNameNS(
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'r'
    );
    const result: Array<{
      run: Element;
      textNode: Element | null;
      text: string;
      hasFormatting: boolean;
    }> = [];

    // CRITICAL: Process ALL runs in order to preserve the complete structure
    // This ensures we maintain ALL formatting properties (bold, italic, underline, color, size, font, etc.)
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const textNodes = run.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        't'
      );
      
      // Check if run has formatting properties (w:rPr)
      // w:rPr can contain: w:b (bold), w:i (italic), w:u (underline), w:color, w:sz (size), w:rFonts, etc.
      const rPr = run.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'rPr'
      );
      const hasFormatting = rPr.length > 0;
      
      let textNode: Element | null = null;
      let text = '';
      
      if (textNodes.length > 0) {
        textNode = textNodes[0];
        if (textNode.firstChild && textNode.firstChild.nodeType === 3) { // TEXT_NODE
          text = textNode.firstChild.nodeValue || '';
        }
      }
      
      // CRITICAL: Include ALL runs, even those without text
      // This preserves the complete structure and ALL formatting properties
      // We need to preserve runs even if they're empty, as they may have formatting
      // that will be applied when we add text to them
      result.push({
        run,
        textNode,
        text: text.trim(),
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
    const runsWithText = runsWithFormatting.filter(r => r.text.length > 0);
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
    let remainingText = newText;
    
    // Create a map to track text assignment: index in runsWithFormatting -> text to assign
    const textAssignment = new Map<number, string>();
    
    // First pass: distribute text only to runs that had text originally
    for (let i = 0; i < runsWithFormatting.length; i++) {
      const run = runsWithFormatting[i];
      
      // Skip runs without original text (they keep formatting but stay empty)
      if (run.text.length === 0) {
        continue;
      }
      
      let textForThisRun: string;
      
      // Check if this is the last run with text
      const remainingRunsWithText = runsWithFormatting.slice(i + 1).filter(r => r.text.length > 0);
      if (remainingRunsWithText.length === 0) {
        // Last run with text gets all remaining text to avoid rounding errors
        textForThisRun = remainingText;
        remainingText = '';
      } else {
        // Calculate proportional length based on original text length
        // CRITICAL: Ensure we don't divide by zero
        if (totalOriginalLength > 0) {
          const proportion = run.text.length / totalOriginalLength;
          const targetLength = Math.max(1, Math.floor(newText.length * proportion));
          textForThisRun = remainingText.substring(0, Math.min(targetLength, remainingText.length));
          remainingText = remainingText.substring(textForThisRun.length);
        } else {
          // Fallback: distribute evenly (should not happen, but safety check)
          // This should never execute because we check totalOriginalLength === 0 earlier
          const runsWithTextCount = runsWithFormatting.filter(r => r.text.length > 0).length;
          if (runsWithTextCount > 0) {
            const textPerRun = Math.floor(newText.length / runsWithTextCount);
            textForThisRun = remainingText.substring(0, textPerRun);
            remainingText = remainingText.substring(textForThisRun.length);
          } else {
            // No runs with text - put all text in first run
            textForThisRun = remainingText;
            remainingText = '';
          }
        }
      }
      
      textAssignment.set(i, textForThisRun);
    }
    
    // CRITICAL: Ensure all remaining text goes to the last run with text
    // This handles rounding errors and ensures no text is lost
    if (remainingText.length > 0) {
      // Find the last run with text and add remaining text to it
      for (let i = runsWithFormatting.length - 1; i >= 0; i--) {
        if (runsWithFormatting[i].text.length > 0) {
          const existingText = textAssignment.get(i) || '';
          textAssignment.set(i, existingText + remainingText);
          remainingText = '';
          break;
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
        // Clear existing text content and add new text
        // This preserves the textNode element and all its attributes
        while (textNode.firstChild) {
          textNode.removeChild(textNode.firstChild);
        }
        // Add new text (even if empty, to maintain structure)
        if (textForThisRun.length > 0) {
          textNode.appendChild(paraElement.ownerDocument!.createTextNode(textForThisRun));
        }
      }
      // If run has no text node and no text to add, leave it as is (preserves formatting-only runs)
    }
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
      if (paraText.trim()) {
        texts.push(paraText);
      }
    }
    return texts.join(' ');
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
    const segmentMap = new Map(options.segments.map((seg) => [seg.index, seg.targetText]));
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1404',message:'Export: DOM-based export started',data:{totalSegments:options.segments.length,segmentMapSize:segmentMap.size,segmentIndices:Array.from(segmentMap.keys()).slice(0,10),firstFewTranslations:Array.from(segmentMap.entries()).slice(0,3).map(([idx,text])=>({idx,text:text.substring(0,30),textLength:text.length}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'DOM'})}).catch(()=>{});
    // #endregion

    logger.debug({ 
      totalSegments: options.segments.length,
      segmentIndices: Array.from(segmentMap.keys()).slice(0, 10),
      firstFewTranslations: Array.from(segmentMap.entries()).slice(0, 3).map(([idx, text]) => ({ idx, text: text.substring(0, 30) }))
    }, 'Starting DOM-based export with translations');

    // Process elements in document order (same as parse method)
    let segmentIndex = 0;
    let processedParagraphs = 0;
    let processedTables = 0;
    let skippedNoText = 0;

    // Get all child nodes of body (paragraphs, tables, etc.)
    const bodyChildren = Array.from(bodyElement.childNodes).filter(
      (node) => node.nodeType === 1 // ELEMENT_NODE
    ) as Element[];

    for (const element of bodyChildren) {
      const localName = element.localName || element.nodeName.split(':').pop();
      
      // Process paragraphs
      if (localName === 'p') {
        const paraText = this.extractTextFromParagraphDOM(element);
        if (paraText && paraText.trim()) {
          const translatedText = segmentMap.get(segmentIndex);
          
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
            
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1430',message:'Export: processing paragraph DOM',data:{segmentIndex,extractedText:paraText.substring(0,50),hasTranslation:translatedText!==undefined&&translatedText!==null,translation:translatedText?.substring(0,50),runsCount:runsBefore.length,formattingInfo},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'DOM'})}).catch(()=>{});
          }
          // #endregion
          
          if (translatedText !== undefined && translatedText !== null && translatedText.trim().length > 0) {
            this.replaceTextInParagraphDOM(element, translatedText.trim());
            processedParagraphs++;
            
            // #region agent log
            if (segmentIndex < 3) {
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
              
              fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1440',message:'Export: paragraph DOM updated',data:{segmentIndex,originalText:paraText.substring(0,50),translation:translatedText.substring(0,50),verifiedText:verifyText.substring(0,50),matches:verifyText.includes(translatedText.trim().substring(0,30)),runsCountAfter:runsAfter.length,formattingInfoAfter},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'DOM'})}).catch(()=>{});
            }
            // #endregion
          }
          segmentIndex++;
        } else {
          skippedNoText++;
        }
      }
      // Process tables
      else if (localName === 'tbl') {
        processedTables++;
        const rows = element.getElementsByTagNameNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'tr'
        );
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1455',message:'Export: found table DOM',data:{tableFound:true,rowCount:rows.length,segmentIndex},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'DOM'})}).catch(()=>{});
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
            
            if (cellText && cellText.trim()) {
              const translatedText = segmentMap.get(segmentIndex);
              
              // #region agent log
              if (segmentIndex < 5) {
                fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1470',message:'Export: processing table cell DOM',data:{segmentIndex,cellText:cellText.substring(0,30),hasTranslation:translatedText!==undefined&&translatedText!==null,translation:translatedText?.substring(0,30)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'DOM'})}).catch(()=>{});
              }
              // #endregion
              
              if (translatedText !== undefined && translatedText !== null && translatedText.trim().length > 0) {
                this.replaceTextInTableCellDOM(cell, translatedText.trim());
                
                // #region agent log
                if (segmentIndex < 5) {
                  const verifyText = this.extractTextFromTableCellDOM(cell);
                  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1480',message:'Export: table cell DOM updated',data:{segmentIndex,originalText:cellText.substring(0,30),translation:translatedText.substring(0,30),verifiedText:verifyText.substring(0,30),matches:verifyText.includes(translatedText.trim().substring(0,20))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'DOM'})}).catch(()=>{});
                }
                // #endregion
              }
              segmentIndex++;
            }
          }
        }
      }
    }

    logger.info({ 
      totalSegments: segmentIndex, 
      translatedSegments: Array.from(segmentMap.keys()).length,
      processedParagraphs,
      processedTables,
      skippedNoText
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
        
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1837',message:'Export: Before serialization - formatting check',data:{formattingCheck},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'DOM'})}).catch(()=>{});
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
    
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'docx.handler.ts:1870',message:'Export: DOM serialization complete',data:{finalXmlHasTranslation,firstTranslation:firstTranslation.substring(0,30),finalXmlLength:updatedXml.length,formattingPreserved:{hasBold,hasItalic,hasUnderline,hasColor,hasSize}},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'DOM'})}).catch(()=>{});
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
