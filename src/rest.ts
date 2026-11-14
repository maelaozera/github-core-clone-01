// The REST v3 API under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests. Every reply is JSON with an
// X-GitHub-Request-Id (added by the server); errors carry a string `message`.

import {
  contentFileView,
  issueView,
  pullView,
  repoView,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  ZERO_OID,
  type Repo,
  type Store,
} from './store.ts';
import { LogicalClock, globalId, type ApiResponse } from './util.ts';

const SHA40 = /^[0-9a-f]{40}$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, body, headers };
}

function message(status: number, text: string): ApiResponse {
  return json(status, { message: text });
}

function notFound(what = 'Not Found'): ApiResponse {
  return message(404, what);
}

function repoNotFound(): ApiResponse {
  return message(404, 'Not Found');
}

function userView(baseUrl: string): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', String(VIEWER_ID)),
    avatar_url: `${baseUrl}/avatars/${VIEWER_LOGIN}`,
    gravatar_id: '',
    url: `${baseUrl}/user`,
    html_url: `${baseUrl}/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: LogicalClock.iso(1735689600),
    updated_at: LogicalClock.iso(1735689600),
  };
}

/** Parse a page of items, honouring per_page/page, with a Link next header. */
function pageOf<T>(
  items: readonly T[],
  query: URLSearchParams,
  baseUrl: string,
  path: string,
): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(path, baseUrl);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { page: [...slice], headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, name: string): string {
  if (!isRecord(body)) return '';
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function booleanField(body: unknown, name: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[name];
  return typeof value === 'boolean' ? value : fallback;
}

/** Resolve a ref query (?ref=branch|oid) to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (SHA40.test(ref)) return repo.objects.has(ref) ? ref : null;
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? null;
}

/** A commit's REST view, from its parsed object. */
function commitView(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const commit = store.parseCommitCached(repo, oid);
  if (commit === null) return null;
  const author = {
    name: commit.authorName,
    email: commit.authorEmail,
    date: LogicalClock.iso(commit.authorTime),
  };
  const committer = {
    name: commit.committerName,
    email: commit.committerEmail,
    date: LogicalClock.iso(commit.committerTime),
  };
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: { author, committer, message: commit.message, tree: { sha: commit.tree } },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: '',
  };
}

/** Commit one contents change on `branch`; returns the new commit oid. */
function commitContentsChange(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  data: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null } {
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const baseTree = tip === null ? null : store.commitTree(repo, tip);
  const flat = baseTree === null ? new Map() : new Map(store.flattenTree(repo, baseTree));
  let blobOid: string | null = null;
  if (data === null) {
    flat.delete(path);
  } else {
    blobOid = store.putObject(repo, { type: 'blob', data });
    flat.set(path, { mode: '100644', oid: blobOid });
  }
  const tree = store.buildTreeFromFlat(repo, flat);
  const parents = tip === null ? [] : [tip];
  const commitOid = store.createCommit(repo, tree, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { commitOid, blobOid };
}

/** Handle one REST request. `segments` are the decoded path parts after /api/v3. */
export function handleRest(
  store: Store,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): ApiResponse {
  // ---- API root and meta -------------------------------------------------
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return json(
      200,
      {
        current_user_url: `${baseUrl}/api/v3/user`,
        current_user_authorizations_html_url: `${baseUrl}/settings/applications`,
        authorizations_url: `${baseUrl}/api/v3/authorizations`,
        rate_limit_url: `${baseUrl}/api/v3/rate_limit`,
        user_url: `${baseUrl}/api/v3/users/{user}`,
        repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
  }

  // ---- /user -------------------------------------------------------------
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return notFound();
      return json(200, userView(baseUrl));
    }
    if (segments[1] === 'repos') {
      if (method === 'GET') {
        const { page, headers } = pageOf(
          store.listViewerRepos().map((repo) => repoView(repo, baseUrl)),
          query,
          baseUrl,
          '/api/v3/user/repos',
        );
        return json(200, page, headers);
      }
      if (method === 'POST') {
        const name = stringField(body, 'name');
        if (name === '') return message(422, 'name is required');
        if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
          return message(422, 'Repository already exists');
        }
        const repo = store.createRepo(
          name,
          booleanField(body, 'private', false),
          stringField(body, 'description'),
        );
        return json(201, repoView(repo, baseUrl));
      }
      return notFound();
    }
    return notFound();
  }

  // ---- /repos/{owner}/{repo}/... ------------------------------------------
  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return repoNotFound();
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoView(repo, baseUrl));
    if (method === 'PATCH') {
      const description = stringField(body, 'description');
      if (isRecord(body) && 'description' in body) repo.description = description;
      if (isRecord(body) && typeof body.private === 'boolean') repo.isPrivate = body.private;
      return json(200, repoView(repo, baseUrl));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, body: '' };
    }
    return notFound();
  }

  // ---- branches ----------------------------------------------------------
  if (rest[0] === 'branches' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    const branches: Record<string, unknown>[] = [];
    for (const [ref, oid] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return json(200, branches);
  }

  // ---- git refs ----------------------------------------------------------
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (!ref.startsWith('refs/') || !SHA40.test(sha)) return message(422, 'ref and sha are required');
      if (!repo.objects.has(sha)) return message(422, 'object does not exist');
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha }, node_id: globalId('Ref', `${repo.id}:${ref}`) });
    }
    if ((method === 'GET' || method === 'DELETE') && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound();
      if (method === 'DELETE') {
        repo.refs.delete(ref);
        return { status: 204, body: '' };
      }
      return json(200, { ref, object: { sha: oid }, node_id: globalId('Ref', `${repo.id}:${ref}`) });
    }
    return notFound();
  }

  // ---- commits -----------------------------------------------------------
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    const tip = resolveRef(repo, query.get('sha'));
    if (tip === null) return json(200, []);
    const views: Record<string, unknown>[] = [];
    for (const oid of store.commitChain(repo, tip, 100)) {
      const view = commitView(store, repo, oid);
      if (view !== null) views.push(view);
    }
    return json(200, views);
  }

  // ---- contents ----------------------------------------------------------
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    const branch = query.get('ref') ?? undefined;
    if (method === 'GET') {
      const tip = resolveRef(repo, branch ?? null);
      if (tip === null) return notFound();
      const tree = store.commitTree(repo, tip);
      if (tree === null) return notFound();
      const flat = store.flattenTree(repo, tree);
      if (path === '') {
        // Root listing.
        const entries = dirEntries(store, repo, tree, '', baseUrl);
        return json(200, entries);
      }
      const file = flat.get(path);
      if (file !== undefined) {
        const blob = repo.objects.get(file.oid);
        if (blob === undefined) return notFound();
        return json(200, contentFileView(repo, path, file.oid, blob, baseUrl));
      }
      // A directory: any path that is a prefix of a file path.
      const prefix = `${path}/`;
      let isDir = false;
      for (const key of flat.keys()) {
        if (key.startsWith(prefix)) {
          isDir = true;
          break;
        }
      }
      if (!isDir) return notFound();
      return json(200, dirEntries(store, repo, tree, path, baseUrl));
    }
    if (method === 'PUT') {
      const content = stringField(body, 'content');
      const msg = stringField(body, 'message') || 'Update file';
      const targetBranch = stringField(body, 'branch') || repo.defaultBranch;
      const sha = stringField(body, 'sha');
      if (content === '') return message(422, 'content is required');
      let data: Buffer;
      try {
        data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
      } catch {
        return message(422, 'content is not valid base64');
      }
      const tip = repo.refs.get(`refs/heads/${targetBranch}`) ?? null;
      const baseTree = tip === null ? null : store.commitTree(repo, tip);
      const flat = baseTree === null ? new Map() : store.flattenTree(repo, baseTree);
      const current = flat.get(path);
      if (sha !== '') {
        if (current === undefined || current.oid !== sha) return message(409, 'sha does not match the current file');
      }
      const { commitOid, blobOid } = commitContentsChange(store, repo, targetBranch, path, data, msg);
      const blob = repo.objects.get(blobOid as string) as { type: 'blob'; data: Buffer };
      return json(current === undefined ? 201 : 200, {
        content: contentFileView(repo, path, blobOid as string, blob, baseUrl),
        commit: { sha: commitOid, message: msg },
      });
    }
    if (method === 'DELETE') {
      const msg = stringField(body, 'message') || 'Delete file';
      const targetBranch = stringField(body, 'branch') || repo.defaultBranch;
      const sha = stringField(body, 'sha');
      const tip = repo.refs.get(`refs/heads/${targetBranch}`) ?? null;
      if (tip === null) return notFound();
      const tree = store.commitTree(repo, tip);
      if (tree === null) return notFound();
      const flat = store.flattenTree(repo, tree);
      const current = flat.get(path);
      if (current === undefined) return notFound();
      if (sha !== '' && current.oid !== sha) return message(409, 'sha does not match the current file');
      const { commitOid } = commitContentsChange(store, repo, targetBranch, path, null, msg);
      return json(200, { commit: { sha: commitOid, message: msg } });
    }
    return notFound();
  }

  // ---- labels ------------------------------------------------------------
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return json(
        200,
        [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })),
      );
    }
    if (method === 'POST' && rest.length === 1) {
      const name = stringField(body, 'name');
      if (name === '') return message(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        return json(201, { name: existing.name, color: existing.color, description: existing.description });
      }
      const label = { name, color: stringField(body, 'color') || 'ededed', description: stringField(body, 'description') };
      repo.labels.set(name, label);
      return json(201, { name: label.name, color: label.color, description: label.description });
    }
    return notFound();
  }

  // ---- issues ------------------------------------------------------------
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        const key = sort === 'created' ? 'createdAt' : 'createdAt';
        issues.sort((a, b) => {
          const diff = a[key] - b[key];
          if (diff !== 0) return direction === 'asc' ? diff : -diff;
          return direction === 'asc' ? a.number - b.number : b.number - a.number;
        });
        const { page, headers } = pageOf(
          issues.map((issue) => issueView(repo, issue, baseUrl)),
          query,
          baseUrl,
          `/api/v3/repos/${owner}/${repoName}/issues`,
        );
        return json(200, page, headers);
      }
      if (method === 'POST') {
        const title = stringField(body, 'title');
        if (title === '') return message(422, 'title is required');
        const labels = isRecord(body) && Array.isArray(body.labels) ? (body.labels as unknown[]) : [];
        const names: string[] = [];
        for (const label of labels) {
          if (typeof label !== 'string') continue;
          if (!repo.labels.has(label)) return message(422, `label ${JSON.stringify(label)} does not exist`);
          names.push(label);
        }
        const issue = store.createIssue(repo, title, stringField(body, 'body'), names);
        return json(201, issueView(repo, issue, baseUrl));
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return notFound();
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return json(200, issueView(repo, issue, baseUrl));
      if (method === 'PATCH') {
        if (isRecord(body) && typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
          issue.state = body.state;
          issue.updatedAt = store.clock.now();
        }
        if (isRecord(body) && typeof body.title === 'string') {
          (issue as { title: string }).title = body.title;
        }
        if (isRecord(body) && typeof body.body === 'string') {
          (issue as { body: string }).body = body.body;
        }
        return json(200, issueView(repo, issue, baseUrl));
      }
      return notFound();
    }
    if (rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'GET') {
        const comments = (repo.comments.get(number) ?? []).map((comment) => ({
          id: comment.id,
          node_id: comment.nodeId,
          url: `${baseUrl}/repos/${owner}/${repoName}/issues/comments/${comment.id}`,
          html_url: `${baseUrl}/${owner}/${repoName}/issues/${number}#issuecomment-${comment.id}`,
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: LogicalClock.iso(comment.createdAt),
          updated_at: LogicalClock.iso(comment.createdAt),
        }));
        return json(200, comments);
      }
      if (method === 'POST') {
        const text = stringField(body, 'body');
        if (text === '') return message(422, 'body is required');
        const comment = store.createComment(repo, number, text);
        return json(201, {
          id: comment.id,
          node_id: comment.nodeId,
          url: `${baseUrl}/repos/${owner}/${repoName}/issues/comments/${comment.id}`,
          html_url: `${baseUrl}/${owner}/${repoName}/issues/${number}#issuecomment-${comment.id}`,
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: LogicalClock.iso(comment.createdAt),
          updated_at: LogicalClock.iso(comment.createdAt),
        });
      }
      return notFound();
    }
    return notFound();
  }

  // ---- pulls -------------------------------------------------------------
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.number - a.number);
        const { page, headers } = pageOf(
          pulls.map((pull) => pullView(store, repo, pull, baseUrl)),
          query,
          baseUrl,
          `/api/v3/repos/${owner}/${repoName}/pulls`,
        );
        return json(200, page, headers);
      }
      if (method === 'POST') {
        const title = stringField(body, 'title');
        const head = stringField(body, 'head');
        const base = stringField(body, 'base');
        if (title === '' || head === '' || base === '') return message(422, 'title, head and base are required');
        if (repo.refs.get(`refs/heads/${head}`) === undefined) return message(422, `head branch ${head} does not exist`);
        if (repo.refs.get(`refs/heads/${base}`) === undefined) return message(422, `base branch ${base} does not exist`);
        const pull = store.createPull(repo, title, stringField(body, 'body'), head, base);
        return json(201, pullView(store, repo, pull, baseUrl));
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return notFound();
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (pull === undefined) return notFound();
      if (method === 'GET') return json(200, pullView(store, repo, pull, baseUrl));
      return notFound();
    }
    if (rest[2] === 'files' && rest.length === 3) {
      if (pull === undefined) return notFound();
      if (method !== 'GET') return notFound();
      const files = store.pullFiles(repo, pull).map((change) => ({
        sha: change.newOid ?? change.oldOid ?? ZERO_OID,
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
        blob_url: `${baseUrl}/${owner}/${repoName}/blob/${pull.headRef}/${change.path}`,
        raw_url: `${baseUrl}/${owner}/${repoName}/raw/${pull.headRef}/${change.path}`,
        contents_url: `${baseUrl}/repos/${owner}/${repoName}/contents/${change.path}`,
      }));
      return json(200, files);
    }
    if (rest[2] === 'merge' && rest.length === 3) {
      if (pull === undefined) return notFound();
      if (method !== 'PUT') return notFound();
      if (pull.merged) return message(405, 'pull request is already merged');
      if (pull.state !== 'open') return message(405, 'pull request is closed');
      if (!store.pullMergeable(repo, pull)) return message(405, 'merge conflict: the head branch conflicts with the base branch');
      const commitOid = store.mergePull(repo, pull, `${pull.title} (#${pull.number})`);
      if (commitOid === null) return message(405, 'merge conflict: the head branch conflicts with the base branch');
      return json(200, { sha: commitOid, merged: true, message: 'Pull request successfully merged' });
    }
    return notFound();
  }

  return notFound();
}

/** The entries of a directory listing for GET /contents on a directory. */
function dirEntries(
  store: Store,
  repo: Repo,
  treeOid: string,
  dirPath: string,
  baseUrl: string,
): Record<string, unknown>[] {
  const flat = store.flattenTree(repo, treeOid);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const files = new Map<string, { mode: string; oid: string }>();
  const dirs = new Set<string>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) files.set(rest, entry);
    else dirs.add(rest.slice(0, slash));
  }
  const entries: Record<string, unknown>[] = [];
  for (const name of [...dirs].sort()) {
    // The directory's tree oid: rebuild from its own flat subset.
    const subFlat = new Map<string, { mode: string; oid: string }>();
    const subPrefix = `${prefix}${name}/`;
    for (const [path, entry] of flat) {
      if (path.startsWith(subPrefix)) subFlat.set(path.slice(subPrefix.length), entry);
    }
    const subTree = store.buildTreeFromFlat(repo, subFlat);
    entries.push({
      type: 'dir',
      name,
      path: `${prefix}${name}`,
      sha: subTree,
      url: `${baseUrl}/repos/${repo.owner}/${repo.name}/contents/${prefix}${name}`,
    });
  }
  for (const [name, entry] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const blob = repo.objects.get(entry.oid);
    entries.push({
      type: 'file',
      encoding: 'base64',
      size: blob === undefined ? 0 : blob.data.length,
      name,
      path: `${prefix}${name}`,
      sha: entry.oid,
      url: `${baseUrl}/repos/${repo.owner}/${repo.name}/contents/${prefix}${name}`,
    });
  }
  return entries;
}
