import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Hermetic runner for the integration smoke suite.
 *
 * The suite starts a real API server, so it starts its own. The auth rate
 * limiters (5 registrations per hour, 10 auth attempts per 15 minutes) are
 * per-process and in-memory, which is correct for production but means a suite
 * that runs several times against one long-lived dev server eventually trips its
 * own throttling and reports 429s that are not defects. Booting a throwaway
 * server per run keeps every run starting from clean limiter state.
 *
 * Registration and login are still exercised against the real limiters, so the
 * throttling itself stays covered.
 */

const PORT = Number(process.env.SMOKE_PORT ?? 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 60_000;

const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<number>((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });

const waitForReady = async (): Promise<boolean> => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/readyz`);
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

const portInUse = async (): Promise<boolean> => {
  try {
    // A successful connect means something is already serving here.
    await fetch(`${BASE}/readyz`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
};

if (await portInUse()) {
  console.error(
    `Port ${PORT} is already serving. That is almost certainly a leftover test ` +
      "server from an interrupted run; stop it (or set SMOKE_PORT) before retrying.",
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

const server = spawn("npx", ["tsx", "src/index.ts"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    SMOKE_BASE: BASE,
    // The suite exercises authentication more times than a real user would in a
    // quarter of an hour, so the production ceilings would throttle the test
    // itself. These are raised, not disabled: the checkout limiter is left at its
    // real value and the suite deliberately exhausts it, so throttling is still
    // proven rather than assumed.
    RATE_LIMIT_AUTH_MAX: "500",
    RATE_LIMIT_REGISTER_MAX: "500",
    // The contact and newsletter suite makes a dozen-plus writes, well past the
    // production ceiling of 5/hour. Left at its real value, the assertions past
    // the fifth would all be measuring the limiter rather than the endpoints.
    RATE_LIMIT_CONTACT_MAX: "500",
  },
  stdio: ["ignore", "ignore", "inherit"],
  shell: process.platform === "win32",
});

/**
 * Stop the server, and wait for it.
 *
 * This must be awaited before exiting. `process.exit()` tears the runner down
 * synchronously, so a fire-and-forget `taskkill` gets abandoned mid-flight and
 * leaves the `node` child listening — which then makes the *next* run abort on
 * the busy-port check, or worse, silently test against the previous process.
 */
const shutdown = async (): Promise<void> => {
  await killServer(server);
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(130));
});

try {
  const ready = await waitForReady();
  if (!ready) {
    console.error(`\nThe API never became ready on ${BASE} within ${BOOT_TIMEOUT_MS / 1000}s.`);
    await shutdown();
    process.exit(1);
  }

  const code = await run("npx", ["tsx", "scripts/smoke.ts"], { ...process.env, SMOKE_BASE: BASE });
  await shutdown();
  process.exit(code);
} catch (error) {
  console.error(error);
  await shutdown();
  process.exit(1);
}
