import "dotenv/config";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { assertUtcSession, closeDatabase, db } from "./db/client.js";
import { logger } from "./lib/logger.js";
import { releaseExpiredOrders } from "./modules/orders/stock.service.js";

/**
 * Process entry point.
 *
 * Responsibilities, in order:
 *   1. Refuse to start on unsafe production configuration.
 *   2. Confirm the database is reachable, so a bad DATABASE_URL fails at deploy
 *      time rather than on the first customer request.
 *   3. Serve, and shut down gracefully.
 */

/** Abort startup with a clear message rather than running in a broken state. */
const fatal = (message: string, detail?: unknown): never => {
  logger.fatal({ err: detail }, message);
  process.exit(1);
};

/**
 * Release the stock held by orders that were never paid.
 *
 * Checkout decrements stock before the card is charged, so an abandoned basket is
 * a reservation that nothing else would ever free. Without this the catalogue
 * bleeds inventory permanently and a sold-out product can never come back.
 *
 * Runs in-process on a plain interval rather than as external cron because it is
 * a single small indexed query per pass; the alternative is an operational
 * dependency for something this cheap. `unref()` matters: it keeps the timer from
 * holding the event loop open, so a graceful shutdown is not delayed by a pending
 * sweep. The sweep is also skipped under NODE_ENV=test, where the harness drives
 * the clock and a stray background timer would race the assertions.
 */
const startStockSweep = (): NodeJS.Timeout => {
  const sweep = async () => {
    try {
      const released = await releaseExpiredOrders(env.pendingOrderTtlMs, env.orderSweepBatchSize);
      if (released > 0) logger.info({ released }, "released stock from expired checkouts");
    } catch (error) {
      // A failed sweep is recoverable — the next pass retries — so it must never
      // take the process down.
      logger.error({ err: error }, "stock reservation sweep failed");
    }
  };

  // Catch up on anything that expired while the process was down.
  void sweep();
  return setInterval(sweep, env.orderSweepIntervalMs);
};

const start = async (): Promise<void> => {
  // Throws with a list of problems when NODE_ENV=production and a setting is
  // development-grade. Deliberately before anything else: booting a production
  // listener with a test Stripe key is worse than not booting.
  try {
    env.assertProductionSafety();
  } catch (error) {
    fatal("Refusing to start: unsafe production configuration.", error);
  }

  try {
    await db.execute("SELECT 1");
  } catch (error) {
    fatal("Could not reach the database. Check DATABASE_URL.", error);
  }

  // Fail fast if the session is not on UTC. Timestamp columns rely on the
  // server's CURRENT_TIMESTAMP agreeing with the driver's UTC reads; if the
  // session is offset, created_at and password_changed_at are wrong by that
  // amount and the fault surfaces much later as misordered orders and tokens
  // that survive a password change.
  try {
    await assertUtcSession();
  } catch (error) {
    fatal("Database session is not on UTC.", error);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(
      { port: env.port, env: env.nodeEnv, currency: env.storeCurrency },
      "etoil-du-matin api listening",
    );
  });

  const stockSweep = startStockSweep();
  stockSweep.unref();

  // Slow-loris mitigation: cap how long a client may take to send headers and
  // body. Without this, a handful of slow connections can exhaust the socket
  // pool and deny service to legitimate traffic.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  // Keep-alive slightly above the load balancer's idle timeout so the proxy,
  // not this process, is the side that closes idle connections.
  server.keepAliveTimeout = 65_000;

  /**
   * Graceful shutdown.
   *
   * Stops accepting new connections, lets in-flight requests finish, then closes
   * the database pool. The timeout is a backstop: a wedged request must not keep
   * the process alive indefinitely, because an orchestrator will SIGKILL it and
   * the pool would then be torn down mid-query.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    // Stop the sweep before draining the pool, so it cannot open a new query
    // while connections are being handed back.
    clearInterval(stockSweep);

    server.close(async (error) => {
      clearTimeout(forceExit);
      if (error) logger.error({ err: error }, "error while closing http server");
      try {
        await closeDatabase();
        logger.info("database pool closed");
      } catch (closeError) {
        logger.error({ err: closeError }, "error while closing database pool");
      }
      process.exit(error ? 1 : 0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  /**
   * Last-resort handlers.
   *
   * An unhandled rejection leaves the process in an unknown state, so it is
   * logged and the process is restarted by the supervisor rather than limping
   * on. `uncaughtException` is treated the same way: continuing after one is not
   * safe, because invariants may already be broken.
   */
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    shutdown("unhandledRejection");
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception");
    shutdown("uncaughtException");
  });
};

void start();
