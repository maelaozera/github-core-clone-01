// GraphQL v4 at /api/graphql: a small parser and executor for exactly the
// documents gh and github-mcp-server send (plus __type introspection and
// batched bodies). Unknown fields answer HTTP 200 with an errors array, as
// the suite requires; an unknown repository reads data.repository = null.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { LogicalClock, type ApiResponse } from './util.ts';

// -------------------------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface Argument {
  readonly name: string;
  readonly value: Value;
}

interface FieldSelection {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: readonly Argument[];
  readonly selections: readonly Selection[];
}

interface FragmentSelection {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selections: readonly Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly selections: readonly Selection[];
}

interface FragmentDefinition {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: readonly Selection[];
}

interface Token {
  readonly type: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  readonly value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < input.length && input[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && input.slice(index, index + 3) === '...') {
      tokens.push({ type: 'spread', value: '...' });
      index += 3;
      continue;
    }
    if ('{}():!=$[]@'.includes(char)) {
      tokens.push({ type: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < input.length) {
        const current = input[index] as string;
        if (current === '"') {
          index += 1;
          break;
        }
        if (current === '\\' && index + 1 < input.length) {
          const escaped = input[index + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          index += 2;
          continue;
        }
        value += current;
        index += 1;
      }
      tokens.push({ type: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let value = '';
      while (index < input.length && /[0-9.]/.test(input[index] as string)) {
        value += input[index];
        index += 1;
      }
      tokens.push({ type: value.includes('.') ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (index < input.length && /[A-Za-z0-9_]/.test(input[index] as string)) {
        value += input[index];
        index += 1;
      }
      tokens.push({ type: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private position = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.position];
  }

  next(): Token {
    const token = this.tokens[this.position];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.position += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  expectName(value?: string): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDefinition> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.type === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.type === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      const kind = this.expectName();
      if (kind !== 'query' && kind !== 'mutation') throw new Error(`unsupported operation ${JSON.stringify(kind)}`);
      let name: string | null = null;
      const next = this.peek();
      if (next !== undefined && next.type === 'name') name = this.next().value;
      this.skipVariableDefinitions();
      operations.push({ kind, name, selections: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    const next = this.peek();
    if (next === undefined || next.type !== 'punct' || next.value !== '(') return;
    let depth = 0;
    while (this.peek() !== undefined) {
      const token = this.next();
      if (token.type === 'punct' && token.value === '(') depth += 1;
      else if (token.type === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private skipDirectives(): void {
    while (this.peek() !== undefined && this.peek()?.type === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      const next = this.peek();
      if (next !== undefined && next.type === 'punct' && next.value === '(') this.parseArguments();
    }
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.type === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.type === 'spread') {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.type === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        } else if (next !== undefined && next.type === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeCondition: `fragment:${name}`, selections: [] });
        } else {
          throw new Error('a fragment spread needs a name or an inline condition');
        }
        continue;
      }
      selections.push(this.parseField());
    }
  }

  parseField(): FieldSelection {
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    const next = this.peek();
    if (next !== undefined && next.type === 'punct' && next.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Argument[] = [];
    const afterName = this.peek();
    if (afterName !== undefined && afterName.type === 'punct' && afterName.value === '(') {
      args = this.parseArguments();
    }
    this.skipDirectives();
    let selections: Selection[] = [];
    const afterArgs = this.peek();
    if (afterArgs !== undefined && afterArgs.type === 'punct' && afterArgs.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseArguments(): Argument[] {
    this.expectPunct('(');
    const args: Argument[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated argument list');
      if (token.type === 'punct' && token.value === ')') {
        this.next();
        return args;
      }
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
  }

  parseValue(): Value {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.type === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.type === 'punct' && token.value === '[') {
      const items: Value[] = [];
      for (;;) {
        const next = this.peek();
        if (next === undefined) throw new Error('unterminated list value');
        if (next.type === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      for (;;) {
        const next = this.peek();
        if (next === undefined) throw new Error('unterminated object value');
        if (next.type === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// -------------------------------------------------------------------------------- schema

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'description', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'files', 'headRefOid', 'baseRefOid',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes'],
  PullRequestFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
});

const SCHEMA_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
});

// -------------------------------------------------------------------------------- execution

type GqlValue = Record<string, unknown> & { __typename?: string };

interface ExecContext {
  readonly store: Store;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, FragmentDefinition>;
  readonly errors: { message: string }[];
}

function valueOf(value: Value, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldSelection, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoViewGql(store: Store, repo: Repo): GqlValue {
  return {
    __typename: 'Repository',
    id: repo.nodeId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: VIEWER_LOGIN },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    url: `/${repo.owner}/${repo.name}`,
    _repo: repo,
    _store: store,
  };
}

function issueViewGql(repo: Repo, issue: { number: number; title: string; state: string; body: string; nodeId: string; createdAt: number }): GqlValue {
  return {
    __typename: 'Issue',
    id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
    createdAt: LogicalClock.iso(issue.createdAt),
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullViewGql(store: Store, repo: Repo, pull: Pull): GqlValue {
  return {
    __typename: 'PullRequest',
    id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state.toUpperCase(),
    merged: pull.merged,
    mergeable: store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: repo.refs.get(`refs/heads/${pull.headRef}`) ?? null,
    baseRefOid: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null,
    _repo: repo,
    _pull: pull,
    _store: store,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRootField(field: FieldSelection, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const store = ctx.store;
  if (field.name === '__type') {
    const name = args.name;
    if (typeof name !== 'string') return null;
    const fields = SCHEMA_FIELDS[name];
    const enumValues = SCHEMA_ENUMS[name];
    if (fields === undefined && enumValues === undefined) return null;
    return {
      __typename: '__Type',
      name,
      _fields: fields ?? [],
      _enumValues: enumValues ?? [],
    };
  }
  if (field.name === '__schema') {
    return {
      __typename: '__Schema',
      types: [...Object.keys(SCHEMA_FIELDS), ...Object.keys(SCHEMA_ENUMS)].map((name) => ({ name })),
    };
  }
  if (field.name === 'viewer') {
    return { __typename: 'User', login: VIEWER_LOGIN, id: String(VIEWER_ID) };
  }
  if (field.name === 'repository') {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = store.getRepo(owner, name);
    return repo === undefined ? null : repoViewGql(store, repo);
  }
  if (field.name === 'node') {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const repoId = Number(decoded.key);
      for (const repo of store.repos.values()) {
        if (repo.id === repoId) return repoViewGql(store, repo);
      }
    }
    return null;
  }
  if (field.name === 'createIssue') {
    const input = isRecord(args.input) ? args.input : {};
    const repo = findRepoByGlobalId(store, input.repositoryId);
    if (repo === null) return { issue: null };
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const issue = store.createIssue(repo, title, body, []);
    return { issue: { number: issue.number, id: issue.nodeId } };
  }
  if (field.name === 'closeIssue') {
    const input = isRecord(args.input) ? args.input : {};
    const found = findIssueByGlobalId(store, input.issueId);
    if (found === null) return { issue: null };
    found.issue.state = 'closed';
    found.issue.updatedAt = store.clock.now();
    return { issue: { number: found.issue.number, id: found.issue.nodeId, state: 'CLOSED' } };
  }
  if (field.name === 'createPullRequest') {
    const input = isRecord(args.input) ? args.input : {};
    const repo = findRepoByGlobalId(store, input.repositoryId);
    if (repo === null) return { pullRequest: null };
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
      return { pullRequest: null };
    }
    const pull = store.createPull(repo, title, body, head, base);
    return {
      pullRequest: {
        number: pull.number,
        id: pull.nodeId,
        state: 'OPEN',
        headRefName: head,
        baseRefName: base,
      },
    };
  }
  if (field.name === 'mergePullRequest') {
    const input = isRecord(args.input) ? args.input : {};
    const found = findPullByGlobalId(store, input.pullRequestId);
    if (found === null) return { pullRequest: null };
    const merged = store.mergePull(found.repo, found.pull, `${found.pull.title} (#${found.pull.number})`);
    if (merged === null) return { pullRequest: { number: found.pull.number, merged: false, state: found.pull.state.toUpperCase() } };
    return { pullRequest: { number: found.pull.number, merged: true, state: 'CLOSED' } };
  }
  if (field.name === 'addComment') {
    const input = isRecord(args.input) ? args.input : {};
    const found = findIssueByGlobalId(store, input.subjectId);
    if (found === null) return { commentEdge: null };
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = store.createComment(found.repo, found.issue.number, body);
    return { commentEdge: { node: { id: comment.nodeId, body: comment.body } } };
  }
  return undefined;
}

function findRepoByGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const repoId = Number(decoded.key);
  for (const repo of store.repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return null;
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: ReturnType<Store['createIssue']> } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':');
  for (const repo of store.repos.values()) {
    if (repo.id === Number(repoId)) {
      const issue = repo.issues.get(Number(number));
      return issue === undefined ? null : { repo, issue };
    }
  }
  return null;
}

function findPullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':');
  for (const repo of store.repos.values()) {
    if (repo.id === Number(repoId)) {
      const pull = repo.pulls.get(Number(number));
      return pull === undefined ? null : { repo, pull };
    }
  }
  return null;
}

function resolveField(source: GqlValue, field: FieldSelection, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const typeName = source.__typename ?? '';
  if (typeName === 'Query' || typeName === 'Mutation') {
    const value = resolveRootField(field, args, ctx);
    if (value !== undefined) return value;
  }
  if (typeName === 'Repository') {
    const repo = source._repo as Repo;
    const store = source._store as Store;
    if (field.name === 'issue') {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueViewGql(repo, issue);
    }
    if (field.name === 'issues') {
      const first = typeof args.first === 'number' ? args.first : 10;
      const offset = decodeCursor(args.after);
      let issues = [...repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set((args.states as unknown[]).map((state) => String(state).toUpperCase()));
        issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
      issues.sort((a, b) => {
        const diff = a.createdAt - b.createdAt;
        if (diff !== 0) return direction === 'DESC' ? -diff : diff;
        return direction === 'DESC' ? b.number - a.number : a.number - b.number;
      });
      const slice = issues.slice(offset, offset + first);
      const endOffset = offset + slice.length;
      return {
        __typename: 'IssueConnection',
        nodes: slice.map((issue) => issueViewGql(repo, issue)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: endOffset < issues.length,
          endCursor: slice.length > 0 ? encodeCursor(endOffset) : null,
          hasPreviousPage: offset > 0,
          startCursor: slice.length > 0 ? encodeCursor(offset) : null,
        },
        totalCount: issues.length,
      };
    }
    if (field.name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : 10;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: pulls.map((pull) => pullViewGql(store, repo, pull)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
        totalCount: repo.pulls.size,
      };
    }
    if (field.name === 'pullRequest') {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullViewGql(store, repo, pull);
    }
  }
  if (typeName === 'PullRequest') {
    const repo = source._repo as Repo;
    const pull = source._pull as Pull;
    const store = source._store as Store;
    if (field.name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 10;
      const files = store.pullFiles(repo, pull).slice(0, first);
      return {
        __typename: 'PullRequestFileConnection',
        nodes: files.map((change) => ({ __typename: 'PullRequestFile', path: change.path })),
      };
    }
  }
  if (typeName === '__Type') {
    if (field.name === 'fields') {
      return (source._fields as string[]).map((name) => ({ __typename: '__Field', name }));
    }
    if (field.name === 'enumValues') {
      return (source._enumValues as string[]).map((name) => ({ __typename: '__EnumValue', name }));
    }
  }
  // Plain property lookup.
  if (field.name in source) {
    const value = source[field.name];
    if (typeof value === 'function') return (value as (args: Record<string, unknown>) => unknown)(args);
    return value;
  }
  return undefined;
}

function executeSelections(
  source: GqlValue,
  selections: readonly Selection[],
  ctx: ExecContext,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      let fragmentSelections = selection.selections;
      let applies = true;
      if (selection.typeCondition !== null) {
        if (selection.typeCondition.startsWith('fragment:')) {
          const fragment = ctx.fragments.get(selection.typeCondition.slice('fragment:'.length));
          if (fragment === undefined) continue;
          fragmentSelections = fragment.selections;
          applies = fragment.typeCondition === source.__typename;
        } else {
          applies = selection.typeCondition === source.__typename;
        }
      }
      if (!applies) continue;
      Object.assign(data, executeSelections(source, fragmentSelections, ctx));
      continue;
    }
    const field = selection;
    const args = argsOf(field, ctx);
    const value = resolveField(source, field, args, ctx);
    const key = field.alias ?? field.name;
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${source.__typename ?? 'Unknown'}".` });
      data[key] = null;
      continue;
    }
    data[key] = executeValue(value, field.selections, ctx);
  }
  return data;
}

function executeValue(value: unknown, selections: readonly Selection[], ctx: ExecContext): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => executeValue(item, selections, ctx));
  }
  if (typeof value === 'object') {
    if (selections.length === 0) return value;
    return executeSelections(value as GqlValue, selections, ctx);
  }
  return value;
}

function executeOperation(operation: Operation, ctx: ExecContext): Record<string, unknown> {
  const root: GqlValue = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(root, operation.selections, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/**
 * POST /api/graphql. The body is one operation or a JSON array of operations
 * (batched); each answers in order. Authentication is checked by the server.
 */
export function handleGraphql(store: Store, body: unknown): ApiResponse {
  const bodies = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const item of bodies) {
    if (!isRecord(item) || typeof item.query !== 'string') {
      results.push({ errors: [{ message: 'query is required' }] });
      continue;
    }
    const variables = isRecord(item.variables) ? item.variables : {};
    let parsed: { operations: Operation[]; fragments: Map<string, FragmentDefinition> };
    try {
      parsed = new Parser(tokenize(item.query)).parseDocument();
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : String(err) }] });
      continue;
    }
    if (parsed.operations.length === 0) {
      results.push({ errors: [{ message: 'no operation in the document' }] });
      continue;
    }
    const ctx: ExecContext = { store, variables, fragments: parsed.fragments, errors: [] };
    // One operation per body entry in practice; an operationName picks one.
    let operation = parsed.operations[0] as Operation;
    if (typeof item.operationName === 'string') {
      const named = parsed.operations.find((candidate) => candidate.name === item.operationName);
      if (named !== undefined) operation = named;
    }
    results.push(executeOperation(operation, ctx));
  }
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}
