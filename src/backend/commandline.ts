// The desktop app's command line: one of the commands (run without a window), help, the
// version, a mistyped command, or nothing (the app opens). Chromium's switches may come first.
export const COMMANDS = ['check', 'import-reqif', 'import-html', 'export-needs', 'import-needs'];

// Options only the commands take: given without a command, a command was meant.
const COMMAND_OPTION = /^--(init-map|map|into|dry-run|force|out|project|type|link|keep-fields)(=|$)/;

export function desktopCommand(argv: string[]): string[] | null {
  const at = argv.findIndex((a) => !a.startsWith('-'));
  if (at >= 0 && COMMANDS.includes(argv[at])) return argv.slice(at);
  if (argv[at] === 'help' || argv.some((a) => a === '--help' || a === '-h')) return ['help'];
  if (argv[at] === 'version' || argv.some((a) => a === '--version' || a === '-v')) return ['version'];
  // Said from what came first: the command option, or the word.
  const option = argv.findIndex((a) => COMMAND_OPTION.test(a));
  if (option >= 0 && (at < 0 || option < at)) return ['unknown', ...argv.slice(option)];
  if (at >= 0) return ['unknown', ...argv.slice(at)];
  return null;
}

export function helpText(self: string): string {
  return `Run without arguments, ${self} opens the app. With a command, it does that and exits:

  Validate a repository (for CI):
    ${self} check [DIR]
  Import from DOORS: write a map to edit, try it, then import:
    ${self} import-reqif EXPORT.reqifz… --init-map MAP.yml
    ${self} import-reqif EXPORT.reqifz… --map MAP.yml [--into DIR] [--dry-run] [--force]
  The same for modules exported as HTML:
    ${self} import-html MODULE.htm… --init-map MAP.yml
    ${self} import-html MODULE.htm… --map MAP.yml [--into DIR] [--dry-run] [--force]
  Sphinx-needs:
    ${self} export-needs [DIR] [--out needs.json]
    ${self} import-needs NEEDS.json [--into DIR] [--dry-run]
  The version:
    ${self} --version`;
}
