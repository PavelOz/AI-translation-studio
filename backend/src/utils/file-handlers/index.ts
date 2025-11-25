import path from 'path';
import { DocxHandler } from './docx.handler';
import { XliffHandler } from './xliff.handler';
import { XlsxHandler } from './xlsx.handler';
import type { FileHandler } from './types';

const handlers: FileHandler[] = [new DocxHandler(), new XliffHandler(), new XlsxHandler()];

export const resolveHandler = (filename: string, mimetype?: string) => {
  const extension = path.extname(filename).toLowerCase();
  return handlers.find((handler) => handler.supports(mimetype, extension));
};

