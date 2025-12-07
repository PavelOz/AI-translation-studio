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

  async export(options: ExportOptions): Promise<Buffer> {
    if (!options.originalBuffer) {
      throw new Error('Original DOCX buffer required for export');
    }

    const zip = await JSZip.loadAsync(options.originalBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    if (!documentXml) {
      throw new Error('Invalid DOCX: missing word/document.xml');
    }

    // Parse with preserveOrder: true to maintain element order
    const parsed = this.parser.parse(documentXml);
    
    // Access document structure
    // With preserveOrder: true, the root can be an array: [{ 'w:document': [...] }]
    // Or it can be an object: { 'w:document': [...] }
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
      // Log for debugging
      const parsedKeys = parsed && typeof parsed === 'object' 
        ? (Array.isArray(parsed) ? parsed.map((_, i) => String(i)) : Object.keys(parsed))
        : [];
      logger.error({ 
        parsedKeys,
        parsedType: Array.isArray(parsed) ? 'array' : typeof parsed,
        documentExists: !!document,
        documentIsArray: Array.isArray(document),
        documentLength: Array.isArray(document) ? document.length : 0,
        firstElement: Array.isArray(parsed) && parsed[0] ? Object.keys(parsed[0]) : []
      }, 'Failed to access w:document in export');
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
    
    // Extract the ordered children array from the body - same as parse method
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

    const segmentMap = new Map(options.segments.map((seg) => [seg.index, seg.targetText]));
    
    logger.debug({ 
      totalSegments: options.segments.length,
      segmentIndices: Array.from(segmentMap.keys()).slice(0, 10),
      firstFewTranslations: Array.from(segmentMap.entries()).slice(0, 3).map(([idx, text]) => ({ idx, text: text.substring(0, 30) })),
      bodyChildrenLength: bodyChildren.length,
      bodyChildrenTypes: bodyChildren.slice(0, 5).map(el => Object.keys(el))
    }, 'Starting export with translations');
    
    // Helper function to update text in runs while preserving ALL formatting
    // Modifies the runs array in place to ensure changes are reflected in the parsed structure
    const updateRunsWithText = (runs: any[], translatedText: string): void => {
      const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
      
      // Find the first text run (run that contains w:t element)
      const firstTextRun = runArray.find((run: any) => {
        const textNode = run['w:t'];
        return textNode && (
          typeof textNode === 'string' ||
          (typeof textNode === 'object' && (textNode['#text'] !== undefined || Array.isArray(textNode)))
        );
      });
      
      if (!firstTextRun) {
        return; // No text run found, nothing to update
      }
      
      // Modify the text node in place to preserve the exact structure
      const textNode = firstTextRun['w:t'];
      
      if (typeof textNode === 'string') {
        // If it's a string, convert to object with #text (preserveOrder format)
        firstTextRun['w:t'] = { '#text': translatedText };
      } else if (typeof textNode === 'object' && textNode !== null) {
        // Modify the existing object in place
        if (textNode['#text'] !== undefined) {
          textNode['#text'] = translatedText;
        } else {
          // Create new structure preserving attributes
          const newTextNode: any = { '#text': translatedText };
          // Copy any attributes
          for (const key in textNode) {
            if (key.startsWith('@_')) {
              newTextNode[key] = textNode[key];
            }
          }
          firstTextRun['w:t'] = newTextNode;
        }
      }
      
      // Remove other text runs (we only keep the first one with translated text)
      // This simplifies the structure while preserving formatting
      const textRunIndices: number[] = [];
      for (let i = 0; i < runArray.length; i++) {
        const run = runArray[i];
        if (run !== firstTextRun && run['w:t']) {
          const nodeText = run['w:t'];
          const hasText = typeof nodeText === 'string' || 
            (typeof nodeText === 'object' && nodeText?.['#text']);
          if (hasText) {
            textRunIndices.push(i);
          }
        }
      }
      
      // Remove text runs after the first one (in reverse order to maintain indices)
      for (let i = textRunIndices.length - 1; i >= 0; i--) {
        runArray.splice(textRunIndices[i], 1);
      }
    };
    
    // Update elements in the correct order (as they appear in bodyChildren)
    // IMPORTANT: bodyChildren contains references to objects in the parsed structure,
    // so modifications here will be reflected in the parsed structure
    let segmentIndex = 0;
    let processedParagraphs = 0;
    let processedTables = 0;
    let skippedNoText = 0;
    
    logger.debug({ bodyChildrenCount: bodyChildren.length }, 'Processing body children');
    
    for (const element of bodyChildren) {
      const elementKeys = Object.keys(element);
      logger.debug({ elementKeys, hasWp: !!element['w:p'], hasWtbl: !!element['w:tbl'] }, 'Processing element');
      
      // Check if this is a paragraph
      if (element['w:p']) {
        processedParagraphs++;
        const para = element['w:p'];
        
        // Use the same extraction logic as parse method
        // This ensures we match segments correctly
        const text = this.extractTextFromParagraph(para);
        
        // Only process paragraphs that have text (same as parse method)
        if (text && text.trim()) {
          const translatedText = segmentMap.get(segmentIndex);
          
          // Use translation if available and not empty, otherwise keep original
          // Empty string means keep original, undefined/null means no translation provided
          const shouldUpdate = translatedText !== undefined && 
                              translatedText !== null && 
                              translatedText.trim().length > 0;
          
          if (segmentIndex < 3) {
            logger.debug({ 
              segmentIndex, 
              hasTranslation: translatedText !== undefined && translatedText !== null,
              translationEmpty: translatedText !== undefined && translatedText !== null && translatedText.trim().length === 0,
              shouldUpdate,
              translation: translatedText?.substring(0, 50),
              extractedText: text.substring(0, 50),
              paraIsArray: Array.isArray(para),
              paraKeys: Array.isArray(para) ? para.map((p: any) => p && typeof p === 'object' ? Object.keys(p) : typeof p) : Object.keys(para)
            }, 'Processing paragraph segment');
          }
          
          if (shouldUpdate) {
            // With preserveOrder, para structure can vary
            // We need to find and update the runs directly in the structure
            let updated = false;
            let runsFound = false;
            
            if (Array.isArray(para)) {
              // Para is an array: [{ 'w:r': {...} }, { 'w:pPr': {...} }]
              // Find the first item that has runs
              for (const paraItem of para) {
                if (paraItem && typeof paraItem === 'object' && 'w:r' in paraItem) {
                  runsFound = true;
                  const runs = paraItem['w:r'];
                  const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
                  
                  if (segmentIndex < 3) {
                    logger.debug({ 
                      segmentIndex,
                      runCount: runArray.length,
                      firstRunText: runArray[0]?.['w:t'] ? (typeof runArray[0]['w:t'] === 'string' ? runArray[0]['w:t'].substring(0, 30) : runArray[0]['w:t']?.['#text']?.substring(0, 30)) : 'none'
                    }, 'Found runs in array structure');
                  }
                  
                  // Update runs with translated text
                  updateRunsWithText(runArray, translatedText.trim());
                  
                  // Ensure the runs are stored back correctly
                  if (!Array.isArray(runs)) {
                    paraItem['w:r'] = runArray;
                  }
                  
                  // Verify update was applied
                  const verifyRuns = paraItem['w:r'];
                  const verifyRunArray = Array.isArray(verifyRuns) ? verifyRuns : verifyRuns ? [verifyRuns] : [];
                  const verifyTextNode = verifyRunArray.find((r: any) => r?.['w:t'])?.['w:t'];
                  const verifyText = typeof verifyTextNode === 'string' 
                    ? verifyTextNode 
                    : verifyTextNode?.['#text'] || '';
                  
                  if (segmentIndex < 3) {
                    logger.debug({ 
                      segmentIndex,
                      originalText: text.substring(0, 50),
                      translation: translatedText.substring(0, 50),
                      verifiedText: verifyText.substring(0, 50),
                      match: verifyText === translatedText.trim() || verifyText.includes(translatedText.trim().substring(0, 30))
                    }, 'Updated runs in array structure');
                  }
                  
                  updated = true;
                  break;
                }
              }
            } else if (para && typeof para === 'object') {
              // Para is an object: { 'w:r': [...], 'w:pPr': {...} }
              const runs = para['w:r'];
              if (runs !== undefined) {
                runsFound = true;
                const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
                
                if (segmentIndex < 3) {
                  logger.debug({ 
                    segmentIndex,
                    runCount: runArray.length,
                    firstRunText: runArray[0]?.['w:t'] ? (typeof runArray[0]['w:t'] === 'string' ? runArray[0]['w:t'].substring(0, 30) : runArray[0]['w:t']?.['#text']?.substring(0, 30)) : 'none'
                  }, 'Found runs in object structure');
                }
                
                updateRunsWithText(runArray, translatedText.trim());
                if (!Array.isArray(runs)) {
                  para['w:r'] = runArray;
                }
                
                // Verify update was applied
                const verifyRuns = para['w:r'];
                const verifyRunArray = Array.isArray(verifyRuns) ? verifyRuns : verifyRuns ? [verifyRuns] : [];
                const verifyTextNode = verifyRunArray.find((r: any) => r?.['w:t'])?.['w:t'];
                const verifyText = typeof verifyTextNode === 'string' 
                  ? verifyTextNode 
                  : verifyTextNode?.['#text'] || '';
                
                if (segmentIndex < 3) {
                  logger.debug({ 
                    segmentIndex,
                    originalText: text.substring(0, 50),
                    translation: translatedText.substring(0, 50),
                    verifiedText: verifyText.substring(0, 50),
                    match: verifyText === translatedText.trim() || verifyText.includes(translatedText.trim().substring(0, 30))
                  }, 'Updated runs in object structure');
                }
                
                updated = true;
              }
            }
            
            if (!runsFound && segmentIndex < 3) {
              logger.warn({ 
                segmentIndex, 
                paraStructure: Array.isArray(para) ? 'array' : typeof para,
                paraKeys: Array.isArray(para) 
                  ? para.map((p: any) => p && typeof p === 'object' ? Object.keys(p) : typeof p)
                  : Object.keys(para || {})
              }, 'Could not find runs in paragraph structure');
            } else if (!updated && segmentIndex < 3) {
              logger.warn({ segmentIndex, runsFound }, 'Found runs but update failed');
            }
          } else {
            // No translation or empty translation - keep original text
            if (segmentIndex < 3) {
              logger.debug({ 
                segmentIndex, 
                reason: translatedText === undefined || translatedText === null 
                  ? 'no translation provided' 
                  : 'translation is empty - keeping original',
                translationValue: translatedText
              }, 'Keeping original text');
            }
          }
          
          // Always increment segmentIndex for paragraphs with text
          segmentIndex++;
        } else {
          // Skip empty paragraphs (same as parse method)
          skippedNoText++;
        }
        
        continue; // Move to next element

      }
      // Check if this is a table
      else if (element['w:tbl']) {
        processedTables++;
        const table = element['w:tbl'];
        const rows = table['w:tr'] ?? [];
        const rowArray = Array.isArray(rows) ? rows : rows ? [rows] : [];
        
        for (const row of rowArray) {
          if (!row) continue;
          
          const cells = row['w:tc'] ?? [];
          const cellArray = Array.isArray(cells) ? cells : cells ? [cells] : [];
          
          for (const cell of cellArray) {
            if (!cell) continue;
            
            const cellParagraphs = cell['w:p'] ?? [];
            const cellParaArray = Array.isArray(cellParagraphs) ? cellParagraphs : cellParagraphs ? [cellParagraphs] : [];
            
            for (const cellPara of cellParaArray) {
              if (!cellPara) continue;
              
              // Use the same extraction logic as parse method
              const cellText = this.extractTextFromParagraph(cellPara);
              
              // Only process cell paragraphs that have text (same as parse method)
              if (cellText && cellText.trim()) {
                const translatedText = segmentMap.get(segmentIndex);
                
                // Use translation if available and not empty, otherwise keep original
                const shouldUpdate = translatedText !== undefined && 
                                    translatedText !== null && 
                                    translatedText.trim().length > 0;
                
                if (shouldUpdate) {
                  // Get the actual runs array from the cell paragraph
                  const actualCellRuns = cellPara['w:r'] ?? [];
                  const actualCellRunArray = Array.isArray(actualCellRuns) ? actualCellRuns : actualCellRuns ? [actualCellRuns] : [];
                  
                  // Update runs with translated text
                  updateRunsWithText(actualCellRunArray, translatedText.trim());
                  
                  // Ensure cellPara['w:r'] points to the array
                  if (!Array.isArray(actualCellRuns)) {
                    cellPara['w:r'] = actualCellRunArray;
                  }
                }
                // If translation is empty or not provided, keep original text (do nothing)
                
                // Always increment segmentIndex for cell paragraphs with text
                segmentIndex++;
              }
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
      skippedNoText,
      bodyChildrenCount: bodyChildren.length,
      segmentsWithTranslations: Array.from(segmentMap.entries())
        .filter(([idx, text]) => text && text.trim().length > 0)
        .length
    }, 'Finished updating document with translations');

    // Rebuild XML maintaining the ordered structure
    // The parsed structure already has preserveOrder enabled, so we just rebuild it
    const updatedXml = this.builder.build(parsed);
    
    // Verify translations were applied by checking the XML
    if (segmentIndex > 0 && segmentMap.size > 0) {
      const firstTranslation = Array.from(segmentMap.entries()).find(([idx, text]) => text && text.trim().length > 0);
      if (firstTranslation) {
        const [idx, text] = firstTranslation;
        const textInXml = updatedXml.includes(text.substring(0, 30));
        logger.debug({ 
          segmentIndex: idx,
          translation: text.substring(0, 50),
          foundInXml: textInXml
        }, 'Verifying translation in rebuilt XML');
        
        if (!textInXml && idx < 3) {
          logger.warn({ 
            segmentIndex: idx,
            translation: text.substring(0, 50),
            xmlSample: updatedXml.substring(0, 500)
          }, 'Translation not found in rebuilt XML - possible structure issue');
        }
      }
    }

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
