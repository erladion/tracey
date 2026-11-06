// The files of a new project: settings, a README, and (optionally) examples.
import { SAMPLE_CONFIG } from './config';

const req = (id: string, title: string, status: string, components: string[], jira: string[], text: string) =>
  `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\ncomponents: [${components.join(', ')}]\n${jira.length ? `jira: [${jira.join(', ')}]\n` : ''}---\n${text}\n`;

const tc = (id: string, title: string, verifies: string[], components: string[], steps: string[], expected: string) =>
  `---\nid: ${id}\ntitle: ${title}\nstatus: ready\nverifies: [${verifies.join(', ')}]\ncomponents: [${components.join(', ')}]\n---\n## Steps\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n## Expected\n\n${expected}\n`;

const README = `# Requirements and test cases

Requirements live in \`requirements/\` and test cases in \`tests/\`, one Markdown file
each, with YAML front matter. IDs (\`REQ-07\`, \`TC-102\`) are set in the front matter,
never taken from file names, so files can be renamed freely.

A test case lists the requirements it verifies:

\`\`\`yaml
verifies: [REQ-07]
\`\`\`

Settings, statuses and the component map are in \`trace.yml\`.
`;

const EXAMPLE_CONFIG = SAMPLE_CONFIG.replace(
  /components:\n[\s\S]*?(?=# jira)/,
  `components:
  payments: { name: Payments, paths: ["src/payments/**"] }
  billing: { name: Billing, paths: ["src/billing/**"] }
  export: { name: Export, paths: ["src/export/**"] }
  auth: { name: Auth, paths: ["src/auth/**"] }
  audit: { name: Audit, paths: ["src/audit/**"] }
`,
);

export function projectFiles(examples: boolean): Record<string, string> {
  if (!examples)
    return {
      'trace.yml': SAMPLE_CONFIG,
      'README.md': README,
      'requirements/.gitkeep': '',
      'tests/.gitkeep': '',
    };
  return {
    'trace.yml': EXAMPLE_CONFIG,
    'README.md': README,
    'requirements/REQ-07-payment-retry.md': req(
      'REQ-07',
      'Payment retry after gateway timeout',
      'approved',
      ['payments'],
      ['PROJ-466'],
      'When the payment gateway times out, the system retries\nup to 3 times with increasing delay before failing.\n\n| Attempt | Delay |\n| --- | ---: |\n| 1 | 1 s |\n| 2 | 4 s |\n| 3 | 16 s |',
    ),
    'requirements/REQ-12-regional-tax.md': req('REQ-12', 'Invoice totals include regional tax', 'approved', ['billing'], ['PROJ-481'], 'Invoice totals **include** the tax of the region the customer is billed in.'),
    'requirements/REQ-19-pdf-export.md': req('REQ-19', 'Export invoices as PDF', 'review', ['export'], ['PROJ-475'], 'A user can download any invoice as a PDF that matches the on-screen invoice.'),
    'requirements/REQ-22-session-timeout.md': req('REQ-22', 'Session expires after 30 min idle', 'approved', ['auth'], [], 'A session with no activity for 30 minutes ends, and the user must sign in again.'),
    'requirements/REQ-31-audit-roles.md': req('REQ-31', 'Audit log records user role changes', 'approved', ['audit'], [], 'Every change to a user’s role is recorded in the audit log with who made it and when.'),
    'requirements/REQ-40-sso.md': req('REQ-40', 'Users sign in with company SSO', 'draft', ['auth'], ['PROJ-490'], 'Users can sign in with the company’s single sign-on provider.'),
    'tests/TC-101-retry-after-timeout.md': tc('TC-101', 'Retry payment after gateway timeout', ['REQ-07'], ['payments'], ['Configure the gateway stub to time out once.', 'Submit a payment.'], 'The payment succeeds on the second attempt.'),
    'tests/TC-102-stop-after-3-retries.md': tc('TC-102', 'Payment stops after 3 retries', ['REQ-07'], ['payments'], ['Configure the gateway stub to time out.', 'Submit a payment.'], 'Payment fails with a retry-exhausted message after 3 attempts.'),
    'tests/TC-110-tax-line.md': tc('TC-110', 'Invoice shows regional tax line', ['REQ-12'], ['billing'], ['Create a customer in Sweden.', 'Create an invoice for them.'], 'The invoice shows a 25% VAT line.'),
    'tests/TC-111-tax-report.md': tc('TC-111', 'Invoice total matches tax report', ['REQ-12'], ['billing'], ['Create three invoices.', 'Run the tax report.'], 'The report total equals the sum of the invoices’ tax lines.'),
    'tests/TC-120-idle-logout.md': tc('TC-120', 'Idle session logs user out', ['REQ-22'], ['auth'], ['Sign in.', 'Wait 30 minutes without activity.', 'Click any link.'], 'The sign-in page is shown.'),
    'tests/TC-130-role-change-audit.md': tc('TC-130', 'Role change shows in audit log', ['REQ-31'], ['audit'], ['As an admin, make a user a manager.', 'Open the audit log.'], 'The change is listed with the admin’s name and the time.'),
    'tests/TC-140-sso-sign-in.md': tc('TC-140', 'Sign in with company SSO', ['REQ-22', 'REQ-40'], ['auth'], ['Open the sign-in page.', 'Choose “Company sign-in”.'], 'The user is signed in, and the session times out as in REQ-22.'),
  };
}
