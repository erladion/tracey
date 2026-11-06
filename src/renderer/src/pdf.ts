// Saving a document (HTML) as PDF: the desktop app makes the file itself; in a browser,
// the print dialog does ("Save as PDF").
import { api, fileUrl, platform } from './api';
import { notify } from './notify';

export async function savePdf(html: string, fileName: string): Promise<void> {
  if (platform === 'desktop') {
    try {
      const path = await api.exportPdf(html, fileName);
      if (path) notify(`Saved ${path}`, 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    }
    return;
  }
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  frame.srcdoc = html;
  document.body.appendChild(frame);
  await new Promise<void>((resolve) => (frame.onload = () => resolve()));
  // The browser suggests the page's title as the file name.
  const title = document.title;
  document.title = fileName.replace(/\.pdf$/i, '');
  try {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
  } finally {
    document.title = title;
    setTimeout(() => frame.remove(), 1000);
  }
}

// An image in an item's text, as a URL the document can load.
export function imageUrl(repo: string, itemPath: string, src: string): string {
  const dir = itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/') + 1) : '';
  const out: string[] = [];
  for (const p of (src.startsWith('/') ? src.slice(1) : dir + src).split('/')) p === '..' ? out.pop() : p !== '.' && out.push(p);
  return new URL(fileUrl(repo, out.join('/')), location.href).href;
}
