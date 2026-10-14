import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Hermetic runner for the integration smoke suites.
 *
 * The suites start a real API server, so this runner starts its own. The auth
 * rate limiters (5 registrations per hour, 10 auth attempts per 15 minutes) are
 * per-process and in-memory, which is correct for production but means a suite
 * that runs several times against one long-lived dev server eventually trips its
 * own throttling and reports 429s that are not defects. Booting a throwaway
 * server per run keeps every run starting from clean limiter state.
 *
 * Registration and login are still exercised against the real limiters, so the
 * throttling itself stays covered.
 *
 * Two servers are used because one setting cannot be varied within a process:
 * `REFRESH_REUSE_GRACE_SECONDS`. The main suite asserts strict single-use
 * rotation (grace 0); `scripts/smoke-grace.ts` asserts the benign-duplicate
 * recovery (grace > 0) on a second server.
 */

const SMOKE_PORT = Number(process.env.SMOKE_PORT ?? 4199);
const GRACE_PORT = SMOKE_PORT + 1;
const BOOT_TIMEOUT_MS = 60_000;

const base = (port: number) => `http://127.0.0.1:${port}`;

const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<number>((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });

const waitForReady = async (port: number): Promise<boolean> => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base(port)}/readyz`);
      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === "ready") return true;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
};

/**
 * Kill the server and everything it spawned.
 *
 * `child.kill()` alone is not enough on Windows: the child is `npx`, and
 * terminating it leaves the `node` process it launched still listening. The next
 * run then finds the port busy, connects to the *previous* server, and inherits
 * its already-exhausted rate limiters — so a clean run reports 429s that have
 * nothing to do with the current code. `taskkill /T` walks the tree.
 */
const killServer = async (child: ChildProcess): Promise<void> => {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }
  child.kill("SIGKILL");
};

const portInUse = async (port: number): Promise<boolean> => {
  try {
    // A successful connect means something is already serving here.
    await fetch(`${base(port)}/readyz`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
};

if ((await portInUse(SMOKE_PORT)) || (await portInUse(GRACE_PORT))) {
  console.error(
    `Port ${SMOKE_PORT} (or ${GRACE_PORT}) is already serving. That is almost certainly a ` +
      "leftover test server from an interrupted run; stop it (or set SMOKE_PORT) before retrying.",
  );
  process.exit(1);
}

/**
 * Put the database back into a known fixture state.
 *
 * The suite mutates real rows on purpose: forwarding the unassigned fulfillment
 * is one of the things it asserts. Without a reset, a second run inherits the
 * first run's side effects and fails on a stale assumption — which makes the
 * suite unreliable in exactly the way that erodes trust in it.
 *
 * The seed is idempotent and refuses to run against production, so this is safe
 * to repeat. It deliberately does NOT reset `stockOnHand`: inventory is real
 * data, unlike the demo order fixtures.
 */
const prepare = await run("npx", ["tsx", "src/db/seed.ts"], { ...process.env });
if (prepare !== 0) {
  console.error("Failed to establish the fixture baseline; aborting rather than testing unknown state.");
  process.exit(1);
}

/** Boot a throwaway API server on `port`, returning the child handle. */
const startServer = (port: number, extraEnv: NodeJS.ProcessEnv): ChildProcess =>
  spawn("npx", ["tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(port), SMOKE_BASE: base(port), ...extraEnv },
    stdio: ["ignore", "ignore", "inherit"],
    shell: process.platform === "win32",
  });

/**
 * The limits the suite has to live within.
 *
 * The suite exercises authentication more times than a real user would in a
 * quarter of an hour, so the production ceilings would throttle the test itself.
 * These are raised, not disabled: the checkout limiter is left at its real value
 * and the suite deliberately exhausts it, so throttling is still proven rather
 * than assumed. Grace is pinned to 0 so the strict single-use rotation
 * assertions hold regardless of NODE_ENV or a developer's .env.
 */
const SUITE_ENV: NodeJS.ProcessEnv = {
  RATE_LIMIT_AUTH_MAX: "500",
  RATE_LIMIT_REGISTER_MAX: "500",
  RATE_LIMIT_CONTACT_MAX: "500",
  REFRESH_REUSE_GRACE_SECONDS: "0",
};

const servers: ChildProcess[] = [];
const shutdown = async (): Promise<void> => {
  for (const server of servers) await killServer(server);
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(130));
});

try {
  // ── Phase 1: strict rotation, grace window disabled ────────────────────────
  const main = startServer(SMOKE_PORT, SUITE_ENV);
  servers.push(main);
  if (!(await waitForReady(SMOKE_PORT))) {
    console.error(`\nThe API never became ready on ${base(SMOKE_PORT)} within ${BOOT_TIMEOUT_MS / 1000}s.`);
    await shutdown();
    process.exit(1);
  }

  const code = await run("npx", ["tsx", "scripts/smoke.ts"], { ...process.env, SMOKE_BASE: base(SMOKE_PORT) });
  await killServer(main);

  if (code !== 0) {
    await shutdown();
    process.exit(code);
  }

  // ── Phase 2: benign-duplicate recovery, grace window enabled ───────────────
  // A 2s window keeps the suite fast (it sleeps just past it to prove the
  // outside-grace replay is still treated as theft).
  const grace = startServer(GRACE_PORT, { ...SUITE_ENV, REFRESH_REUSE_GRACE_SECONDS: "2" });
  servers.push(grace);
  if (!(await waitForReady(GRACE_PORT))) {
    console.error(`\nThe grace API never became ready on ${base(GRACE_PORT)} within ${BOOT_TIMEOUT_MS / 1000}s.`);
    await shutdown();
    process.exit(1);
  }

  const graceCode = await run("npx", ["tsx", "scripts/smoke-grace.ts"], {
    ...process.env,
    SMOKE_BASE: base(GRACE_PORT),
  });
  await shutdown();
  process.exit(graceCode);
} catch (error) {
  console.error(error);
  await shutdown();
  process.exit(1);
}
