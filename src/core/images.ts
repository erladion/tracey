// Images in an item's text: where they are in the repository, and where new ones go.
// A pasted or dropped image is saved in an `images` folder beside the item and linked
// from the text by a relative path (images/REQ-07-login.png), so it shows on any git
// host and in any Markdown viewer.
import { slug } from './model';

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// The repository path an image's src points at, or null if it's on the web.
export function imagePath(itemPath: string, src: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null;
  const dir = itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/') + 1) : '';
  const clean = src.replace(/[?#].*$/, '');
  let decoded = clean;
  try {
    decoded = decodeURI(clean);
  } catch {
    // keep it as written
  }
  const out: string[] = [];
  for (const p of (decoded.startsWith('/') ? decoded.slice(1) : dir + decoded).split('/')) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.length ? out.join('/') : null;
}

// The images an item's text shows (Markdown ![alt](src) and <img src>), as repository paths.
export function imagesIn(itemPath: string, text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'(][^)]*)?\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const p = imagePath(itemPath, m[1] ?? m[2]);
    if (p) found.add(p);
  }
  return [...found];
}

// Where a new image for an item goes, before making the name unique: the item's ID,
// then the file's own name unless it's a generic one (a pasted screenshot's "image.png").
export function newImagePath(itemPath: string, itemId: string, fileName: string, type: string): { path: string; src: string } | null {
  const ext = IMAGE_TYPES[type];
  if (!ext) return null;
  const dir = itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/') + 1) : '';
  const base = slug(fileName.replace(/\.[^.]*$/, ''));
  const name = `${itemId}${base && !/^(image|screenshot|clipboard|untitled|blob)(-\d+)?$/.test(base) ? `-${base}` : ''}.${ext}`;
  return { path: `${dir}images/${name}`, src: `images/${name}` };
}

// Whether the bytes really are the image type their name says.
export function looksLike(ext: string, b: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  switch (ext) {
    case 'png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'jpg':
    case 'jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'gif':
      return starts(0x47, 0x49, 0x46, 0x38);
    case 'webp':
      return starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    default:
      return false;
  }
}
