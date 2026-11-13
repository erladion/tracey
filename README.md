# Tracey

Requirements and test cases as Markdown files in git. Edit them as formatted text, link
them both ways, and see what's covered, what's missing tests, and which links need a
second look because a requirement changed.

Tracey runs as a desktop app (Windows, Linux) or as a web app served by one Node
process. Both have the same interface.

**What it does**

- **Plain files**: one Markdown file per requirement and test case, edited as formatted
  text. What you don't touch is saved byte for byte, so diffs stay small.
- **Coverage**: which requirements are tested, a traceability matrix with test results,
  and a verdict for each requirement.
- **Suspect links**: when a requirement changes, the tests verifying it are flagged until
  someone reviews them.
- **Test runs**: pick what to test between two code versions from commits, Jira issues
  and changed files, then record results step by step.
- **A traceability graph** from commits and Jira issues, through requirements, to test
  cases and components.
- **Your own structure**: product variants, item types (risks, architecture…), link
  types and rules for what counts as a gap.
- **Import and export**: DOORS (ReqIF or HTML), Sphinx-Needs, PDF, Excel and CSV.
- **A `check` command** for CI.

## Contents

- [Getting started](#getting-started)
- [How items are stored](#how-items-are-stored)
- [Settings: trace.yml](#settings-traceyml)
- [Working in the app](#working-in-the-app)
- [Coverage and traceability](#coverage-and-traceability)
- [Test runs](#test-runs)
- [Jira](#jira)
- [The code repository](#the-code-repository)
- [Import and export](#import-and-export)
- [Command line](#command-line)
- [Large projects](#large-projects)
- [Development](#development)

---

## Getting started

### Install

Download the latest version from the repository's **Releases** page:

| System | File | Notes |
|---|---|---|
| Windows | `Tracey-<version>-win-x64.exe` | Installs for your user only; no admin rights needed. |
| Linux | `Tracey-<version>-linux-x86_64.AppImage` | Make it executable (`chmod +x`) and run it. |

The installers aren't code-signed, so the first start shows a warning: on Windows,
SmartScreen's **More info → Run anyway**.

The AppImage needs FUSE 2 (`fuse-libs` on RHEL and Fedora, `libfuse2` on Ubuntu).
Without it, start it with `--appimage-extract-and-run`. If the system doesn't allow
unprivileged user namespaces, add `--no-sandbox`.

### Open a repository

The start screen offers three ways in:

- **Open a folder…**: a repository you've already cloned, or any folder.
- **Clone a repository**: paste its address.
- **New project**: an empty repository, optionally with example requirements and test
  cases to look around in.

Tracey uses the system's `git`, so cloning, pulling and pushing use the credential
helper or SSH key the computer already has. It never asks for passwords: if `git clone`
doesn't work from a terminal, set that up first.

A folder that isn't a git repository opens too. See [Without git](#without-git).

### The web version

One Node process serves Tracey to a team's browsers:

```sh
npm install && npm run build
npm run start:web -- --workspace ./repos --port 5180
```

- **Repositories**: the folders in the workspace (default `./repos`), plus any given
  with `--repo /path/to/repo` (repeatable).
- **Access**: it listens on 127.0.0.1 only. To let other machines in, use
  `--host 0.0.0.0` **and** set `TRACE_TOKEN`; people then open it once as
  `http://host:5180/?token=…`.
- **Commits** are made by the server's git, with the author each person enters in the
  commit dialog.

---

## How items are stored

```
trace.yml                    settings (all optional)
requirements/REQ-07-….md     one file per requirement
tests/TC-102-….md            one file per test case
test-runs/release-2-4-0.yml  one file per test run
```

A requirement:

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

A test case:

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

### Fields

| Field | On | What it means |
|---|---|---|
| `id` | all | The item's ID. Always taken from here, never from the file name. |
| `type` | all | `requirement`, `testcase` or a type of your own. Usually not needed: the ID's prefix (`REQ-`, `TC-`) says it. |
| `title` | all | |
| `status` | all | One of the statuses in `trace.yml`. `obsolete` leaves an item out of coverage. |
| `verifies` | test cases | The requirements it tests. |
| `refines` | requirements | The requirements it breaks down. See [Refinement](#refinement). |
| `verification`, `evidence` | requirements | How it's verified when not by a test. See [Verification methods](#verification-methods). |
| `components` | all | The parts of the code it concerns. See [Components](#components). |
| `jira` | all | Jira issues it belongs to. |
| `variants` | all | The product variants it's limited to. Without it, it applies to all. See [Variants](#variants). |
| `estimate` | test cases | How long running it takes: `45` (minutes), `1h`, `1h 30m`, `1.5h`, `1:30`. Test runs add them up. |
| `reviewed` | linking items | Written by Tracey: a fingerprint of each linked requirement when the link was last reviewed. See [Suspect links](#suspect-links). |
| fields of your own | as declared | Declared under `fields:` in `trace.yml`: edited above the text, checked, filterable, and exported. |
| any other field | all | Kept as it is and shown read-only (for example `doors:` from an import). Declare it to edit it. |

Search finds every field: a word searches them all, `field:value` one of them
(`priority:high`, `doors:payments`).

### IDs

- **New items** get the next free number, or the ID you type in the **New** dialog. It
  must be unused, and can't start with another kind's prefix.
- **Duplicates**: two branches can take the same number. Coverage and `check` report it.
- **IDs in text**: IDs shaped like `TC-123` (capital letters, a dash, a number) are
  recognized in text, commit messages and Jira. Other IDs only link through fields such
  as `verifies`.
- **Renaming**: click the ID above the title. Everything that names it changes with it:
  the test cases verifying it, requirements refining it, review fingerprints, mentions in
  text and fields, and test run results. Links reviewed before stay reviewed, and the
  file is renamed when it's named after the ID. Jira issues and commit messages can't be
  changed; the dialog lists the ones naming the old ID. When two files share an ID, only
  the one file changes.

### Refinement

`refines: [REQ-4]` on a requirement means it breaks REQ-4 down. REQ-4 then lists it under
**Refined by** (with **New requirement** to add one), and the graph shows it a column to
the right.

A requirement with no test case of its own counts as covered when every requirement
refining it is. So a broken-down requirement needs no tests of its own.

All requirements share one prefix. For named levels (stakeholder, system, software),
declare a field: `level: [Stakeholder, System, Software]`.

### Verification methods

`verification:` on a requirement says how it's verified:

| Value | Covered when |
|---|---|
| `test` (the default) | A test case verifies it. |
| `analysis`, `inspection`, `demonstration` | `evidence:` names what shows it: a file (`evidence: [docs/latency-analysis.pdf]`), a link or a record number. |
| `none` | Never needed: a definition or constraint. It's no gap, and coverage leaves it out of the count. |

A test case verifying a requirement counts whatever the method. Set the method above the
text, or for many requirements at once.

### Suspect links

When a test case is linked to a requirement, Tracey records a fingerprint of the
requirement's title and text in the test case's `reviewed:` field. Requirements refining
others, and links of your own types, work the same way.

When the requirement's text changes later, the link shows as **changed since review**
(suspect) until someone checks the test case and clicks **Mark reviewed**. Whitespace and
line wrapping don't count as changes.

---

## Settings: trace.yml

Everything in `trace.yml` is optional. Without the file, Tracey reads every Markdown file
with front matter in the repository. With it, only the folders it names.

```yaml
requirements: { dir: requirements, prefix: REQ-, digits: 2 }
testcases:    { dir: tests,        prefix: TC-,  digits: 3 }
statuses: [draft, review, approved, obsolete]
testcaseStatuses: [draft, ready, obsolete]

components:
  payments: { name: Payments, paths: ["src/payments/**", "!src/payments/refunds/**"] }
  refunds:  { name: Refunds,  paths: ["src/payments/refunds/**"] }

fields:
  priority: [Low, Medium, High]                       # one of these
  owner: text                                         # also: number, date, list
  platforms: { values: [Linux, Windows], multiple: true }   # any of these
  safety: { name: Safety level, values: [QM, ASIL A, ASIL B], for: requirement }

variants:
  base: { name: Base }
  pro:  { name: Pro }

jira:
  url: https://jira.example.com       # see Jira below

code:
  repository: https://bitbucket.example.com/scm/proj/app.git   # see The code repository below
```

Anything that can't be used is listed under **Problems** and in **Settings**, with why.

### Components

A component's `paths` are patterns into the code repository: `src/payments/**`,
`*.ts`, `docs/?.md`. Changed files map to components through them, and components map to
the test cases tagged with them.

- **Overlapping paths**: a file matching several components belongs to each of them.
- **Excluding a part**: a pattern starting with `!` leaves it out. Above, refunds is its
  own component, so a change there isn't also a change to payments.

### Fields of your own

Declared fields are edited above the text, checked (a priority that isn't one of the
choices is listed under Problems), filtered on in the list, and get a column in the Excel
and CSV exports and a line in the PDF.

| Declaration | Field |
|---|---|
| `priority: [Low, Medium, High]` | One of these values. |
| `platforms: { values: [Linux, Windows], multiple: true }` | Any of these values. |
| `owner: text` | One line of text. Also `number`, `date` (2026-11-07) and `list` (free words). |
| `name:` | How the field is shown (default: the key). |
| `for: requirement` | Only on requirements (or `testcase`, or a type of your own). Default: both. |

The key must match the field's name in the files' front matter. Tracey's own fields
(`status`, `components`, `variants`…) can't be declared.

### Item types, link types and rules

Requirements and test cases are built in. You can add more:

```yaml
types:
  risk:         { name: Risk, prefix: RSK-, dir: risks, statuses: [open, mitigated, closed, obsolete] }
  architecture: { name: Architecture element, prefix: ARC-, dir: architecture }
links:
  mitigates:  { name: Mitigates, reverse: Mitigated by, from: [requirement, testcase], to: risk }
  implements: { name: Implements, reverse: Implemented by, from: architecture, to: requirement }
rules:
  - { every: risk, needs: mitigates }             # something must mitigate each risk
  - { every: architecture, needs: implements }    # each element must implement something
```

**A type** gets its own tab in the list, ID prefix, folder, statuses and declared fields
(`for: risk`).
- Its plural is the name plus "s" unless `plural:` says otherwise.
- An item is of a type by its ID prefix, by `type: risk` in the file, or by its folder.
- `runnable: true` makes a type a kind of test, like test cases (say
  `integration-test`): it verifies, has an estimate, goes in test runs, and is picked for
  a run through what it verifies and its components. Its statuses default to the test
  cases'.
- What tests can verify goes beyond requirements with
  `links: verifies: { to: [architecture] }`. Tests then verify architecture elements, with
  suspect links, results and rules (`- { every: architecture, needs: verifies }`).

**A link** is a list in the front matter of the linking item, named by its key
(`mitigates: [RSK-01]`).
- It's edited above the text, with suggestions of the right type.
- Both items show it in the side panel: **Mitigates** on one, **Mitigated by** on the
  other, with **New requirement** to start one already linked.
- It's checked (broken, wrong type, to itself) and reviewed like test links, so it turns
  suspect when the linked item changes.
- It's drawn in the graph, changed in bulk, renamed with IDs, and exported (a column each
  way, an *Other items* sheet, and a section per type in the PDF).

**A rule** names a type and a link.
- By default, when the type is the link's target, something must link *to* each item;
  otherwise each item must link to something. `direction: in | out` chooses.
- Items that miss a rule are gaps: on the Coverage page (a **Rules** table and **Needs
  attention**), in the graph, in the list, and in `check`.
- `tag:` and `text:` change how the gap is worded.

The graph puts each type in its own column, in the order the links go (risks,
requirements, architecture, test cases).

---

## Working in the app

### Editing

The text is edited as formatted text: headings, lists, tables, quotes, code, links and
images.

- **Markdown shortcuts** work as you type (`## `, `- `, `1. `, `**bold**`,
  `` `code` ``), and pasted Markdown becomes formatting.
- **Saving** is automatic (Ctrl+S saves at once). Committing is a separate step in the
  status bar.
- **Only what you change is rewritten**: untouched blocks are saved byte for byte, and
  edited paragraphs keep their line wrapping.

**Images**: paste a screenshot or drop image files into the text.
- They're saved in an `images` folder beside the item and named after it
  (`requirements/images/REQ-07.png`, or `REQ-07-login-form.png` for a file called
  "Login form").
- They're linked by a relative path, so they also show on Bitbucket and in any Markdown
  viewer.
- An image goes in a paragraph of its own (inline in a table cell). PNG, JPEG, GIF and
  WebP, up to 10 MB.
- **Commit…** above the text takes the item's new images along.

### Getting around

| Where | What it does |
|---|---|
| **Ctrl+Shift+P** | Go to anything: part of an item's ID or title, a test run, or an action ("New risk", "Go to Coverage"). With nothing typed, the items opened lately. |
| **Alt+← / Alt+→** | Back and forward through the items and views you've opened (also the mouse's side buttons, and the arrows beside the logo). |
| **Hover an ID** in the text | A card with what it is, its status, its links and its tests' last results. **Ctrl+click** opens it. |
| **Type an ID** in the text | Suggestions after the prefix and dash: `REQ-` lists requirements, `REQ-0` narrows by ID, `REQ-retry` searches titles. ↑↓, then Enter or Tab. |
| **The status bar** | Counts of what needs a look: errors (red), links to review (orange), warnings (yellow), gaps (grey). Click it for the **Issues** panel, with **Mark reviewed** for links. |
| **Sort the list** | By ID, title, status, or attention first (broken or suspect, then missing tests or rules, then the rest). |
| **Duplicate** | Beside Delete: a copy with the next free ID, the same fields, links and text. |

### Changing many at once

1. Pick items in the list: **Ctrl-click** (⌘ on a Mac) one at a time, **Shift-click** a
   range, or **Change several at once…** above the list to pick by tapping.
2. Under **Change all of them**, set or clear single values (status, estimate,
   verification method, your own fields), or add and remove list values (components,
   variants, evidence, Jira keys, verified or refined requirements, list fields).
   Links added this way count as reviewed now.
3. It says how many files will change. Apply, then commit from the status bar (or
   discard there).

### Git in the editor

A bar above the text says whether the item changed since the last commit, and what:

- **Show changes** marks changed blocks in the margin (blue: changed, green: new), and
  where blocks were removed (point at the marker to see what was there).
- **Compare** opens versions side by side as formatted text: changed fields, removed and
  added blocks, and word-level changes. Pick any version from the history, compare it
  with now, or **Restore this version**.
- **Who changed what**: point at a paragraph, list or table to see who last changed it,
  when, and in which commit.
- **Discard…** puts the item back as it was in the last commit.
- **Commit…** commits just this item.

### Getting the latest and conflicts

**Get latest** puts your commits on top of the server's. When you and someone else
changed the same file, Tracey merges what it can by itself:

- **A requirement or test case**: field by field (lists like `verifies` as sets, so
  additions on both sides are kept), and its text paragraph by paragraph.
- **A test run**: case by case, so two testers' results only conflict when both recorded
  the same case.
- **Any other file**: as a whole.

What's left opens in **Resolve conflicts**: both sides next to each other, with each
side's changes highlighted. Choose one (or, for text, both), then **Finish** or **Finish
and push**. **Cancel getting the latest** puts everything back.

### Without git

A folder that isn't a git repository works for editing, coverage, the graph, test runs
and exports; files are saved as they are. What needs git history isn't available:
commits, branches and getting the latest, an item's history and change marks, **What
changed**, and coverage at earlier test runs. Run `git init` and commit to have them from
then on.

---

## Coverage and traceability

### The traceability matrix

**Coverage → Traceability** shows requirements against the test cases verifying them.
**Results from** picks which test results it shows: the latest of each test case, a
release, one run, or none.

Each requirement then gets a verdict:

| Verdict | When |
|---|---|
| **Failing** | Any of its test cases failed. |
| **Blocked** | None failed, but one is blocked. |
| **Verified** | All passed. |
| **Partly run** | Some passed, the rest haven't run. |
| **Not run** | None has run. |
| **Not covered** | It has no test cases. |

- Obsolete test cases don't count.
- A requirement without test cases of its own takes its verdict from its evidence
  (*Verified (analysis)*), or from the requirements refining it, worst first, and says
  which decided it: *Failing (via REQ-12)*.
- A requirement needing no verification gets no verdict.
- Results show as a mark (✓ ✕ ! –) as well as a colour. The PDF, Excel and CSV exports
  can include the verdicts and results too.

### Coverage over time

**Coverage** shows two charts across the test runs, oldest first, ending with now: the
share of requirements verified by a test case, and each run's results.

Coverage at a run is counted from the requirements as they were when the run was created
(the run records that commit), so a requirement added later doesn't lower an old run's
number. Point at a run for its numbers, or switch to **Table**. A run without a recorded
commit (or one missing from your copy) shows results only.

### What changed between two versions

**Coverage → What changed…** compares requirements and test cases between two versions:
releases, tags in the requirements repository, or now.

- It lists what was added, removed and changed, with changed fields and text word by
  word.
- It flags requirements whose text changed while none of their test cases did.
- Items are matched by ID, so a moved file is the same item.
- **Export PDF** makes a document of it.

### Traceability graph

Columns of commits → Jira issues → requirements → test cases → components:

| Link | Where it's written |
|---|---|
| commit → Jira issue | The key in the commit message, in the code repository. |
| Jira issue → requirement | `jira: [PROJ-466]` on the requirement. |
| requirement → requirement | `refines: [REQ-07]` on the requirement breaking it down. |
| requirement → test case | `verifies: [REQ-07]` on the test case. |
| test case → component | `components: [payments]` on the test case. |
| component → code | The component's `paths` in `trace.yml`. |

- **Select a node** to trace it: it turns solid blue, everything it traces to gets a blue
  border and blue links, and the rest fades. Double-click a requirement or test case to
  open it.
- **Levels**: requirements refining others get a column per level, or with **Levels: In
  one column**, one column with each indented under the one it refines.
- **Gaps** carry a tag and a dashed border: **No tests**, **No requirement**, **Not
  linked**. What needs a look now is orange: **Suspect**, **Broken link**.
- **Show gaps** lights up requirements without test cases, test cases that verify nothing
  or have suspect or broken links, components no test case covers, and Jira issues that
  commits name but no requirement does.
- **Commits** shows the newest 30 by default. Issues only named by older commits appear
  when you show more.
- **On a large project**: filter by component, search, or select a node and tick **Hide
  what's faded** to see only its trace.
- **Save as SVG** or **PNG** saves the graph as shown, in light colours, for a document
  or slide.

### Variants

When a product comes in variants, declare them in `trace.yml` (see the
[example](#settings-traceyml)) or under **Settings → Variants**. Settings adds, renames
and removes them, and shows how many items name each. A variant's key is what items name,
so it can't be changed once made.

Most items need nothing: an item without `variants:` applies to all variants. An item
limited to some lists them: `variants: [pro]`.

- **Variant** at the top right shows one variant: the list, coverage, graph, test runs
  and exports then cover only what applies to it. New IDs are still counted across all
  variants, so they never clash.
- **Coverage per variant**: a requirement is verified for a variant only when a test case
  for that variant verifies it. **Coverage → By variant** lists each; `check` prints them
  too.
- **Problems** lists test cases whose variants never meet their requirement's (`[base]`
  verifying a `[pro]` requirement), and variants `trace.yml` doesn't define.
- **Test runs** can be made for a variant (`variant: pro` in the run file): only its test
  cases are picked, and its reports say which variant was tested.
- A new test case made from a requirement takes the requirement's variants.

When the text differs only a little between variants, split the requirement (REQ-07, and
REQ-07-PRO for Pro) or give the values per variant in a table. Tracey has no conditional
text, so files stay plain Markdown.

---

## Test runs

### Picking what to test

1. **Test runs → New test run**.
2. Pick two versions of the code: tags, branches or commits.
3. Tracey reads the commits between them in the [code repository](#the-code-repository)
   and picks test cases through:
   - commit → Jira key → requirements naming it in `jira:` → test cases verifying them;
   - commit → a requirement or test case ID in the message (`see REQ-22`);
   - commit → changed files → components → test cases tagged with them (can be turned
     off).

Each case says why it was picked ("PROJ-466 → REQ-07 (2 commits)"). The dialog also shows
what the range touches that nothing tests: Jira issues no requirement names, requirements
without test cases, changed components without test cases, and commits naming no issue.
It adds up the estimated time.

You can also start a run with every test case, an empty one, or the
[work list](#the-work-list).

### Suggestions from a language model

Links only find test cases someone connected to an issue. A language model can find more,
by what the issues are about. Set one up under **Settings → Language model**: any server
with an OpenAI-style API, such as llama.cpp (`llama-server`), vLLM, Ollama or LM Studio,
or a hosted one over https with an API key.

| Setting | What it does |
|---|---|
| Address | The API's base, as `http://localhost:8080/v1` or `https://llm.example.com/v1`. |
| Model | One the server lists, or the server's first. |
| API key | Sent as a Bearer token. Kept encrypted with the system keychain. |
| Test cases per issue | How many candidates the model chooses from. Automatic: from the model's context window (vLLM's `max_model_len`, llama.cpp's `/props`), between 30 and 150. |
| Let the model think | For reasoning models (Qwen3-style): slower, sometimes better. Off by default. |

Then, in **New test run** for a release:

1. Choose which issues: those with no test cases yet, or all of them.
2. **Suggest**. For each issue, Tracey finds the likeliest test cases by their words (title,
   text, the requirements they verify, components), and the model picks those that fit,
   with a reason. It can only pick test cases it was offered, so it can't make up IDs.
3. Untick what doesn't fit. The rest join the run, each with its reason
   ("PAY-1 (suggested): tests split refunds"). Or **Add the chosen to the work list**.

A local model takes a few seconds per issue. **Stop** keeps what's been suggested so far.
Issue texts and test case titles are sent to the server, so mind where it runs. The
matching assumes issues and test cases are written in the same language.

In the web version, the server's environment sets the model for everyone: `TRACE_LLM_URL`,
`TRACE_LLM_MODEL`, `TRACE_LLM_KEY`, and optionally `TRACE_LLM_THINK=1` and
`TRACE_LLM_CANDIDATES`.

### Recording results

Expand a case to test it. The numbered list under its **Steps** heading becomes a
checklist:

- Mark each step passed (✓), failed (✕) or blocked (!), with a note on a step that went
  wrong ("Stops after 2 retries, not 3").
- The case's result follows its steps: failed if any step failed, else blocked if one is,
  passed when all passed. You can also mark the whole case directly.
- **Assign** a case to someone, or all the shown cases at once. **Assigned → Mine** shows
  yours, and a line above the list says how far each person is ("Ana: 3 of 5 done").
- **Search** finds a case by ID, title, assignee, tester or notes.
- The run shows how much time is left (the cases not run yet).

Results also show beside the items: a test case's side panel lists every run it's in, and
a requirement's shows each test's last result.

### The run file

A run is a YAML file in the requirements repository (`test-runs/release-2-4-0.yml`; the
folder is set by `runs.dir`). It records the versions, the exact code and requirements
commits, and for each test case its result (passed, failed, blocked, not run), tester,
date, note, assignee and step results.

Commit it like anything else. Each case is a separate block, and steps are small maps
inside it (`steps: {1: passed, 2: failed}`), so testers working in the same run merge
without conflicts.

### Releases

A run's results count toward a release:

1. the one set in the run (`release: v2.4.0`, changeable on the run's page);
2. else the code version it tested, if that's a tag;
3. else its Jira fix version.

Versions match ignoring a leading `v` and case, so tag `v2.4.0` and fix version `2.4.0`
are one release. A run up to a branch or a commit belongs to no release unless one is set.

### The work list

Collect tests while looking around, then start a run with them, without knowing their
IDs.

- **Add to work list** is beside every item. A test case adds itself; a requirement adds
  the tests verifying it and the requirements refining it.
- It's also in the graph (the tests in the selected node's trace), on several picked
  items, and under a search in the list ("Add the 12 shown").
- **Work list** at the top shows them, with why each is there. Take some off or empty it,
  with **Undo**.
- **New test run from these**, or add them to an existing run. The reasons go into the
  run.

The work list is kept on your computer, per repository.

### Reports

- **Report (HTML)**: a standalone page (print it to PDF).
- **Report (Markdown)**: a text version. **Save report to repository** puts it next to
  the run, to commit with it.
- **Report (PDF)**: under **Test runs**.

Reports, the Excel export and the side panel show which step failed or was blocked, with
its note, and who each case was for.

---

## Jira

Jira issues link to requirements and test cases from either side. Each link remembers
where it's written:

| Where | Example | Needs the Jira connection |
|---|---|---|
| The item's front matter | `jira: [PROJ-466]` | No |
| A commit message in the code repository | `PROJ-512: … (REQ-07)` | No |
| An issue's label | label `REQ-07` | Yes |
| An issue's custom field | a field listing `REQ-07, TC-102` | Yes |
| An issue's text | summary or description mentions `REQ-07` | Yes |
| An issue's remote link | a web link whose address or title has `REQ-07` | Yes |

```yaml
jira:
  url: https://jira.example.com
  api: 2                 # 2: Data Center / Server (personal access token); 3: Cloud (email + API token)
  projects: [PROJ]       # which KEY-123 words are Jira keys; also which issues to read
  field: Requirements    # optional custom field (its name, or customfield_12345)
  links: [labels, field, text, remote-links]   # which issue-side links count (default: all)
  jql: project = PROJ AND updated >= -365d      # optional: which issues to read
  max: 2000
```

With Jira connected, issues show their summary, status and fix versions, and a test run
can cover a **fix version**.

- **Read only**: Tracey never changes Jira. It reads the projects' issues (or the `jql`'s),
  plus every key named in front matter or commits. Keys that don't exist are listed in
  Settings.
- **Remote links** take one request per issue, for up to 500 issues.

### Tokens

Everyone uses their own token, so Jira shows what each person may see. Add yours under
**Settings → Jira**.

- **Desktop app**: the token is kept encrypted with the system keychain (Windows, macOS,
  or Linux with a keyring). Without a keychain, set `TRACE_JIRA_URL` and
  `TRACE_JIRA_TOKEN` in the environment instead.
- **Web version**: the token is kept in your browser, as a cookie the server encrypts
  with its secret (`TRACE_SECRET`, or one it creates in `<workspace>/.trace-secret`). The
  server stores no one's token, and page scripts can't read the cookie.
  - The server only talks to the Jira in `TRACE_JIRA_URL` (comma-separated for several),
    whatever a repository's `trace.yml` says.
  - `TRACE_JIRA_TOKEN` (plus `TRACE_JIRA_EMAIL` for Cloud) is an optional shared token
    for people without their own. Settings says when it's in use.

### Reaching Jira

- **Desktop app**: connects like a browser on that computer, with the certificates the
  system trusts (a company's own certificate authority) and its proxy settings.
- **Web version**: connects with Node's network stack, trusting the system's
  certificates too and using `HTTPS_PROXY` / `NO_PROXY` from its environment, like
  `curl` (Node 24 and later). Otherwise, for a company certificate authority, start the
  server with `NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem`.

The language model's server is reached the same way.

When Jira can't be reached or refuses, **Settings → Jira** says why: an unknown name
(VPN?), no answer, an untrusted certificate, a token Jira didn't accept, or a sign-in
gateway in front of Jira.

---

## The code repository

Requirements and test cases live in one repository (the one Tracey opens). The code
lives in another, whose commit messages name Jira issues (`PROJ-466: …`, or Bitbucket's
`Pull request #12: PROJ-466 …`). Tracey reads its log and never changes it:

```yaml
code:
  repository: https://bitbucket.example.com/scm/proj/app.git   # https or ssh, either matches
  branch: main         # read origin/main when the clone has it
  commits: 500         # how far back
jira:
  projects: [PROJ]     # which KEY-123 words are Jira keys (default: those used in jira: fields)
```

- **Finding the clone**: Tracey looks for a local clone with that remote among the
  repositories it knows (the desktop app's recent folders, the web server's workspace).
  Otherwise **Settings → Code repository** offers to clone it, or to choose its folder.
- **Staying current**: it fetches before reading, so new commits show up without pulling
  the code yourself.
- **What a commit links to**: Jira issues by the keys in its message, and through them the
  requirements whose `jira:` names those issues, and on to their test cases. A commit
  naming an item directly (`see REQ-22`) links to it too. Its changed files map to
  [components](#components).

---

## Import and export

### Export: PDF, Excel, CSV

**Coverage → Export…**, then a format. Every format can be limited to one component, and
leaves out obsolete items unless asked.

- **PDF document**: a specification. Every requirement and test case with its text and
  links, a traceability matrix and a coverage summary. The desktop app writes the PDF
  itself (A4, page numbers); in a browser, the print dialog's **Save as PDF** makes it.
- **Excel workbook** (.xlsx), with frozen, filterable headers. Pick the sheets:
  - requirements, with test cases, coverage, links to review and last results;
  - test cases, with what they verify and their last result;
  - the traceability matrix (requirements down, test cases across);
  - test runs, with their totals;
  - every result in every run;
  - coverage over time.
- **CSV**: one of those tables, as UTF-8 that Excel opens correctly. A cell starting with
  `=`, `+`, `-` or `@` gets a leading `'`, so it can't run as a formula.
- **needs.json**: everything, for [Sphinx-Needs](#sphinx-needs).

### Importing from DOORS

DOORS 9 and DOORS Next both export **ReqIF** (`.reqifz` or `.reqif`). Export a baseline
with its link modules. Without ReqIF, see [an HTML export](#without-reqif-an-html-export).

The import takes three steps. The commands below use the Linux AppImage; see
[Command line](#command-line) for other ways to run them.

1. **Write a map** to check: which module holds what, and which attributes and link
   types mean what. It's guessed from the export.

   ```sh
   ./Tracey.AppImage import-reqif payments.reqifz --init-map doors-map.yml
   ```

2. **Edit the map, then try it.** A dry run writes nothing, and prints a report.

   ```sh
   ./Tracey.AppImage import-reqif payments.reqifz --map doors-map.yml --into ../reqs --dry-run
   ```

3. **Import**, then check the result.

   ```sh
   ./Tracey.AppImage import-reqif payments.reqifz --map doors-map.yml --into ../reqs
   ./Tracey.AppImage check ../reqs
   ```

**Requirements and test cases in different modules**: best is one export holding both and
the link module between them. If they were exported separately, give all the exports at
once, in every step (`import-reqif reqs.reqifz tests.reqifz …`). They're read as one, so
the links between them come across. Imported separately, those links point outside the
import and are left out (the report counts them).

#### The map

The map is YAML, with what was found in the export listed at the end:

```yaml
modules:
  System Requirements: {kind: requirement, dir: requirements, prefix: REQ-}
  System Tests: {kind: testcase, dir: tests, prefix: TC-}
attributes:
  id: [Absolute Number, ID]      # the first with a value wins
  title: [Object Heading]
  text: [Object Text]
  status: Status
  variants: Variant
  components: null
  keep: [Priority]               # copied into the front matter as they are
types:
  heading: [Heading]
  note: []
values:
  status: { Approved: approved, Proposed: draft }
  testStatus: { Approved: ready, Proposed: draft }
  variants: { Base: base, Pro: pro, All: '*' }
  components: {}
links:
  verifies: [Verifies]
  refines: [Out-links]
  reversed: []
```

| Section | What it says |
|---|---|
| `modules` | Per DOORS module: `requirement`, `testcase` or `skip`, its folder, and its ID prefix. An object's number gets the prefix (SYS-123). Modules with "test" or "verification" in the name are guessed as test cases. |
| `attributes` | Which attributes hold the ID, title, text, status, variants and components. Use the attribute's name (in an HTML export, the column header); the report says when the export has no attribute by that name. |
| `types` | Object types that are headings, or information (kept in the module's README). |
| `values` | DOORS values → Tracey's statuses, variant keys and component keys. A variant value meaning every variant maps to `'*'` (guessed for All, Any, Both, Common): those items get no `variants:` list. |
| `links` | Which link types mean what. See below. |

**Links**:
- A test case and a requirement linked either way make `verifies`.
- Two requirements linked by a type under `refines` make `refines`, from the source to
  the target. If your links point from the general requirement to the detailed one, list
  the type under `reversed` too.
- In a test module, an object linked to another object of the same module is a **test
  step** of it. The steps go, in module order, into the test case's Steps list, and a
  step's links to requirements count for its test case.

#### What comes across

- **One Markdown file per requirement and test case**: the text as Markdown (bold, lists,
  tables, links), the status, variants, kept attributes, `section: 3.2 Payment`, and
  `doors: {module, id}` pointing back at the DOORS object. Objects without a title get
  one from their first sentence.
- **Links**: test cases `verifies:` their requirements, and requirements `refines:`
  theirs, already marked reviewed.
- **Pictures** in the text are copied to `images/`. An OLE object comes across as its
  picture, or as a note when the export has none.
- **A README.md per module** with its headings, information objects and order, linking to
  the items, so the document structure is kept.
- **A report**: counts per module, links left out, missing pictures, how statuses were
  mapped, attributes not copied, and IDs that clash: already in the repository, or twice
  in the export (usually two modules given the same prefix, since DOORS numbers each
  module from 1).
- **trace.yml**: written if the repository has none; otherwise the matching settings are
  printed to merge in.

It never overwrites a file, and stops when an imported ID already exists in the
repository (`--force` imports anyway). History isn't imported: commit the import as the
first version ("Imported from DOORS baseline 3.2"), keep the export file, and set the
DOORS modules read-only.

#### Without ReqIF: an HTML export

When ReqIF isn't available, export each module as HTML. Formatting, tables, pictures and
headings come across as with ReqIF; links come from a column listing them.

1. **Make a view** in DOORS with these columns:
   - **Absolute Number** (or your ID attribute);
   - the **main column** (headings and text);
   - the status and any other attributes to keep;
   - a **link column**: **Analysis → Wizard**, out-links (or in-links) through all link
     modules, showing the linked objects' **Absolute Number**. When modules' numbers
     overlap, show the module name too.

   Turn the filter off.
2. **File → Export → HTML**, as a **table** (not a book), one file per module. DOORS
   writes the pictures beside it.
3. **Import the files together**, so the links between them come across. The steps are
   the same as for ReqIF, with `import-html`:

   ```sh
   ./Tracey.AppImage import-html reqs.htm tests.htm --init-map doors-map.yml
   ./Tracey.AppImage import-html reqs.htm tests.htm --map doors-map.yml --into ../reqs --dry-run
   ./Tracey.AppImage import-html reqs.htm tests.htm --map doors-map.yml --into ../reqs
   ```

Each step first prints what it found in each file. Check it before importing:

```
System Requirements (reqs.htm): 120 rows, 14 headings, 37 links.
  “Absolute Number”: the ID
  “System Requirements”: the main column: headings and text
  “Status”: an attribute
  “Out-links”: links
```

How it reads the files:

- **Modules** are named by the page title (or the file name).
- **The ID**: a column named Absolute Number, Object Identifier or ID, or else a column of
  unique numbers or IDs. Numbers get the module's prefix (SYS-12); IDs are kept.
- **Headings and text**: Object Heading and Object Text columns, or the main column, where
  a cell in bold or an HTML heading on one line ("2.1 Payment") is a heading. The depth
  comes from an Object Level column if there is one, else from the heading numbers.
- **Links**: a column named like one (Out-links, Verifies, Satisfies…) whose cells name
  objects by Absolute Number or ID, one per line, optionally with the module's name.
- **Pictures** beside the file are copied. OLE objects written as Windows metafiles
  (.wmf, .emf) can't be shown: they're listed in the report, with a note in the text.
- **Encoding**: what the file declares, else UTF-8, else Windows-1252.

### Sphinx-Needs

Tracey writes and reads the `needs.json` that Sphinx-Needs' `needs` builder writes and
its `needimport` directive reads (format 1). A Sphinx build can then show Tracey's items,
and needs from a Sphinx project can come into Tracey.

```sh
tracey export-needs [DIR] --out needs.json --version 2.4      # also: Coverage → Export… → needs.json
tracey import-needs needs.json --into DIR --dry-run            # see what it would do
tracey import-needs needs.json --into DIR --type spec=requirement --link links=refines
```

**Export**: each item becomes a need with:
- its `id`, `type` (`req`, `test`, or a type of your own's key), `type_name`, `title`,
  `status` and `tags` (its components);
- `content`: the Markdown text as written (a MyST project reads it as is), and `docname`
  (its file);
- a list per link type (`verifies`, `refines`, `mitigates`…) and `<link>_back` for the
  other direction, plus its fields.

In Sphinx, declare the link types (`needs_extra_links` or `needs_links`) and fields to use
them there.

**Import**:
- **Types**: `req` becomes a requirement, `test` a test case, and a type of your own
  matches by key or name. Others follow `--type`, or are left out and reported.
- **Links**: a field named after a link type is that link type. The generic `links` (or
  any other) becomes the one link type that fits the two items, or what `--link` says.
- **Text** comes from `content` (or `description`, before Sphinx-Needs 4), as written.
  reStructuredText isn't converted; the report says how many look like it.
- **Tags** that are components become components; the rest a `tags` field.
- **Fields** Tracey or `trace.yml` knows come in. Others are left out and listed, unless
  `--keep-fields` names them.
- Links come in reviewed. IDs already in the repository are left as they are (links to
  them still come in), and nothing is overwritten.

---

## Command line

The desktop app and the web server both run these commands without opening a window:

| Command | What it does |
|---|---|
| `check [DIR]` | Validates a repository: duplicate IDs, broken links, unknown statuses and components, rules, and a coverage summary (per variant too). Exits 1 on errors, for CI. |
| `import-reqif EXPORT.reqifz… --init-map MAP.yml` | Writes a DOORS map to edit. |
| `import-reqif EXPORT.reqifz… --map MAP.yml [--into DIR] [--dry-run] [--force]` | Imports from DOORS. See [Importing from DOORS](#importing-from-doors). |
| `import-html MODULE.htm… …` | The same, for modules exported as HTML. |
| `export-needs [DIR] [--out needs.json] [--version V] [--project NAME]` | Writes a Sphinx-Needs needs.json. |
| `import-needs NEEDS.json [--into DIR] [--dry-run] …` | Imports a needs.json. See [Sphinx-Needs](#sphinx-needs). |
| `--help`, `--version` | The list of commands, and the version. |

How to run them:

```sh
./Tracey-0.5.0-linux-x86_64.AppImage check path/to/repo   # the desktop app (Linux)
node out/server/index.js check path/to/repo                # a build from source
npm run check -- path/to/repo                              # the same, through npm
```

A mistyped command prints the list of commands instead of opening the app.

---

## Large projects

Measured in the desktop app on generated repositories (40% requirements in three levels
of refinement, 45% test cases with steps, 15% risks, five test runs with every test case)
on the development machine. Slower machines take longer.

| | 2,000 items | 5,000 items | 10,000 items | 100,000 items |
|---|---|---|---|---|
| Open the project | 0.8 s | 1.4 s | 2.2 s | 17 s |
| Typing in an item | no pauses | no pauses | under 0.1 s per keystroke | no pauses; 0.45 s once typing stops |
| Coverage view | 0.25 s | 0.3 s | 0.5 s | 4.3 s |
| Traceability graph | 0.1 s | 0.1 s | 0.15 s | 1.2 s |
| Open a run (4,500 cases at 10,000; 45,000 at 100,000) | 0.15 s | 0.2 s | 0.2 s | 0.4 s |
| Record a result | instant | 0.05 s | 0.1 s | 0.4 s |
| Excel export | 0.2 s | 0.6 s | 1.5 s | 5 s (a 226 MB file) |

What keeps it fast:
- Only the file that changed is read again as you type. Past 20,000 files, the rest
  catches up once typing pauses.
- A run file is read and saved one case at a time.
- Lists show a few hundred rows (**Show more**, **Show all**); search and filters cover
  everything.
- The graph draws only what's in view.
- With more than a few hundred test cases, the Excel matrix sheet lists one link per row
  instead of a grid.

Tracey reads at most 200,000 Markdown files in a repository, and says so when there are
more.

---

## Development

```sh
npm install
npm run dev          # desktop app, with hot reload
npm run dev:web      # web app at http://127.0.0.1:5180, with hot reload
npm test             # unit tests (vitest)
npm run typecheck

npm run build        # builds both
npm start            # desktop app, built
npm run start:web -- --workspace ./repos --port 5180
```

### Installers

```sh
npm run dist         # an installer for this computer's system, in dist/
npm run dist:win     # Windows: Tracey-<version>-win-x64.exe
npm run dist:mac     # macOS: a .dmg (build it on a Mac)
npm run dist:linux   # Linux: an .AppImage
```

- Settings are in `electron-builder.yml`, the icon in `build/`.
- **Code signing** needs the company's certificate: set `CSC_LINK` and
  `CSC_KEY_PASSWORD` (and on macOS, notarization credentials) before building.
- **Windows on Linux** needs Wine; a Windows machine or CI runner is simpler.

### CI and releases

GitHub Actions (`.github/workflows/build.yml`) runs the type check and tests on every push
and pull request.

Pushing a tag `v1.2.3` makes a GitHub release, as version 1.2.3:

```sh
git tag v1.2.3 && git push origin v1.2.3
```

1. A draft release is created, with notes from the commits since the last one.
2. The Linux AppImage and the Windows installer are built, and each is attached to it.
3. With both on it, the release is published. If a build fails, it stays a draft:
   **Re-run failed jobs** finishes it.

Release files take none of the account's Actions storage. To build the installers without
a release, run the workflow by hand (**Actions → Build → Run workflow**) and download them
from the run's artifacts within a day.

### Code layout

```
src/core/       pure TypeScript, shared by everything (and unit-tested)
  config.ts       trace.yml, with the item types, link types and rules
  frontmatter.ts  front matter: read, and change fields keeping the rest as written
  model.ts        items, links, fingerprints, problems, coverage, rules, new IDs, component globs
  graph.ts        the traceability graph: nodes, edges, gaps, filters, column order
  graphlayout.ts  where the graph's nodes go, how links are routed, what's in view
  graphsvg.ts     the graph as a standalone SVG picture
  fields.ts       declared fields (checked, parsed) and the others (read-only); search
  bulk.ts         one change to many items: what each file gets
  links.ts        Jira issue ↔ item links from every source
  commits.ts      commits → Jira keys, item IDs and components
  impact.ts       which test cases a range of commits calls for, and why
  runs.ts         test run files: read, create, record results (per step too); releases
  steps.ts        a test case's steps, from its Steps list
  verdict.ts      results in the matrix: where they come from, each requirement's verdict
  worklist.ts     the work list: which tests an item stands for
  rename.ts       changing an ID, and everything that names it
  estimate.ts     test case time estimates and run totals
  changes.ts      what changed between two versions, and its document
  images.ts       images in an item's text, and where pasted ones go
  report.ts       a run's report as Markdown or HTML
  specdoc.ts      the specification document (HTML, printed to PDF)
  spreadsheet.ts  the export tables; xlsx.ts writes them as Excel or CSV
  trend.ts        coverage and results at each test run
  reqif.ts        ReqIF (DOORS exports); xml.ts reads XML, xhtml.ts turns its rich text into Markdown
  doors.ts        the DOORS import: the map, the files, test steps, the report
  doorshtml.ts    DOORS modules exported as HTML, read like ReqIF; html.ts reads forgiving HTML
  needs.ts        Sphinx-Needs needs.json: export, and import with its report
  suggest.ts      test cases for a Jira issue: candidates by their words, the model's question and answer
  markdown/       schema, Markdown ↔ ProseMirror with source preservation
  sample.ts       files of a new project
src/shared/api.ts the calls the interface makes to the back end
src/backend/      Node: files (with path checks), git, the Jira and language model clients, the commands
                  (cli.ts, commandline.ts), the web server's network settings (network.ts)
src/main/         Electron: window, IPC, folder dialogs, recent repositories; commands from a terminal
src/preload/      the IPC bridge
src/server/       web server (same API over HTTP), and the same commands
src/renderer/     React interface, used by both
```

### Next

From the design discussion, roughly in this order:

1. **Writing to Jira** (optional): remote links from issues back to requirements in
   Tracey, and test results on issues.
2. **Bitbucket**: Code Insights reports on pull requests ("touches REQ-12, 2 of 3 linked
   tests pass").
