// The forge's store: every repository, ref, object, issue, pull request and
// label, in memory. One process, no database: the trial is short-lived and
// the suite drives everything through the API, so the store is the source of
// truth and the REST, GraphQL, git and MCP surfaces all read it.
//
// Determinism: ids come from counters, timestamps from the logical clock, and
// iteration follows insertion order, so two runs fed the same requests leave
// the same observable state.

import {
  buildCommit,
  buildTag,
  buildTree,
  makeBlob,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  treeSortKey,
  type GitObject,
  type ObjectType,
  type ParsedCommit,
  type TreeEntry,
} from './git.ts';
import { LogicalClock, b64encode, globalId } from './util.ts';

/** The login the trial token names (the sealed scenario's viewer, wire.ts). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  readonly labels: string[];
  readonly createdAt: number;
  updatedAt: number;
  readonly nodeId: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: number;
  readonly nodeId: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly createdAt: number;
  updatedAt: number;
  readonly nodeId: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly createdAt: number;
  readonly nodeId: string;
  /** refname -> oid. */
  readonly refs: Map<string, string>;
  /** oid -> object (verbatim bytes). */
  readonly objects: Map<string, GitObject>;
  /** oid -> parsed commit, cached. */
  readonly commitCache: Map<string, ParsedCommit>;
  /** tree oid -> flattened path map, cached. */
  readonly flatCache: Map<string, Map<string, { mode: string; oid: string }>>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  readonly labels: Map<string, Label>;
  /** issue number -> comments. */
  readonly comments: Map<number, Comment[]>;
  /** One counter shared by issues and pull requests, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** The forge's whole state. */
export class Store {
  readonly clock = new LogicalClock();
  private nextRepoId = 1;
  private nextCreatedSeq = 1;
  /** `${owner}/${name}` -> repo. Only the viewer's repos exist. */
  readonly repos = new Map<string, Repo>();

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const createdAt = this.clock.tick();
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repo = {
      id,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextCreatedSeq,
      createdAt,
      nodeId: globalId('Repository', String(id)),
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      commitCache: new Map<string, ParsedCommit>(),
      flatCache: new Map<string, Map<string, { mode: string; oid: string }>>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, Pull>(),
      labels: new Map<string, Label>(),
      comments: new Map<number, Comment[]>(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextCreatedSeq += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  // ------------------------------------------------------------------ objects

  /** Store an object, returning its id. Verbatim bytes; the id is recomputed. */
  putObject(repo: Repo, object: GitObject): string {
    const oid = objectId(object.type, object.data);
    repo.objects.set(oid, object);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  parseCommitCached(repo: Repo, oid: string): ParsedCommit | null {
    const cached = repo.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    repo.commitCache.set(oid, parsed);
    return parsed;
  }

  /** All ancestors of `oid` (commit oids), including `oid` itself. */
  ancestors(repo: Repo, oid: string, limit = 100000): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [oid];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (seen.size > limit) break;
      const commit = this.parseCommitCached(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return seen;
  }

  /** True when `descendant` is `ancestor` or descends from it. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const queue: string[] = [descendant];
    const seen = new Set<string>();
    let steps = 0;
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      steps += 1;
      if (steps > 100000) return false;
      const commit = this.parseCommitCached(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return false;
  }

  /** The merge-base of two commits: the first common ancestor found from `b`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsOfA = this.ancestors(repo, a);
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (ancestorsOfA.has(current)) return current;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.parseCommitCached(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return null;
  }

  /** The first-parent chain from `tip`, newest first, capped. */
  commitChain(repo: Repo, tip: string, limit = 1000): string[] {
    const chain: string[] = [];
    let current: string | undefined = tip;
    const seen = new Set<string>();
    while (current !== undefined && chain.length < limit && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      const commit = this.parseCommitCached(repo, current);
      current = commit === null ? undefined : commit.parents[0];
    }
    return chain;
  }

  // ------------------------------------------------------------------ trees

  /** Flatten a tree into path -> {mode, oid}, recursively, cached per tree. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const cached = repo.flatCache.get(treeOid);
    if (cached !== undefined) return cached;
    const flat = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else flat.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    repo.flatCache.set(treeOid, flat);
    return flat;
  }

  /** All object ids reachable from a tree (the tree, its subtrees, its blobs). */
  treeReachable(repo: Repo, treeOid: string): Set<string> {
    const reachable = new Set<string>();
    const walk = (oid: string): void => {
      if (reachable.has(oid)) return;
      reachable.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) walk(entry.oid);
    };
    walk(treeOid);
    return reachable;
  }

  /** All object ids reachable from a commit (itself, its tree, its ancestors). */
  commitReachable(repo: Repo, commitOid: string): Set<string> {
    const reachable = new Set<string>();
    const queue: string[] = [commitOid];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (reachable.has(current)) continue;
      reachable.add(current);
      const commit = this.parseCommitCached(repo, current);
      if (commit === null) {
        // A tag object: follow its target.
        const object = repo.objects.get(current);
        if (object !== undefined && object.type === 'tag') {
          const tag = parseTag(object.data);
          queue.push(tag.object);
        }
        continue;
      }
      for (const parent of commit.parents) queue.push(parent);
      for (const oid of this.treeReachable(repo, commit.tree)) reachable.add(oid);
    }
    return reachable;
  }

  /** Build (and store) a tree from a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
    // Group paths by their first segment, recursively.
    const build = (paths: { segments: string[]; mode: string; oid: string }[]): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, { segments: string[]; mode: string; oid: string }[]>();
      for (const item of paths) {
        if (item.segments.length === 1) {
          entries.push({ mode: item.mode, name: item.segments[0] as string, oid: item.oid });
        } else {
          const head = item.segments[0] as string;
          const rest = dirs.get(head) ?? [];
          rest.push({ segments: item.segments.slice(1), mode: item.mode, oid: item.oid });
          dirs.set(head, rest);
        }
      }
      for (const [name, children] of dirs) {
        const subOid = build(children);
        entries.push({ mode: '40000', name, oid: subOid });
      }
      entries.sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
      const data = buildTree(entries);
      return this.putObject(repo, { type: 'tree', data });
    };
    const items: { segments: string[]; mode: string; oid: string }[] = [];
    for (const [path, entry] of flat) {
      items.push({ segments: path.split('/'), mode: entry.mode, oid: entry.oid });
    }
    return build(items);
  }

  /** Create a commit object (author = the viewer) and store it; returns its oid. */
  createCommit(
    repo: Repo,
    tree: string,
    parents: readonly string[],
    message: string,
  ): string {
    const time = this.clock.tick();
    const data = buildCommit({
      tree,
      parents,
      authorName: VIEWER_NAME,
      authorEmail: VIEWER_EMAIL,
      authorTime: time,
      committerName: VIEWER_NAME,
      committerEmail: VIEWER_EMAIL,
      committerTime: time,
      message,
    });
    return this.putObject(repo, { type: 'commit', data });
  }

  /** Create an annotated tag object and store it; returns its oid. */
  createTag(repo: Repo, target: string, targetType: ObjectType, name: string, message: string): string {
    const time = this.clock.tick();
    const data = buildTag({
      object: target,
      type: targetType,
      tag: name,
      taggerName: VIEWER_NAME,
      taggerEmail: VIEWER_EMAIL,
      taggerTime: time,
      message,
    });
    return this.putObject(repo, { type: 'tag', data });
  }

  /** The commit a tag object points at (peeling through nested tags). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      current = parseTag(object.data).object;
    }
    return null;
  }

  /** The tree oid of a commit, or null. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const commit = this.parseCommitCached(repo, commitOid);
    return commit === null ? null : commit.tree;
  }

  // ------------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const createdAt = this.clock.tick();
    const issue: Issue = {
      id: repo.id * 1000000 + number,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt,
      updatedAt: createdAt,
      nodeId: globalId('Issue', `${repo.id}:${number}`),
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment {
    const id = repo.nextCommentId;
    repo.nextCommentId += 1;
    const comment: Comment = {
      id,
      body,
      createdAt: this.clock.tick(),
      nodeId: globalId('IssueComment', `${repo.id}:${issueNumber}:${id}`),
    };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // ------------------------------------------------------------------ pulls

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const createdAt = this.clock.tick();
    const pull: Pull = {
      id: repo.id * 1000000 + number,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      createdAt,
      updatedAt: createdAt,
      nodeId: globalId('PullRequest', `${repo.id}:${number}`),
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The file changes between two trees, by path. */
  diffTrees(
    repo: Repo,
    baseTree: string | null,
    headTree: string | null,
  ): FileChange[] {
    const base = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const head = headTree === null ? new Map() : this.flattenTree(repo, headTree);
    const changes: FileChange[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) {
        changes.push({ path, status: 'added', additions: this.countLines(repo, h.oid), deletions: 0, oldOid: null, newOid: h.oid });
      } else if (b !== undefined && h === undefined) {
        changes.push({ path, status: 'removed', additions: 0, deletions: this.countLines(repo, b.oid), oldOid: b.oid, newOid: null });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const [additions, deletions] = this.diffLineCounts(repo, b.oid, h.oid);
        changes.push({ path, status: 'modified', additions, deletions, oldOid: b.oid, newOid: h.oid });
      }
    }
    return changes;
  }

  private countLines(repo: Repo, blobOid: string): number {
    const object = repo.objects.get(blobOid);
    if (object === undefined) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  /** Added/removed line counts between two blobs (common prefix/suffix trim). */
  private diffLineCounts(repo: Repo, oldOid: string, newOid: string): [number, number] {
    const oldObject = repo.objects.get(oldOid);
    const newObject = repo.objects.get(newOid);
    if (oldObject === undefined || newObject === undefined) return [0, 0];
    const oldLines = oldObject.data.toString('utf8').split('\n');
    const newLines = newObject.data.toString('utf8').split('\n');
    if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
    if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    return [newLines.length - prefix - suffix, oldLines.length - prefix - suffix];
  }

  /** The files a pull request changes (merge-base tree vs head tree). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headOid = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headOid === undefined || baseOid === undefined) return [];
    const baseCommit = this.mergeBase(repo, baseOid, headOid);
    const baseTree = baseCommit === null ? null : this.commitTree(repo, baseCommit);
    const headTree = this.commitTree(repo, headOid);
    return this.diffTrees(repo, baseTree, headTree);
  }

  /**
   * Whether a pull request can merge: every path the head changed since the
   * merge-base must be unchanged on the base tip since the merge-base.
   */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const headOid = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headOid === undefined || baseOid === undefined) return false;
    const baseCommit = this.mergeBase(repo, baseOid, headOid);
    if (baseCommit === null) return false;
    const baseTree = this.commitTree(repo, baseCommit);
    const headTree = this.commitTree(repo, headOid);
    const tipTree = this.commitTree(repo, baseOid);
    if (baseTree === null || headTree === null || tipTree === null) return false;
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const tipFlat = this.flattenTree(repo, tipTree);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const headChanged = (b?.oid ?? null) !== (h?.oid ?? null);
      if (!headChanged) continue;
      const t = tipFlat.get(path);
      const baseChanged = (b?.oid ?? null) !== (t?.oid ?? null);
      if (baseChanged) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit
   * oid, or null when the pull request conflicts.
   */
  mergePull(repo: Repo, pull: Pull, message: string): string | null {
    if (!this.pullMergeable(repo, pull)) return null;
    const headOid = repo.refs.get(`refs/heads/${pull.headRef}`) as string;
    const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`) as string;
    const baseCommit = this.mergeBase(repo, baseOid, headOid) as string;
    const baseTree = this.commitTree(repo, baseCommit) as string;
    const headTree = this.commitTree(repo, headOid) as string;
    const tipTree = this.commitTree(repo, baseOid) as string;
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const tipFlat = this.flattenTree(repo, tipTree);
    const merged = new Map(tipFlat);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      if ((b?.oid ?? null) === (h?.oid ?? null)) continue;
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
    }
    const tree = this.buildTreeFromFlat(repo, merged);
    const commitOid = this.createCommit(repo, tree, [baseOid], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.clock.now();
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = this.clock.now();
    return commitOid;
  }
}

// ------------------------------------------------------------------ views

/** The GitHub-shaped repository object for REST and MCP. */
export function repoView(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: {
      login: repo.owner,
      id: VIEWER_ID,
      node_id: globalId('User', String(VIEWER_ID)),
      type: 'User',
    },
    private: repo.isPrivate,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    created_at: LogicalClock.iso(repo.createdAt),
    updated_at: LogicalClock.iso(repo.createdAt),
    pushed_at: LogicalClock.iso(repo.createdAt),
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
    git_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

/** The GitHub-shaped issue object. */
export function issueView(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${baseUrl}/repos/${repo.owner}/${repo.name}`,
    labels_url: `${baseUrl}/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `${baseUrl}/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `${baseUrl}/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: 'ededed', description: '' })),
    assignee: null,
    assignees: [],
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: LogicalClock.iso(issue.createdAt),
    updated_at: LogicalClock.iso(issue.updatedAt),
    closed_at: issue.state === 'closed' ? LogicalClock.iso(issue.updatedAt) : null,
    author_association: 'OWNER',
  };
}

/** The GitHub-shaped pull request object. */
export function pullView(
  store: Store,
  repo: Repo,
  pull: Pull,
  baseUrl: string,
): Record<string, unknown> {
  const headOid = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [],
    created_at: LogicalClock.iso(pull.createdAt),
    updated_at: LogicalClock.iso(pull.updatedAt),
    closed_at: pull.state === 'closed' ? LogicalClock.iso(pull.updatedAt) : null,
    merged_at: pull.mergedAt === null ? null : LogicalClock.iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: store.pullMergeable(repo, pull),
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headOid,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      repo: repoView(repo, baseUrl),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseOid,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      repo: repoView(repo, baseUrl),
    },
  };
}

/** A file entry for GET /contents on a file. */
export function contentFileView(
  repo: Repo,
  path: string,
  blobOid: string,
  blob: GitObject,
  baseUrl: string,
): Record<string, unknown> {
  const name = path.split('/').pop() as string;
  return {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name,
    path,
    content: b64encode(blob.data),
    sha: blobOid,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `${baseUrl}/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: `${baseUrl}/repos/${repo.owner}/${repo.name}/contents/${path}?raw=1`,
  };
}
