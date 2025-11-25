import JSZip from 'jszip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { FileHandler, ParsedFileResult, ExportOptions } from './types';

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
  private parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  private builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });

  supports(mimeType: string | undefined, extension: string): boolean {
    return extension === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  async parse(buffer: Buffer): Promise<ParsedFileResult> {
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    if (!documentXml) {
      throw new Error('Invalid DOCX: missing word/document.xml');
    }

    const parsed = this.parser.parse(documentXml);
    const body = parsed['w:document']?.['w:body']?.['w:p'] ?? [];
    const paragraphs = Array.isArray(body) ? body : [body];

    const segments: DocxParagraph[] = [];
    let segmentIndex = 0;

    for (const para of paragraphs) {
      if (!para) continue;

      const runs = para['w:r'] ?? [];
      const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
      const textRuns = runArray
        .map((run: any) => {
          const textNode = run['w:t'];
          if (!textNode) return null;
          
          // Extract text from various possible structures
          let text: string = '';
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
            // Handle object with #text property
            if (typeof textNode['#text'] === 'string') {
              text = textNode['#text'];
            } else if (typeof textNode['#text'] === 'object' && textNode['#text'] !== null) {
              // Handle nested structures
              const nestedText = textNode['#text'];
              if (Array.isArray(nestedText)) {
                text = nestedText
                  .map((nt: any) => (typeof nt === 'string' ? nt : ''))
                  .join('');
              } else if (typeof nestedText === 'string') {
                text = nestedText;
              }
            }
          }
          
          // Ensure text is a string and trim it
          const trimmedText = typeof text === 'string' ? text.trim() : '';
          if (!trimmedText) return null;
          
          return {
            text: trimmedText,
            properties: run['w:rPr'] ?? {},
          };
        })
        .filter((r): r is { text: string; properties: Record<string, unknown> } => r !== null && r.text.length > 0);

      if (textRuns.length === 0) continue;

      const fullText = textRuns.map((r: any) => r.text).join(' ').trim();
      if (!fullText) continue;

      segments.push({
        index: segmentIndex++,
        runs: textRuns,
        properties: para['w:pPr'] ?? {},
      });
    }

    const structure: DocxStructure = {
      paragraphs: segments,
    };

    const parsedSegments = segments.map((para) => ({
      index: para.index,
      sourceText: para.runs.map((r) => r.text).join(' '),
      metadata: {
        runs: para.runs,
        paragraphProperties: para.properties,
      },
    }));

    return {
      segments: parsedSegments,
      metadata: {
        type: 'docx',
        paragraphCount: segments.length,
      },
      totalWords: parsedSegments.reduce((acc, seg) => acc + seg.sourceText.split(/\s+/).filter(Boolean).length, 0),
      originalStructure: structure,
    };
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

    const parsed = this.parser.parse(documentXml);
    const body = parsed['w:document']?.['w:body']?.['w:p'] ?? [];
    const paragraphs = Array.isArray(body) ? body : [body];

    const segmentMap = new Map(options.segments.map((seg) => [seg.index, seg.targetText]));

    let segmentIndex = 0;
    for (const para of paragraphs) {
      if (!para) continue;

      const runs = para['w:r'] ?? [];
      const runArray = Array.isArray(runs) ? runs : runs ? [runs] : [];
      const hasText = runArray.some((run: any) => run['w:t']);

      if (!hasText) continue;

      const translatedText = segmentMap.get(segmentIndex);
      if (translatedText !== undefined) {
        const firstRun = runArray.find((run: any) => run['w:t']);
        if (firstRun) {
          const firstRunProps = firstRun['w:rPr'] ?? {};
          para['w:r'] = [
            {
              'w:rPr': firstRunProps,
              'w:t': { '@_xml:space': 'preserve', '#text': translatedText },
            },
          ];
        }
      }
      segmentIndex++;
    }

    parsed['w:document']['w:body']['w:p'] = paragraphs;
    const updatedXml = this.builder.build(parsed);

    zip.file('word/document.xml', updatedXml);
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }
}
