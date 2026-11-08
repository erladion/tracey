// What a release touches, from the commits between two versions of the code:
//
//   commit → Jira issue → requirements and test cases linked to it (see links.ts)
//        → test cases verifying those requirements
//   Jira fix version → its issues → the same
//   commit → requirement or test case named in its message
//   commit → changed files → components (trace.yml) → test cases tagged with them
//
// Every test case to run carries the reasons it was picked.
import type { LinkedCommit } from './commits';
import { componentsForPath, type Item, type ProjectIndex } from './model';
import { buildIssueLinks, type IssueLinks } from './links';
import { isRunnable } from './config';

export type Reason =
  // req null: the issue links to the test case itself. fixVersion: the issue is in it.
  | { kind: 'issue'; issue: string; req: string | null; commits: string[]; fixVersion?: string }
  | { kind: 'item'; id: string; commits: string[] }
  | { kind: 'component'; component: string; files: number; commits: string[] };

export interface Impact {
  commits: LinkedCommit[];
  cases: Map<string, Reason[]>; // test case ID → why it's in
  requirements: Map<string, Reason[]>; // requirement ID → why it's affected
  issues: string[]; // Jira keys named in the range
  changedComponents: Map<string, number>; // component → files changed
  requirementsWithoutTests: string[]; // affected, but no test case verifies them
  componentsWithoutTests: string[]; // changed, but no test case is tagged with them
  issuesWithoutRequirement: string[]; // in the range, but linked to no requirement or test case
  commitsWithoutKeys: number; // name no issue or item
}

const live = (it: Item | undefined): it is Item => !!it && it.status !== 'obsolete';

function reasonKey(r: Reason): string {
  return r.kind === 'issue' ? `i:${r.issue}:${r.req ?? ''}` : r.kind === 'item' ? `t:${r.id}` : `c:${r.component}`;
}

function add(map: Map<string, Reason[]>, id: string, r: Reason) {
  const list = map.get(id) ?? [];
  const same = list.find((x) => reasonKey(x) === reasonKey(r));
  if (!same) list.push({ ...r, commits: [...r.commits] } as Reason);
  else {
    for (const c of r.commits) if (!same.commits.includes(c)) same.commits.push(c);
    if (same.kind === 'component' && r.kind === 'component') same.files += r.files;
    if (same.kind === 'issue' && r.kind === 'issue' && r.fixVersion) same.fixVersion = r.fixVersion;
  }
  map.set(id, list);
}

export interface ImpactOptions {
  components: boolean; // also test cases of changed components
  links?: IssueLinks; // issue ↔ item links (default: front matter only)
  fixVersion?: { name: string; issues: string[] }; // issues in a Jira fix version
}

export function impact(index: ProjectIndex, commits: LinkedCommit[], opts: ImpactOptions = { components: true }): Impact {
  const links = opts.links ?? buildIssueLinks(index);
  const cases = new Map<string, Reason[]>();
  const requirements = new Map<string, Reason[]>();
  const issues = new Set<string>();
  const issuesWithoutRequirement = new Set<string>();
  const changedComponents = new Map<string, number>();
  let commitsWithoutKeys = 0;

  const reqs = index.items.filter((i) => i.kind === 'requirement' && live(i));
  const runnable = (it: Item) => isRunnable(index.config, it.kind);
  const tests = index.items.filter((i) => runnable(i) && live(i));
  const testsOf = (reqId: string) => (index.verifiedBy.get(reqId) ?? []).filter(live);

  // An issue → the requirements and test cases linked to it → those requirements' test cases.
  const linkIssue = (issue: string, how: { commits: string[]; fixVersion?: string }) => {
    issues.add(issue);
    const linked = (links.byIssue.get(issue) ?? []).map((l) => index.byId.get(l.item)).filter(live);
    if (!linked.length) issuesWithoutRequirement.add(issue);
    for (const it of linked) {
      if (it.kind === 'requirement') {
        const reason: Reason = { kind: 'issue', issue, req: it.id, ...how };
        add(requirements, it.id, reason);
        for (const t of testsOf(it.id)) add(cases, t.id, reason);
      } else if (runnable(it)) add(cases, it.id, { kind: 'issue', issue, req: null, ...how });
      // Something else verified (an architecture element…): the tests verifying it.
      else for (const t of testsOf(it.id)) add(cases, t.id, { kind: 'issue', issue, req: null, ...how });
    }
  };
  for (const issue of opts.fixVersion?.issues ?? []) linkIssue(issue, { commits: [], fixVersion: opts.fixVersion!.name });

  for (const lc of commits) {
    const hash = lc.commit.hash.slice(0, 8);
    if (!lc.issues.length && !lc.items.length) commitsWithoutKeys++;

    for (const issue of lc.issues) linkIssue(issue, { commits: [hash] });

    for (const id of lc.items) {
      const it = index.byId.get(id);
      if (!live(it)) continue;
      const reason: Reason = { kind: 'item', id, commits: [hash] };
      if (it.kind === 'requirement') {
        add(requirements, id, reason);
        for (const t of testsOf(id)) add(cases, t.id, reason);
      } else if (runnable(it)) add(cases, id, reason);
      else for (const t of testsOf(id)) add(cases, t.id, reason);
    }

    for (const component of lc.components) {
      const files = lc.commit.files.filter((f) => componentsForPath(f, index.config.components).some((c) => c.key === component)).length;
      changedComponents.set(component, (changedComponents.get(component) ?? 0) + files);
      if (!opts.components) continue;
      const reason: Reason = { kind: 'component', component, files, commits: [hash] };
      for (const t of tests.filter((t) => t.components.includes(component))) add(cases, t.id, reason);
      for (const r of reqs.filter((r) => r.components.includes(component))) add(requirements, r.id, reason);
    }
  }

  const testedComponents = new Set(tests.flatMap((t) => t.components));
  return {
    commits,
    cases,
    requirements,
    issues: [...issues].sort(),
    changedComponents,
    requirementsWithoutTests: [...requirements.keys()].filter((id) => testsOf(id).length === 0).sort(),
    componentsWithoutTests: [...changedComponents.keys()].filter((c) => !testedComponents.has(c)).sort(),
    issuesWithoutRequirement: [...issuesWithoutRequirement].sort(),
    commitsWithoutKeys,
  };
}

export function reasonText(r: Reason, componentName: (key: string) => string = (k) => k): string {
  const n = r.commits.length;
  const commits = `${n} commit${n === 1 ? '' : 's'}`;
  if (r.kind === 'issue') {
    const why = [r.fixVersion ? `fix version ${r.fixVersion}` : '', n ? commits : ''].filter(Boolean).join(', ');
    return r.req ? `${r.issue} → ${r.req} (${why})` : `${r.issue} links to it (${why})`;
  }
  if (r.kind === 'item') return `${r.id} in ${commits}`;
  return `${componentName(r.component)} changed (${commits})`;
}
