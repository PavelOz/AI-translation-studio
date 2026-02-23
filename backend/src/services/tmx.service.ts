import { getDocument } from './document.service';
import { getDocumentSegments } from './segment.service';
import { stripTags } from '../utils/segmentation';
import { ApiError } from '../utils/apiError';

/**
 * Normalize locale to ISO xx-XX for TMX xml:lang / srclang.
 * If only language is given (e.g. 'en'), default to en-GB for our projects.
 */
export function normalizeLocale(
  locale: string,
  options?: { defaultEn?: string },
): string {
  if (!locale || typeof locale !== 'string') return 'en-GB';
  const trimmed = locale.trim();
  if (/^[a-z]{2}-[A-Z]{2}$/i.test(trimmed)) {
    return trimmed.slice(0, 2).toLowerCase() + '-' + trimmed.slice(3, 5).toUpperCase();
  }
  const lang = trimmed.slice(0, 2).toLowerCase();
  if (lang === 'en') return options?.defaultEn ?? 'en-GB';
  if (trimmed.length <= 2) return `${lang}-${lang.toUpperCase()}`;
  const rest = trimmed.slice(2).replace(/^[-_\s]+/, '').slice(0, 2).toUpperCase();
  return rest ? `${lang}-${rest}` : `${lang}-${lang.toUpperCase()}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Export document segments to TMX 1.4 (Translation Memory eXchange) for Trados.
 * Uses sourceLocale/targetLocale from Document; strips {{n}}/{{/n}} tags for clean text.
 * Final segments (targetFinal) are those already processed with Document DNA (Bay, SA, VT, etc.).
 */
export async function exportDocumentToTmx(documentId: string): Promise<Buffer> {
  const document = await getDocument(documentId);
  if (!document) throw ApiError.notFound('Document not found');

  const { segments } = await getDocumentSegments(documentId, 1, 10000);
  const srclang = normalizeLocale(document.sourceLocale);
  const tgtLang = normalizeLocale(document.targetLocale);

  const tuElements = segments
    .map((seg) => {
      const source = escapeXml(stripTags(seg.sourceText));
      const target = escapeXml(
        stripTags(seg.targetFinal ?? seg.targetMt ?? seg.sourceText),
      );
      return `    <tu><tuv xml:lang="${srclang}"><seg>${source}</seg></tuv><tuv xml:lang="${tgtLang}"><seg>${target}</seg></tuv></tu>`;
    })
    .join('\n');

  const tmx = `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <header creationtool="AI Translation Studio" srclang="${srclang}" adminlang="${tgtLang}" datatype="PlainText" segtype="paragraph"/>
  <body>
${tuElements}
  </body>
</tmx>`;

  return Buffer.from(tmx, 'utf-8');
}
