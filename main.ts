// The entry <-> env lifecycle: bind an ephemeral port, register it with the
// suite, then poll until the suite says the trial is over and exit 0.
//
//   1. MAKEFUN_ENV_URL names the suite's origin. Without it there is nothing
//      to register with, so the program serves on FORGE_PORT (default: an
//      ephemeral port) for local development instead of exiting.
//   2. The server listens on port 0: the kernel picks a free port. It never
//      binds 8080, where the suite listens.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The suite records the
//      address the request came from plus N and dials it from then on.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}, then close
//      the server and exit 0. A failed poll is retried with backoff; the
//      process never exits before the suite says done.

import { createApp } from './src/server.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the suite accepts it. */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The suite is not answering yet, or the poll timed out: not done.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);

  if (ENV_URL === '') {
    // No suite: local development. Serve until stopped.
    process.stdout.write('[forge] no MAKEFUN_ENV_URL: serving locally, no registration\n');
    await new Promise<void>(() => undefined);
    return;
  }

  await register(address.port);
  process.stdout.write('[forge] registered; waiting for the suite to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
