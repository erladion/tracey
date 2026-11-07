import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imagePath, imagesIn, newImagePath } from '../src/core/images';
import { createBackend, type RepoHost } from '../src/backend/service';
import type { JiraCredentials } from '../src/backend/jira';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('images in an item', () => {
  it('finds where an image is in the repository', () => {
    expect(imagePath('requirements/REQ-07.md', 'images/a.png')).toBe('requirements/images/a.png');
    expect(imagePath('requirements/REQ-07.md', '../shared/My%20diagram.png')).toBe('shared/My diagram.png');
    expect(imagePath('requirements/REQ-07.md', '/docs/x.png')).toBe('docs/x.png');
    expect(imagePath('requirements/REQ-07.md', 'https://example.com/x.png')).toBeNull();
    expect(imagePath('requirements/REQ-07.md', 'javascript:alert(1)')).toBeNull();
  });

  it('lists the images a text shows', () => {
    const text = '---\nid: REQ-07\n---\n![Login](images/REQ-07-login.png "The form")\n\n<img src="images/b.png">\n\n![](https://x/y.png)\n';
    expect(imagesIn('requirements/REQ-07.md', text)).toEqual(['requirements/images/REQ-07-login.png', 'requirements/images/b.png']);
  });

  it('names a new image after the item, keeping a meaningful file name', () => {
    expect(newImagePath('requirements/REQ-07.md', 'REQ-07', 'image.png', 'image/png')).toEqual({ path: 'requirements/images/REQ-07.png', src: 'images/REQ-07.png' });
    expect(newImagePath('tests/TC-101.md', 'TC-101', 'Login Screen.JPG', 'image/jpeg')?.path).toBe('tests/images/TC-101-login-screen.jpg');
    expect(newImagePath('tests/TC-101.md', 'TC-101', 'x.svg', 'image/svg+xml')).toBeNull();
  });
});

describe('adding an image', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-img-'));
    const host = { resolve: async () => dir } as unknown as RepoHost;
    return { dir, api: createBackend(host, {} as JiraCredentials) };
  };

  it('saves it, never over another file', async () => {
    const { dir, api } = setup();
    expect(await api.addImage('r', 'requirements/images/REQ-07.png', PNG.toString('base64'))).toBe('requirements/images/REQ-07.png');
    expect(await api.addImage('r', 'requirements/images/REQ-07.png', PNG.toString('base64'))).toBe('requirements/images/REQ-07-2.png');
    expect(readFileSync(join(dir, 'requirements/images/REQ-07-2.png'))).toEqual(PNG);
  });

  it('refuses what isn’t an image, or is outside the repository', async () => {
    const { api } = setup();
    await expect(api.addImage('r', 'x.png', Buffer.from('<svg/>').toString('base64'))).rejects.toThrow(/isn’t the image/);
    await expect(api.addImage('r', 'x.svg', PNG.toString('base64'))).rejects.toThrow(/Only PNG/);
    await expect(api.addImage('r', '../x.png', PNG.toString('base64'))).rejects.toThrow(/outside/);
  });
});
