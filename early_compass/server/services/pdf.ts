/**
 * Trimming the rendered report. The "short" report staff can send parents is literally the first
 * pages of the full one, so both always say exactly the same thing on the pages they share.
 */
import { PDFDocument } from 'pdf-lib';

export async function pageCount(pdf: Buffer): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

/** The first `count` pages, or the document itself when it is no longer than that. */
export async function firstPages(pdf: Buffer, count: number): Promise<Buffer> {
  const source = await PDFDocument.load(pdf);
  if (source.getPageCount() <= count) return pdf;
  const trimmed = await PDFDocument.create();
  const title = source.getTitle();
  const author = source.getAuthor();
  if (title) trimmed.setTitle(title);
  if (author) trimmed.setAuthor(author);
  for (const page of await trimmed.copyPages(source, Array.from({ length: count }, (_, i) => i))) trimmed.addPage(page);
  return Buffer.from(await trimmed.save());
}
