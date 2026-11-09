import { describe, expect, it } from 'vitest';
import { desktopCommand } from '../src/backend/commandline';

describe('the desktop app’s command line', () => {
  it('opens the app with no arguments or only Chromium’s switches', () => {
    expect(desktopCommand([])).toBeNull();
    expect(desktopCommand(['--no-sandbox'])).toBeNull();
    expect(desktopCommand(['--no-sandbox', '--enable-logging'])).toBeNull();
  });

  it('runs a command, after Chromium’s switches too', () => {
    expect(desktopCommand(['import-html', 'a.htm', '--init-map', 'm.yml'])).toEqual(['import-html', 'a.htm', '--init-map', 'm.yml']);
    expect(desktopCommand(['--no-sandbox', 'check', '.'])).toEqual(['check', '.']);
    expect(desktopCommand(['export-needs', '--version', '2'])).toEqual(['export-needs', '--version', '2']);
  });

  it('says so when a command was meant but none given', () => {
    expect(desktopCommand(['a.htm', '--init-map', 'm.yml'])).toEqual(['unknown', 'a.htm', '--init-map', 'm.yml']);
    expect(desktopCommand(['--init-map', 'm.yml'])).toEqual(['unknown', '--init-map', 'm.yml']);
    expect(desktopCommand(['init-map'])).toEqual(['unknown', 'init-map']);
    expect(desktopCommand(['--help'])).toEqual(['help']);
    expect(desktopCommand(['--version'])).toEqual(['version']);
  });
});
