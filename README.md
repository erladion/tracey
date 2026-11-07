# Tracey

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

### Desktop installers

```sh
npm run dist         # an installer for this computer's system, in dist/
npm run dist:win     # Windows: Tracey-<version>-win-x64.exe (installs per user, no admin rights)
npm run dist:mac     # macOS: a .dmg (build it on a Mac)
npm run dist:linux   # Linux: an .AppImage (make it executable and run it)
```

Settings are in `electron-builder.yml`, the icon in `build/`. The installers aren't
code-signed, so Windows SmartScreen and macOS Gatekeeper warn on first start (*More info
→ Run anyway*, or right-click → *Open*). Signing needs the company's certificate: set
`CSC_LINK` and `CSC_KEY_PASSWORD` (and on macOS notarization credentials) before
building. Building for Windows on Linux needs Wine; a Windows machine or CI runner is
simpler.

GitHub Actions (`.github/workflows/build.yml`) runs the type check and tests on every
push and pull request, and on `main` builds the Linux AppImage and the Windows installer
(download them from the run's artifacts). Pushing a tag `v1.2.3` also makes a GitHub
release with both, as version 1.2.3:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The web server's repositories are the folders in its workspace (default `./repos`),
plus any given with `--repo /path/to/repo` (repeatable). It listens on 127.0.0.1 by
default. To let other machines in, use `--host 0.0.0.0` **and** set `TRACE_TOKEN`;
people then open it once as `http://host:5180/?token=…`. On the web, commits are made
by the server's git with the author each person enters in the commit dialog.

Git is the system's `git`, so cloning, pulling and pushing use whatever credential
helper or SSH key the machine has (the user's for the desktop app, the server's for the
web app). Tracey never prompts for passwords: set up `git clone` from a terminal first.

### CI check

```sh
npm run check -- path/to/repo     # or: node out/server/index.js check path/to/repo
./Tracey-0.1.0-linux-x86_64.AppImage check path/to/repo   # with only the desktop app
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
  number, or the ID you type in the **New** dialog (it must be unused, and can't start
  with the other kind's prefix). Two branches can take the same number; Coverage and
  `check` report duplicates. IDs shaped like `TC-123` (capital letters, a dash, a number)
  are also recognized in text, commit messages and Jira; other IDs only link through
  fields such as `verifies`.
- **Kind** comes from the ID prefix (`REQ-`, `TC-`), or `type: requirement | testcase`.
- **`reviewed`** is written by Tracey: for each verified requirement, a fingerprint of
  its title and text when the link was last reviewed. When the requirement's text
  changes, the link shows as *changed since review* (suspect) until someone checks the
  test case and marks it reviewed. Whitespace and line wrapping don't count as changes.
- **`variants: [pro]`** limits an item to some product variants (see Variants below).
  Without it, an item applies to all of them.
- **`estimate: 30m`** on a test case: how long running it takes (`45`, `1h`, `1h 30m`,
  `1.5h`, `1:30`; a bare number is minutes). Test runs add them up.
- **Status `obsolete`** leaves an item out of coverage.
- **Fields of your own** declared under `fields:` in `trace.yml` (below) are edited
  above the text like the rest, checked (a priority that isn't one of the choices is
  listed under Problems), filtered on in the list, and get a column in the Excel and
  CSV export and a line in the PDF.
- **Other fields** (`safety-level`, `doors`, from an import or written by hand) are
  kept as they are and shown read-only under the item's own fields; declare them to
  edit them. Search finds every field: any word searches them all, and `field:value`
  one (`priority:high`, `doors:payments`).

### trace.yml

```yaml
requirements: { dir: requirements, prefix: REQ-, digits: 2 }
testcases:    { dir: tests,        prefix: TC-,  digits: 3 }
statuses: [draft, review, approved, obsolete]
testcaseStatuses: [draft, ready, obsolete]
components:
  payments: { name: Payments, paths: ["src/payments/**"] }
fields:
  priority: [Low, Medium, High]      # one of these
  owner: text                        # also: number, date (2026-11-07), list
  platforms: { values: [Linux, Windows], multiple: true }   # any of these
  safety: { name: Safety level, values: [QM, ASIL A, ASIL B], for: requirement }
jira:
  url: https://jira.example.com      # makes Jira keys links
```

A field is for both kinds unless `for:` says `requirement` or `testcase`. Tracey's own
fields (`status`, `components`…) can't be declared.

With a `trace.yml`, only the two directories are read; without one, every Markdown file
with front matter in the repository is.

## Editing

The text is edited as formatted text (ProseMirror, after Wysette's editor): headings,
lists, tables, quotes, code, links, images, with Markdown shortcuts as you type
(`## `, `- `, `1. `, `**bold**`, `` `code` ``) and Markdown pasted as formatting.
Item IDs in the text (`REQ-22`) are highlighted; Ctrl+click opens them.

Paste a screenshot or drop image files into the text to add them. They're saved in an
`images` folder beside the item, named after it (`requirements/images/REQ-07.png`,
`REQ-07-login-form.png` for a file called "Login form"), and linked by a relative path,
so they also show on Bitbucket and in any Markdown viewer. An image goes in a paragraph
of its own where the cursor is (inline in a table cell). PNG, JPEG, GIF and WebP, up to
10 MB. **Commit…** above the text takes the item's new images along.

Only what you change is rewritten: blocks you didn't touch are saved byte for byte, and
edited paragraphs keep their line wrapping, so diffs and reviews stay small. Files save
by themselves (Ctrl+S saves at once); committing is a separate, deliberate step in the
status bar.

### Changing many at once

Ctrl-click (⌘ on a Mac) items in the list to pick several, Shift-click to pick a range,
or **Change several at once…** above the list to pick by clicking (on a touch screen).
With some picked, the page shows them and one form for all of them: set or clear the
status, estimate and your single-value fields; add or remove components, variants,
Jira keys, requirements verified (reviewed now, like adding one by hand) and list
fields. It says how many files that changes before you apply it, leaves out items that
already have the value, and the files are then committed from the status bar like any
edit (or discarded there).

### Git in the editor

A bar above the text says whether the item changed since the last commit, and what
(text, Status, Verifies…):

- **Show changes** marks changed blocks in the margin (blue: changed, green: new) and
  where blocks were removed (point at the marker to see what was there).
- **Compare** opens the item's versions side by side as formatted text: changed fields,
  removed and added blocks, and word-level changes inside a paragraph. Pick any version
  from its history, compare it with now or see what that commit changed, and
  **Restore this version**. History entries in the side panel open the same view.
- **Discard…** puts the item back as it was in the last commit.
- **Commit…** commits just this item.
- **Who changed what**: point at a paragraph, list or table to see who last changed it,
  when, and in which commit (from `git blame`).

### Conflicts

**Get latest** puts your commits on top of the server's. When you and the server
changed the same file, Tracey merges instead and resolves what it can by itself:

- a requirement or test case field by field (lists like Verifies as sets, so additions
  on both sides are kept) and its text paragraph by paragraph;
- a test run case by case, so two testers' results never conflict unless both recorded
  the same case;
- any other file as a whole.

What both sides changed differently opens in **Resolve conflicts** (also in the status
bar): yours and the server's side by side, with what each changed highlighted. Choose
one (or, for text, both), then **Finish** to record the merge, or **Finish and push**.
**Cancel getting the latest** puts everything back as it was.

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

Tracey reads the projects' issues (or `jql`'s) plus every key named in front matter or
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

Requirements and test cases live in one repository (the one Tracey opens); the code
lives in another, whose commit messages name Jira issues (`PROJ-466: …`, or Bitbucket's
`Pull request #12: PROJ-466 …`). Tracey reads that repository's log, and never changes it:

```yaml
# trace.yml in the requirements repository
code:
  repository: https://bitbucket.example.com/scm/proj/app.git   # https or ssh, either matches
  branch: main         # read origin/main when the clone has it
  commits: 500         # how far back
jira:
  projects: [PROJ]     # which KEY-123 words are Jira keys (default: those used in jira: fields)
```

Tracey finds a local clone with that remote among the repositories it knows (the
desktop app's recent folders, the web server's workspace); otherwise **Settings → Code
repository** offers to clone it, or to choose its folder. It fetches before reading,
so new commits show up without pulling the code yourself.

A commit links to Jira issues by the keys in its message, and through them to the
requirements whose `jira:` names those issues, and on to their test cases. A commit
naming an item directly (`see REQ-22`) links to it too. The files it changed map to
components by their paths, shown with the commit.

## Test runs: what to test between two versions

**Test runs → New test run**, then pick two versions of the code (tags, branches or
commits; tags are offered). Tracey reads the commits between them in the code repository
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

Results show beside the items too: a test case's side panel lists every run it's in,
with result, tester, date and note, and a requirement's lists each test's last result.
Click one to open that run at the case.

**Release.** A run's results count toward a release: the one set in the run
(`release: v2.4.0`, filled in from the code tag or Jira fix version when there is one,
and changeable on the run's page), else the code version it tested if that's a tag, else
its Jira fix version. Versions match without a leading `v` and ignoring case, so tag
`v2.4.0` and fix version `2.4.0` are one release. A run up to a branch or a commit
belongs to no release unless one is set.

**Estimated time.** The New test run dialog adds up the test cases' estimates, and a
run shows how much is left (the cases not run yet), saying how many have no estimate.

Expand a case to read its steps while testing. **Report (HTML)** downloads a standalone
page (print it to PDF), **Report (Markdown)** a text version; **Save report to
repository** puts the Markdown next to the run, to commit with it.

## Importing from DOORS

DOORS 9 and DOORS Next both export **ReqIF** (`.reqifz`, or `.reqif`). Export a
baseline with its link modules, then:

```sh
npm run build
npm run import-reqif -- payments.reqifz --init-map doors-map.yml        # 1. a map to check
npm run import-reqif -- payments.reqifz --map doors-map.yml --into ../reqs --dry-run   # 2. the report
npm run import-reqif -- payments.reqifz --map doors-map.yml --into ../reqs             # 3. the files
npm run check -- ../reqs
```

With only the desktop app, it runs the same commands from a terminal, without opening
a window:

```sh
./Tracey-0.1.0-linux-x86_64.AppImage import-reqif payments.reqifz --init-map doors-map.yml
./Tracey-0.1.0-linux-x86_64.AppImage import-reqif payments.reqifz --map doors-map.yml --into ../reqs --dry-run
./Tracey-0.1.0-linux-x86_64.AppImage import-reqif payments.reqifz --map doors-map.yml --into ../reqs
./Tracey-0.1.0-linux-x86_64.AppImage check ../reqs
```

**Requirements and test cases in different modules.** Best is one export holding both
modules and the link module between them. If they were exported separately, give all
the exports at once (`import-reqif reqs.reqifz tests.reqifz …`, the same in every step):
they're read as one, so a test module's links to the requirements module become
`verifies:`. Imported in separate runs instead, those links point outside the import
and are left out (the report counts them).

The map (YAML, guessed from the export, with what was found listed at the end) says:

- **modules**: per DOORS module, `requirement`, `testcase` or `skip`, its folder and its
  ID prefix. An object's number (`ReqIF.ForeignID`, the absolute number) gets the prefix:
  SYS-123. Modules with "test" or "verification" in the name are guessed as test cases.
- **attributes**: which hold the ID, title, text, status, variants and components;
  `keep` copies others (Priority…) into the front matter as they are.
- **types**: object types that are headings, or information.
- **values**: DOORS statuses, variants and components → Tracey's.
- **links**: link types meaning *verifies* (a test case and a requirement, whichever
  way DOORS drew the link) and *refines* (between requirements: `refines: [STK-4]`).

What comes across:

- One Markdown file per requirement and test case: the text as Markdown (bold, lists,
  tables, links), the status, variants, kept attributes, `section: 3.2 Payment`, and
  `doors: {module, id}` pointing back at the DOORS object. A title is taken from the
  first sentence when the object has none (DOORS requirements usually don't).
- Test cases `verifies:` their requirements, already marked reviewed.
- Pictures in the text are copied to `images/`; an OLE object comes across as its
  picture, or as a note when the export has none.
- Each module gets a `README.md` with its headings, information objects and order,
  linking to the items, so the document structure is kept and shows on Bitbucket.
- A report: counts per module, links left out (to modules not imported, or of types not
  mapped), pictures missing, how statuses were mapped, and attributes not copied.
- If the repository has no `trace.yml`, one is written; otherwise the matching
  settings are printed to merge in.

It never overwrites a file, and stops when an imported ID is already in the repository
(`--force` imports anyway). History isn't imported: commit the import as the first
version ("Imported from DOORS baseline 3.2"), keep the export file, and set the DOORS
modules read-only.

## Export: PDF, Excel, CSV

**Coverage → Export…**, then a format. Every format can be limited to one component, and
leaves out obsolete items unless asked.

- **PDF document**: a specification document. Every requirement and test case with its
  text and links, a traceability matrix and a coverage summary. **Test runs → Report
  (PDF)** does the same for a run's report. The desktop app writes the PDF itself (A4,
  page numbers) and asks where to save it. In a browser, the print dialog opens with the
  document, and "Save as PDF" makes the file.
- **Excel workbook** (.xlsx): one sheet each, pick which.
  - **Requirements**, with test cases, coverage, links to review and last results.
  - **Test cases**, with what they verify and their last result.
  - **The traceability matrix**: requirements down, test cases across.
  - **Test runs**, with their totals.
  - **Every result in every run.**
  - **Coverage over time.**

  Headers are frozen and filterable. Tracey writes the file itself, with no library and
  no macros.
- **CSV**: one of those tables, as UTF-8 that Excel opens correctly. A cell that starts
  with `=`, `+`, `-` or `@` gets a leading `'`, so it can't run as a formula.

## Test results in the traceability matrix

**Coverage → Traceability → Results from** picks which results the matrix shows: the
latest result of each test case, a release (its runs), one run, or none. Each
requirement then gets a verdict: **failing** if any of its test cases failed, else
**blocked** if any is blocked, **verified** when all passed, **partly run** when some
passed and the rest haven't run, **not run**, or **no tests**. Obsolete test cases don't
count. Each test case shows its result as a mark (✓ ✕ ! –) as well as a colour.
The PDF and Excel/CSV exports can include the same: a verdict column and each test's
result, with where the results came from.

## What changed between two versions

**Coverage → What changed…** compares the requirements and test cases between two
versions: releases (the requirements a release's newest run recorded), tags in the
requirements repository, or now. It lists what was added, removed and changed, with the
changed fields and text word by word, and flags requirements whose text changed while
none of their test cases did. Items are matched by ID, so a moved file is the same item.
**Export PDF** makes a document of it.

## Variants

When a product comes in variants, declare them in `trace.yml`:

```yaml
variants:
  base: { name: Base }
  pro: { name: Pro }
```

or under **Settings → Variants**, which adds, renames and removes them, shows how many
items each is named by, and changes only those lines of `trace.yml`. A variant's key
is what items name, so it can't be changed there once made.

An item limited to some variants lists them (`variants: [pro]`, also editable above
the text); everything else applies to all variants, so most items need nothing.

- **Variant** at the top right shows what applies to one variant. The list, coverage,
  graph, test runs and exports then cover that variant only. New IDs are still counted
  across all variants, so they never clash.
- **Coverage per variant**: a requirement counts as verified for a variant only when
  a test case that applies to that variant verifies it. With all variants shown,
  **Coverage → By variant** lists each one; `check` prints them too.
- **Problems**: a test case whose variants can never meet its requirement's
  (`[base]` verifying a `[pro]` requirement), and variants `trace.yml` doesn't define.
- **Test runs** are made for a variant (`variant: pro` in the run file): only its test
  cases are picked, and its report, results and trend say which variant was tested.
- A new test case made from a requirement takes the requirement's variants.

When the text differs only a little between variants, split the requirement
(REQ-07 for the others, REQ-07-PRO for Pro) or give the values per variant in a table
in the text. Tracey has no conditional text, so files stay plain Markdown.

## Coverage over time

**Coverage** shows two charts across the test runs, oldest first, ending with now:

- the share of requirements verified by a test case;
- each run's results.

Coverage at a run is counted from the requirements as they were when the run was
created (the `requirements-commit` the run records, read from git). A requirement added
later doesn't lower an old run's number. Point at a run for its numbers, or switch to
**Table** for all of them, including how many requirements had a passing test and no
failed or blocked one. A run that doesn't record a commit, or whose commit isn't in your
copy, shows results only.

## Traceability graph

Columns of commits → Jira issues → requirements → test cases → components, linked by:

| Link | Where it's written |
|---|---|
| commit → Jira issue | the key in the commit message, in the code repository |
| Jira issue → requirement | `jira: [PROJ-466]` on the requirement |
| requirement → test case | `verifies: [REQ-07]` on the test case |
| test case → component | `components: [payments]` on the test case |
| component → code | `paths:` of the component in `trace.yml` |

Click a node to select it: it turns solid blue, what it traces to gets a blue border
and blue links, and the rest fades. A node with something missing carries a tag on
its top edge (**No tests**, **No requirement**, **Not linked**) and a dashed border; one
that needs a look now (**Suspect**, **Broken link**) is orange. **Show gaps** lights
up requirements without test cases, test cases that verify nothing or have suspect or
broken links, components no test case covers, and Jira issues that commits name but no
requirement does (work with no requirement behind it). Filter by component or search to
narrow it down; double-click a requirement or test case to open it.

On a large project the faded part gets in the way: **Hide what's faded** leaves out
everything off the selected node's trace (or, under Show gaps, everything that isn't a
gap). **Save as SVG** or **PNG** saves the graph as it's shown, selection and all, in
the light colours, for a document or a slide.

## Code layout

```
src/core/       pure TypeScript, shared by everything (and unit-tested)
  config.ts       trace.yml
  frontmatter.ts  front matter: read, and change fields keeping the rest as written
  model.ts        items, links, fingerprints, problems, coverage, new IDs, component globs
  graph.ts        the traceability graph: nodes, edges, gaps, filters, column order
  graphsvg.ts     the graph as a standalone SVG picture
  fields.ts       declared fields (checked, parsed) and the others (read-only); search
  bulk.ts         one change to many items: what each file gets
  links.ts        Jira issue ↔ item links from every source
  commits.ts      commits → Jira keys, item IDs and components
  impact.ts       which test cases a range of commits calls for, and why
  runs.ts         test run files: read, create, record results; a test case's results; releases
  verdict.ts      results in the matrix: where they come from, each requirement's verdict
  estimate.ts     test case time estimates and run totals
  changes.ts      what changed between two versions, and its document
  images.ts       images in an item's text, and where pasted ones go
  report.ts       a run's report as Markdown or HTML
  specdoc.ts      the specification document (HTML, printed to PDF)
  spreadsheet.ts  the export tables; xlsx.ts writes them as Excel or CSV
  trend.ts        coverage and results at each test run
  reqif.ts        ReqIF (DOORS exports); xml.ts reads XML, xhtml.ts turns its rich text into Markdown
  doors.ts        the DOORS import: the map, the files, the report
  markdown/       schema, Markdown ↔ ProseMirror with source preservation
  sample.ts       files of a new project
src/shared/api.ts the calls the interface makes to the back end
src/backend/      Node: files (with path checks), git, the Jira client, and the commands (cli.ts)
src/main/         Electron: window, IPC, folder dialogs, recent repositories; commands from a terminal
src/preload/      the IPC bridge
src/server/       web server (same API over HTTP), and the same commands
src/renderer/     React interface, used by both
```

## Next

From the design discussion, in roughly this order:

1. **Writing to Jira** (optional): remote links from issues back to requirements in
   Tracey, test results on issues.
2. **Bitbucket**: Code Insights reports on PRs ("touches REQ-12, 2 of 3 linked tests pass").
