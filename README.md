# Trace

Requirements and test cases as Markdown files in git, edited WYSIWYG, linked both
ways, with coverage and "suspect link" tracking. Runs as a desktop app (Electron) or
as a web app served from one Node process; both share the same interface and back end.

## Run it

```sh
npm install
npm run dev          # desktop app, with hot reload
npm run dev:web      # web app at http://127.0.0.1:5180, with hot reload

npm run build        # builds both
npm start            # desktop app, built
npm run start:web -- --workspace ./repos --port 5180
```

The web server's repositories are the folders in its workspace (default `./repos`),
plus any given with `--repo /path/to/repo` (repeatable). It listens on 127.0.0.1 by
default. To let other machines in, use `--host 0.0.0.0` **and** set `TRACE_TOKEN`;
people then open it once as `http://host:5180/?token=…`. On the web, commits are made
by the server's git with the author each person enters in the commit dialog.

Git is the system's `git`, so cloning, pulling and pushing use whatever credential
helper or SSH key the machine has (the user's for the desktop app, the server's for the
web app). Trace never prompts for passwords: set up `git clone` from a terminal first.

### CI check

```sh
npm run check -- path/to/repo     # or: node out/server/index.js check path/to/repo
```

It prints duplicate IDs, broken links, unknown statuses and components, and a coverage
summary, and exits 1 if there are errors.

## Files in the repository

```
trace.yml                    settings (all optional)
requirements/REQ-07-….md     one file per requirement
tests/TC-102-….md            one file per test case
```

```markdown
---
id: REQ-07
title: Payment retry after gateway timeout
status: approved
components: [payments]
jira: [PROJ-466]
---
When the payment gateway times out, the system retries
up to 3 times with increasing delay before failing.
```

```markdown
---
id: TC-102
title: Payment stops after 3 retries
status: ready
verifies: [REQ-07]
components: [payments]
reviewed:
  REQ-07: aaa199ed
---
## Steps
1. Configure the gateway stub to time out.
2. Submit a payment.

## Expected
Payment fails with a retry-exhausted message after 3 attempts.
```

- **IDs** come from the front matter, never the file name. New items get the next free
  number. Two branches can take the same number; Coverage and `check` report duplicates.
- **Kind** comes from the ID prefix (`REQ-`, `TC-`), or `type: requirement | testcase`.
- **`reviewed`** is written by Trace: for each verified requirement, a fingerprint of
  its title and text when the link was last reviewed. When the requirement's text
  changes, the link shows as *changed since review* (suspect) until someone checks the
  test case and marks it reviewed. Whitespace and line wrapping don't count as changes.
- **Status `obsolete`** leaves an item out of coverage.
- Fields Trace doesn't know are kept as they are.

### trace.yml

```yaml
requirements: { dir: requirements, prefix: REQ-, digits: 2 }
testcases:    { dir: tests,        prefix: TC-,  digits: 3 }
statuses: [draft, review, approved, obsolete]
testcaseStatuses: [draft, ready, obsolete]
components:
  payments: { name: Payments, paths: ["src/payments/**"] }
jira:
  url: https://jira.example.com      # makes Jira keys links
```

With a `trace.yml`, only the two directories are read; without one, every Markdown file
with front matter in the repository is.

## Editing

The text is edited as formatted text (ProseMirror, after Wysette's editor): headings,
lists, tables, quotes, code, links, images, with Markdown shortcuts as you type
(`## `, `- `, `1. `, `**bold**`, `` `code` ``) and Markdown pasted as formatting.
Item IDs in the text (`REQ-22`) are highlighted; Ctrl+click opens them.

Only what you change is rewritten: blocks you didn't touch are saved byte for byte, and
edited paragraphs keep their line wrapping, so diffs and reviews stay small. Files save
by themselves (Ctrl+S saves at once); committing is a separate, deliberate step in the
status bar.

## Jira

Issues link to requirements and test cases from either side; every link remembers
where it's written, and the interface shows it:

| Where | Example | Needs the Jira connection |
|---|---|---|
| front matter of the item | `jira: [PROJ-466]` on a requirement or test case | no |
| commit message (code repository) | `PROJ-512: … (REQ-07)` | no |
| issue label | label `REQ-07` | yes |
| issue field | a custom field listing `REQ-07, TC-102` (`jira.field`) | yes |
| issue text | summary or description mentions `REQ-07` | yes |
| issue remote link | a web link whose address or title has `REQ-07` | yes |

```yaml
jira:
  url: https://jira.example.com
  api: 2                 # 2: Data Center / Server (personal access token); 3: Cloud (email + API token)
  projects: [PROJ]       # Jira keys to recognise; also which issues to read
  field: Requirements    # optional custom field (its name, or customfield_12345)
  links: [labels, field, text, remote-links]   # which issue-side links count (default: all)
  jql: project = PROJ AND updated >= -365d      # optional: which issues to read
  max: 2000
```

Trace reads the projects' issues (or `jql`'s) plus every key named in front matter or
commits, and only reads; it never changes Jira. Remote links take one request per
issue, for up to 500 issues. Keys that don't exist in Jira are listed in Settings.

Tokens: everyone uses their own, so Jira shows what each person may see.

- **Desktop app:** **Settings → Jira** keeps your token encrypted with the system
  keychain (Windows, macOS, or Linux with a keyring; without one it refuses, and
  `TRACE_JIRA_URL` + `TRACE_JIRA_TOKEN` in the environment work instead).
- **Web version:** **Settings → Jira** keeps your token in your browser, as a cookie the
  server encrypts with its secret (`TRACE_SECRET`, or one it makes once and keeps in
  `<workspace>/.trace-secret`). The server stores no one's token; page scripts can't read
  the cookie. The server only talks to the Jira in `TRACE_JIRA_URL` (comma-separated for
  several), whatever a repository's trace.yml says. `TRACE_JIRA_TOKEN` (+
  `TRACE_JIRA_EMAIL` for Cloud) is an optional shared token for people who haven't added
  their own; Settings says when it's in use.

With Jira connected, issues show their summary, status and fix versions, and a test
run can cover a **fix version** (alone, or with a range of code versions).

## Commits: the code repository

Requirements and test cases live in one repository (the one Trace opens); the code
lives in another, whose commit messages name Jira issues (`PROJ-466: …`, or Bitbucket's
`Pull request #12: PROJ-466 …`). Trace reads that repository's log, and never changes it:

```yaml
# trace.yml in the requirements repository
code:
  repository: https://bitbucket.example.com/scm/proj/app.git   # https or ssh, either matches
  branch: main         # read origin/main when the clone has it
  commits: 500         # how far back
jira:
  projects: [PROJ]     # which KEY-123 words are Jira keys (default: those used in jira: fields)
```

Trace finds a local clone with that remote among the repositories it knows (the
desktop app's recent folders, the web server's workspace); otherwise **Settings → Code
repository** offers to clone it, or to choose its folder. It fetches before reading,
so new commits show up without pulling the code yourself.

A commit links to Jira issues by the keys in its message, and through them to the
requirements whose `jira:` names those issues, and on to their test cases. A commit
naming an item directly (`see REQ-22`) links to it too. The files it changed map to
components by their paths, shown with the commit.

## Test runs: what to test between two versions

**Test runs → New test run**, then pick two versions of the code (tags, branches or
commits; tags are offered). Trace reads the commits between them in the code repository
and picks the test cases to run:

- commit → Jira key → requirements naming it in `jira:` → test cases verifying them
- commit → a requirement or test case ID named in the message (`see REQ-22`)
- commit → changed files → components (paths in `trace.yml`) → test cases tagged with
  them (can be turned off)

Each case carries why it was picked ("PROJ-466 → REQ-07 (2 commits)"). The dialog also
shows what the range touches that nothing tests: Jira issues no requirement names,
affected requirements without test cases, changed components without test cases, and
commits that name no issue. Or start a run with every test case, or an empty one.

A run is a YAML file in the requirements repository (`test-runs/release-2-4-0.yml`,
folder set by `runs.dir`), recording the versions, the exact code and requirements
commits, and per test case its result (passed, failed, blocked, not run), tester, date
and note. Commit it like anything else. Each case is a separate block, so testers
recording different cases in the same run merge without conflicts.

Expand a case to read its steps while testing. **Report (HTML)** downloads a standalone
page (print it to PDF), **Report (Markdown)** a text version; **Save report to
repository** puts the Markdown next to the run, to commit with it.

## PDF

**Coverage → Export PDF** makes a specification document: every requirement and test
case with its text and links, a traceability matrix and a coverage summary, optionally
for one component and with or without obsolete items. **Test runs → Report (PDF)** does
the same for a run's report. The desktop app writes the PDF itself (A4, page numbers)
and asks where to save it; in a browser the print dialog opens with the document, and
"Save as PDF" makes the file.

## Traceability graph

Columns of commits → Jira issues → requirements → test cases → components, linked by:

| Link | Where it's written |
|---|---|
| commit → Jira issue | the key in the commit message, in the code repository |
| Jira issue → requirement | `jira: [PROJ-466]` on the requirement |
| requirement → test case | `verifies: [REQ-07]` on the test case |
| test case → component | `components: [payments]` on the test case |
| component → code | `paths:` of the component in `trace.yml` |

Click a node to light up everything upstream and downstream of it; **Show gaps** lights
up requirements without test cases, test cases that verify nothing or have suspect or
broken links, components no test case covers, and Jira issues that commits name but no
requirement does (work with no requirement behind it). Filter by component or search to
narrow it down; double-click a requirement or test case to open it.

## Code layout

```
src/core/       pure TypeScript, shared by everything (and unit-tested)
  config.ts       trace.yml
  frontmatter.ts  front matter: read, and change fields keeping the rest as written
  model.ts        items, links, fingerprints, problems, coverage, new IDs, component globs
  graph.ts        the traceability graph: nodes, edges, gaps, filters, column order
  links.ts        Jira issue ↔ item links from every source
  commits.ts      commits → Jira keys, item IDs and components
  impact.ts       which test cases a range of commits calls for, and why
  runs.ts         test run files: read, create, record results
  report.ts       a run's report as Markdown or HTML
  specdoc.ts      the specification document (HTML, printed to PDF)
  markdown/       schema, Markdown ↔ ProseMirror with source preservation
  sample.ts       files of a new project
src/shared/api.ts the calls the interface makes to the back end
src/backend/      Node: files (with path checks), git, and the Jira client
src/main/         Electron: window, IPC, folder dialogs, recent repositories
src/preload/      the IPC bridge
src/server/       web server (same API over HTTP) and the `check` command
src/renderer/     React interface, used by both
```

## Next

From the design discussion, in roughly this order:

1. **Writing to Jira** (optional): remote links from issues back to requirements in
   Trace, test results on issues.
2. **Bitbucket**: Code Insights reports on PRs ("touches REQ-12, 2 of 3 linked tests pass").
