import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { FileHandler, ParsedFileResult, ExportOptions } from './types';

type XliffTag = {
  type: 'g' | 'x' | 'ph' | 'bx' | 'ex' | 'bpt' | 'ept' | 'it' | 'mrk';
  id?: string;
  dataRef?: string;
  original?: string;
  content?: string;
};

type XliffUnit = {
  id: string;
  source: string;
  target?: string;
  sourceTags?: XliffTag[];
  targetTags?: XliffTag[];
  metadata?: Record<string, unknown>;
};

type XliffStructure = {
  version: '1.2' | '2.0';
  units: XliffUnit[];
  fileAttributes?: Record<string, unknown>;
};

export class XliffHandler implements FileHandler {
  private parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, trimValues: false });
  private builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, preserveOrder: true });

  supports(_mimeType: string | undefined, extension: string): boolean {
    return extension === '.xliff' || extension === '.xlf';
  }

  private extractTags(text: string): { cleanText: string; tags: XliffTag[] } {
    const tags: XliffTag[] = [];
    let cleanText = text;
    const tagPattern = /<(\/?)(g|x|ph|bx|ex|bpt|ept|it|mrk)(?:\s+([^>]*))?\/?>/gi;

    let match;
    const tagMatches: Array<{ full: string; type: string; attrs: string; isClosing: boolean; index: number }> = [];
    while ((match = tagPattern.exec(text)) !== null) {
      tagMatches.push({
        full: match[0],
        type: match[2].toLowerCase(),
        attrs: match[3] || '',
        isClosing: match[1] === '/',
        index: match.index,
      });
    }

    let offset = 0;
    for (const tagMatch of tagMatches) {
      if (tagMatch.isClosing) continue;

      const attrs: Record<string, string> = {};
      const attrPattern = /(\w+)=["']([^"']+)["']/g;
      let attrMatch;
      while ((attrMatch = attrPattern.exec(tagMatch.attrs)) !== null) {
        attrs[attrMatch[1]] = attrMatch[2];
      }

      tags.push({
        type: tagMatch.type as XliffTag['type'],
        id: attrs.id,
        dataRef: attrs['dataRef'] || attrs['data-ref'],
        original: attrs.original,
        content: attrs.content,
      });

      cleanText = cleanText.replace(tagMatch.full, `[TAG_${tags.length - 1}]`);
      offset += tagMatch.full.length - `[TAG_${tags.length - 1}]`.length;
    }

    return { cleanText, tags };
  }

  private restoreTags(text: string, tags: XliffTag[]): string {
    let restored = text;
    for (let i = tags.length - 1; i >= 0; i--) {
      const tag = tags[i];
      const placeholder = `[TAG_${i}]`;
      if (!restored.includes(placeholder)) continue;

      const attrs: string[] = [];
      if (tag.id) attrs.push(`id="${tag.id}"`);
      if (tag.dataRef) attrs.push(`dataRef="${tag.dataRef}"`);
      if (tag.original) attrs.push(`original="${tag.original}"`);
      if (tag.content) attrs.push(`content="${tag.content}"`);

      const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
      const openTag = `<${tag.type}${attrStr}>`;
      const closeTag = `</${tag.type}>`;

      restored = restored.replace(placeholder, `${openTag}${closeTag}`);
    }
    return restored;
  }

  private parseXliff12(parsed: any): XliffUnit[] {
    const file = parsed.xliff?.file;
    if (!file) return [];

    const body = file.body || file['trans-unit'] ? { 'trans-unit': file['trans-unit'] || file.body?.['trans-unit'] } : {};
    const units = body['trans-unit'] ?? [];
    const unitArray = Array.isArray(units) ? units : units ? [units] : [];

    return unitArray.map((unit: any, index: number) => {
      const sourceText = typeof unit.source === 'string' ? unit.source : unit.source?.['#text'] ?? '';
      const targetText = typeof unit.target === 'string' ? unit.target : unit.target?.['#text'] ?? '';

      const { cleanText: cleanSource, tags: sourceTags } = this.extractTags(sourceText);
      const { cleanText: cleanTarget, tags: targetTags } = targetText ? this.extractTags(targetText) : { cleanText: '', tags: [] };

      return {
        id: unit['@_id'] ?? `unit-${index}`,
        source: cleanSource,
        target: cleanTarget || undefined,
        sourceTags,
        targetTags,
        metadata: {
          'trans-unit': unit,
        },
      };
    });
  }

  private parseXliff20(parsed: any): XliffUnit[] {
    const file = parsed.xliff?.file;
    if (!file) return [];

    const units = file.unit ?? [];
    const unitArray = Array.isArray(units) ? units : units ? [units] : [];

    return unitArray.map((unit: any, index: number) => {
      const segment = unit.segment ?? {};
      const source = segment.source ?? {};
      const target = segment.target ?? {};

      const sourceText = typeof source === 'string' ? source : source['#text'] ?? '';
      const targetText = typeof target === 'string' ? target : target['#text'] ?? '';

      const { cleanText: cleanSource, tags: sourceTags } = this.extractTags(sourceText);
      const { cleanText: cleanTarget, tags: targetTags } = targetText ? this.extractTags(targetText) : { cleanText: '', tags: [] };

      return {
        id: unit['@_id'] ?? `unit-${index}`,
        source: cleanSource,
        target: cleanTarget || undefined,
        sourceTags,
        targetTags,
        metadata: {
          unit,
        },
      };
    });
  }

  async parse(buffer: Buffer): Promise<ParsedFileResult> {
    const xml = buffer.toString('utf-8');
    const parsed = this.parser.parse(xml);

    const version = parsed.xliff?.['@_version'] ?? '1.2';
    const isV2 = version.startsWith('2');

    const units = isV2 ? this.parseXliff20(parsed) : this.parseXliff12(parsed);

    const segments = units.map((unit, index) => ({
      index,
      sourceText: unit.source,
      targetMt: unit.target,
      tags: unit.sourceTags?.map((tag) => JSON.stringify(tag)),
      metadata: {
        unitId: unit.id,
        sourceTags: unit.sourceTags,
        targetTags: unit.targetTags,
        xliffVersion: version,
        originalUnit: unit.metadata,
      },
    }));

    const structure: XliffStructure = {
      version: isV2 ? '2.0' : '1.2',
      units,
      fileAttributes: parsed.xliff?.file?.['@_'] ?? {},
    };

    return {
      segments,
      metadata: {
        type: 'xliff',
        version: isV2 ? '2.0' : '1.2',
        unitCount: segments.length,
      },
      totalWords: segments.reduce((acc, seg) => acc + seg.sourceText.split(/\s+/).filter(Boolean).length, 0),
      originalStructure: structure,
    };
  }

  async export(options: ExportOptions): Promise<Buffer> {
    if (!options.originalBuffer) {
      throw new Error('Original XLIFF buffer required for export');
    }

    const xml = options.originalBuffer.toString('utf-8');
    const parsed = this.parser.parse(xml);
    const version = parsed.xliff?.['@_version'] ?? '1.2';
    const isV2 = version.startsWith('2');

    const segmentMap = new Map(options.segments.map((seg) => [seg.index, seg.targetText]));

    if (isV2) {
      const units = parsed.xliff?.file?.unit ?? [];
      const unitArray = Array.isArray(units) ? units : units ? [units] : [];

      unitArray.forEach((unit: any, index: number) => {
        const translatedText = segmentMap.get(index);
        if (translatedText !== undefined && unit.segment) {
          const sourceTags = unit.segment.source?.['#text'] ? this.extractTags(unit.segment.source['#text']).tags : [];
          const restored = this.restoreTags(translatedText, sourceTags);
          unit.segment.target = { '#text': restored };
        }
      });
    } else {
      const units = parsed.xliff?.file?.['trans-unit'] ?? parsed.xliff?.file?.body?.['trans-unit'] ?? [];
      const unitArray = Array.isArray(units) ? units : units ? [units] : [];

      unitArray.forEach((unit: any, index: number) => {
        const translatedText = segmentMap.get(index);
        if (translatedText !== undefined) {
          const sourceText = typeof unit.source === 'string' ? unit.source : unit.source?.['#text'] ?? '';
          const sourceTags = this.extractTags(sourceText).tags;
          const restored = this.restoreTags(translatedText, sourceTags);
          unit.target = { '#text': restored };
        }
      });
    }

    const updatedXml = this.builder.build(parsed);
    return Buffer.from(updatedXml, 'utf-8');
  }
}
