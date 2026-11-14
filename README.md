# forge — a standalone GitHub-compatible git forge

One process, no dependencies beyond the Node 22 standard library, no git
binary, no database, no UI. It serves the four surfaces agents already
speak, from its own in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (ls-refs, fetch, shallow/deepen) and v0, receive-pack v0 with
  report-status, side-band-64k and delete-refs, fast-forward enforcement.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests (including squash merge with
  conflict detection).
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send, plus `__type` introspection and batched bodies.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision
  2026-07-28 via `server/discover`, with the legacy `initialize` handshake
  as a fallback; six tools that act on the same store as REST.

## Run

```sh
node main.ts
```

In a trial the process reads `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` from
its environment: it binds an ephemeral port, registers it, and exits when the
suite answers `{"done": true}`. Without `MAKEFUN_ENV_URL` it serves locally
until stopped (development mode; any non-empty bearer token is accepted when
`MAKEFUN_SHOP_TOKEN` is unset).

## Layout

- `main.ts` — the entry <-> suite lifecycle (bind, register, poll /done).
- `src/server.ts` — HTTP routing, auth, body reading, JSON replies.
- `src/store.ts` — the in-memory store: repos, refs, objects, issues, pull
  requests, labels, comments; tree building, merge-base, three-way merge.
- `src/git.ts` — git objects (blob/tree/commit/tag) and packfiles (write
  undelted; read with OFS/REF delta support).
- `src/git-http.ts` — smart-HTTP advertisements, upload-pack, receive-pack.
- `src/rest.ts` — the REST v3 routes.
- `src/graphql.ts` — a small GraphQL parser and executor.
- `src/mcp.ts` — the MCP endpoint and its six tools.
- `src/util.ts` — SHA-1, base64, pkt-lines, and the logical clock.

## Determinism

Nothing the forge returns comes from the wall clock: timestamps come from a
logical clock (one tick per mutation) and ids from counters, so two runs fed
the same requests leave the same observable state. That is what the final's
live/replay comparison needs.

## Grade locally

```sh
MAKEFUN_SHOP_TOKEN=test-token node main.ts &
node --experimental-strip-types github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:PORT --token test-token --perf
```
