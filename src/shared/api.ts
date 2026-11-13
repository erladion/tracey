// What the interface asks of the back end. The same calls go over Electron IPC (the
// desktop app) or HTTP (the web server); both end up in backend/service.ts.
import type { SourceFile } from '../core/model';

export interface RepoEntry {
  id: string; // desktop: the folder's path; web: its name in the server's workspace
  name: string;
  location: string; // shown to the user
}

export interface ProjectFiles {
  config: string | null; // trace.yml, if there is one
  files: SourceFile[]; // Markdown files with front matter
  truncated?: number; // more Markdown files than this: the rest weren't read
}

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted';

export interface GitChange {
  path: string;
  kind: ChangeKind;
  from?: string;
}

export interface GitStatus {
  branch: string | null; // null: detached
  upstream: string | null;
  hasRemote: boolean;
  head: string | null; // the current commit
  ahead: number;
  behind: number;
  changes: GitChange[];
  merging: boolean; // getting the latest stopped on conflicts, to resolve in Tracey
}

// A file both you and the server changed: before, yours, the server's (null: not there).
export interface ConflictVersions {
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

export interface Branches {
  current: string | null;
  local: string[];
  remote: string[]; // origin/x, without HEAD
}

export interface FileCommit {
  commit: string;
  author: string;
  date: string; // ISO 8601
  message: string;
  path: string; // the file's name in that commit
}

// Who last changed each line of a file as it is on disk.
export interface Blame {
  lines: { commit: string | null; text: string }[]; // commit null: not committed yet
  commits: Record<string, { author: string; date: string; message: string }>;
}

// A commit in the code's history, with the files it changed.
export interface Commit {
  hash: string;
  author: string;
  date: string; // ISO 8601
  subject: string;
  body: string;
  files: string[];
}

// A Jira issue, in the same shape from Data Center (API 2) and Cloud (API 3).
export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done' | '';
  type: string;
  labels: string[];
  fixVersions: string[];
  description: string; // plain text
  field: string[]; // the values of the configured requirements field, if any
  remoteLinks: { url: string; title: string }[] | null; // null: not read
}

// A version (release) of a Jira project.
export interface JiraVersion {
  name: string;
  released: boolean;
  releaseDate: string | null; // 2026-12-01
  project: string;
  order: number; // where the project lists it
}

export interface JiraServer {
  url: string; // https://jira.example.com
  api: 2 | 3; // 2: Data Center / Server (personal access token); 3: Cloud (email + API token)
}

export interface JiraStatus {
  hasToken: boolean;
  shared: boolean; // the token is the web server's, used by everyone who hasn't added their own
  canStore: boolean; // a token can be entered here
  storedIn: 'computer' | 'browser'; // where an entered token is kept
  encrypted: boolean; // false: this computer has no keychain, so it's kept in a file only the user can read
  user: string | null; // who the token signs in as
  error: string | null;
}

// The language model (an OpenAI-style API) suggesting test cases for Jira issues.
export interface LlmStatus {
  editable: boolean; // set here (desktop), or where the server runs (web)
  url: string; // '' : not set up
  model: string; // '' : the server's first
  hasKey: boolean;
  keyFrom: 'keychain' | 'file' | 'environment' | null; // where the key in use comes from
  keychain: boolean; // a key saved now is encrypted; false: kept in a file only the user can read
  think: boolean; // let reasoning models think before answering
  candidates: number; // test cases offered per issue; 0: from the context size
  models: string[]; // what the server lists
  contextSize: number | null; // the model's context window, when the server says
  error: string | null;
}

export interface LlmSettings {
  url: string;
  model: string;
  key?: string | null; // undefined: keep the saved one; null or '': remove it
  think: boolean;
  candidates: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Identity {
  name: string;
  email: string;
}

export interface Api {
  // Repositories
  listRepos(): Promise<RepoEntry[]>;
  openFolder(): Promise<RepoEntry | null>; // desktop only: a folder dialog
  openRepo(id: string): Promise<RepoEntry>;
  forgetRepo(id: string): Promise<void>;
  cloneRepo(url: string): Promise<RepoEntry | null>; // null: cancelled
  createProject(name: string, examples: boolean): Promise<RepoEntry | null>;

  // Files
  loadFiles(repo: string): Promise<ProjectFiles>;
  // The requirements and test cases as they were in a commit; null if it isn't there.
  loadFilesAt(repo: string, commit: string): Promise<ProjectFiles | null>;
  writeFile(repo: string, path: string, text: string): Promise<void>;
  deleteFile(repo: string, path: string): Promise<void>;
  // An image (base64): saved at `path`, or beside it with -2, -3… if that's taken. The path used.
  addImage(repo: string, path: string, data: string): Promise<string>;

  // Git
  gitStatus(repo: string): Promise<GitStatus | null>; // null: not a git repository
  gitIdentity(repo: string): Promise<Identity | null>;
  gitCommit(repo: string, message: string, paths: string[], author: Identity | null): Promise<void>;
  gitFetch(repo: string): Promise<void>;
  // 'conflicts' when it stopped on them (GitStatus.merging). author: for a merge commit.
  gitPull(repo: string, author?: Identity | null): Promise<string>;
  gitConflict(repo: string, path: string): Promise<ConflictVersions>;
  gitResolve(repo: string, path: string, text: string | null): Promise<void>; // the merged file; null deletes it
  gitFinishMerge(repo: string, author: Identity | null): Promise<void>;
  gitAbortMerge(repo: string): Promise<void>;
  gitPush(repo: string): Promise<string>;
  gitBranches(repo: string): Promise<Branches>;
  gitCheckout(repo: string, branch: string, create: boolean): Promise<void>;
  gitLog(repo: string, path: string): Promise<FileCommit[]>;
  gitShow(repo: string, commit: string, path: string): Promise<string | null>;
  gitBlame(repo: string, path: string): Promise<Blame | null>; // null: not in git yet
  // The code repository's history: newest first, on `branch` (the server's copy when
  // there is one); [] if it isn't a repository.
  gitCommits(repo: string, limit: number, branch: string | null): Promise<Commit[]>;
  // A repository Tracey knows whose remote is `url`, if any.
  findRepoByRemote(url: string): Promise<RepoEntry | null>;
  // Versions: tags, newest version first.
  gitTags(repo: string): Promise<string[]>;
  // The commits in `to` that aren't in `from` (tags, branches or commits), and the commit `to` is.
  gitRange(repo: string, from: string, to: string): Promise<{ commits: Commit[]; to: string }>;
  // A tag, branch or commit as the commit it is.
  gitCommitOf(repo: string, ref: string): Promise<string>;

  // A document (HTML) as a PDF file, saved where the user chooses: the file's path, or
  // null if cancelled. Desktop only: the web version prints from the browser.
  exportPdf(html: string, fileName: string): Promise<string | null>;

  // Jira
  jiraStatus(server: JiraServer): Promise<JiraStatus>;
  jiraSetToken(server: JiraServer, token: string, email: string | null): Promise<void>; // desktop; '' removes it
  // Issues matching JQL (up to `max`), with `field` (a custom field's id or name) read into JiraIssue.field.
  jiraSearch(server: JiraServer, jql: string, field: string | null, max: number): Promise<{ issues: JiraIssue[]; total: number; missing: string[] }>;
  jiraRemoteLinks(server: JiraServer, keys: string[]): Promise<Record<string, { url: string; title: string }[]>>;
  // The projects' versions (releases), archived ones left out.
  jiraVersions(server: JiraServer, projects: string[]): Promise<JiraVersion[]>;

  // The language model
  llmStatus(): Promise<LlmStatus>;
  llmSetup(settings: LlmSettings): Promise<void>; // desktop only
  // The model's answer; json: ask for JSON only where the server can.
  llmChat(messages: ChatMessage[], json: boolean): Promise<string>;
}

export type ApiMethod = keyof Api;

export const API_METHODS: ApiMethod[] = [
  'listRepos',
  'openFolder',
  'openRepo',
  'forgetRepo',
  'cloneRepo',
  'createProject',
  'loadFiles',
  'loadFilesAt',
  'writeFile',
  'deleteFile',
  'addImage',
  'gitStatus',
  'gitIdentity',
  'gitCommit',
  'gitFetch',
  'gitPull',
  'gitConflict',
  'gitResolve',
  'gitFinishMerge',
  'gitAbortMerge',
  'gitPush',
  'gitBranches',
  'gitCheckout',
  'gitLog',
  'gitShow',
  'gitBlame',
  'gitCommits',
  'findRepoByRemote',
  'gitTags',
  'gitRange',
  'gitCommitOf',
  'exportPdf',
  'jiraStatus',
  'jiraSetToken',
  'jiraSearch',
  'jiraRemoteLinks',
  'jiraVersions',
  'llmStatus',
  'llmSetup',
  'llmChat',
];
