import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { corsPolicy, globalLimiter, originGuard, securityHeaders } from "./middleware/security.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { adminMediaRouter, MEDIA_ROOT } from "./modules/admin/media.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { cartRouter } from "./modules/cart/cart.routes.js";
import { catalogRouter } from "./modules/catalog/catalog.routes.js";
import { checkoutRouter } from "./modules/checkout/checkout.routes.js";
import { contactRouter } from "./modules/contact/contact.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { adminOrdersRouter, guestOrdersRouter } from "./modules/orders/orders.routes.js";
import { webhookRouter } from "./modules/payments/webhook.routes.js";
import { wishlistRouter } from "./modules/wishlist/wishlist.routes.js";

/**
 * Express application.
 *
 * Exported as a factory rather than a module-level singleton so tests can build
 * an isolated instance without importing the process entry point, which also
 * opens a database pool and installs signal handlers.
 */
export const createApp = (): Express => {
  const app = express();

  // Behind a reverse proxy, `req.ip` must come from X-Forwarded-For or every
  // rate limiter and lockout sees the proxy's address and throttles all users
  // together. Only enable this when a proxy you control sets that header — a
  // blind `true` lets any client spoof its IP. Production refuses to boot
  // without it, and env.assertProductionSafety enforces that.
  app.set("trust proxy", env.trustProxy);

  // Rate limiting is applied before body parsing so an oversized or slow body
  // cannot be used to bypass the limit.
  app.use(globalLimiter);

  /**
   * Webhooks are mounted BEFORE the JSON body parser, and they install their own
   * raw parser.
   *
   * This ordering is load-bearing: Stripe signs the exact bytes it sent, so a
   * body that `express.json()` has parsed and re-serialised cannot have its
   * signature verified. Registering the webhook after the JSON parser would make
   * every delivery fail verification.
   */
  app.use("/api/webhooks", webhookRouter);

  app.use(securityHeaders);
  app.use(corsPolicy);
  app.use(originGuard);

  /**
   * Admin media uploads carry multi-megabyte base64 payloads, past the shared
   * 64kb JSON cap, so they are mounted with their own larger parser BEFORE the
   * shared one.
   *
   * Unlike the webhook router they sit AFTER the CORS policy and origin guard,
   * not before them: the upload response is read by the console's browser, so it
   * needs the CORS headers, and a cross-origin POST should be origin-checked
   * like any other. (Webhooks are server-to-server, so neither applies there.)
   * Auth+admin is enforced inside the router, mirroring `adminRouter`.
   */
  app.use("/api/admin/media", express.json({ limit: "12mb" }), adminMediaRouter);

  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

  /**
   * Uploaded product imagery lives on the backend's own disk under `/uploads`.
   * Same-site (localhost ports differ but the registrable domain is identical),
   * so the `crossOriginResourcePolicy: same-site` header stays untouched.
   */
  app.use(
    "/uploads",
    express.static(MEDIA_ROOT, {
      index: false,
      dotfiles: "deny",
      maxAge: env.isProduction ? "30d" : 0,
      immutable: true,
    }),
  );

  // Liveness and readiness. Deliberately unauthenticated and dependency-free:
  // `db` is not touched, so a database blip does not cause the orchestrator to
  // kill a process that is otherwise healthy. The readiness probe is separate.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
  });

  // Ready: confirms the process is up *and* the database answers. Reported with
  // a 503 so a load balancer stops routing new traffic before requests start
  // failing with 500s.
  app.get("/readyz", (_req, res) => {
    void import("./db/client.js")
      .then(({ db }) => db.execute("SELECT 1"))
      .then(() => res.json({ status: "ready" }))
      .catch((error: unknown) => {
        logger.warn({ err: error }, "readiness probe failed");
        res.status(503).json({ status: "not_ready" });
      });
  });

  // Published key is needed by the browser to initialise Stripe Elements. It is
  // public by definition; the secret key never appears in any response.
  app.get("/api/config", (_req, res) => {
    res.json({
      currency: env.storeCurrency,
      stripePublishableKey: env.stripePublishableKey,
      shippingFlatCents: env.shippingFlatCents,
      freeShippingThresholdCents: env.freeShippingThresholdCents,
      taxBasisPoints: env.taxBasisPoints,
    });
  });

  app.use("/api/auth", authRouter);
  // Public and unauthenticated by design: a customer who cannot sign in still
  // needs to reach support. Rate limiting is applied per-route inside the
  // router, since these are the only writes on the surface with no token subject
  // to key a quota against.
  app.use("/api/contact", contactRouter);
  // Mounted at /api, not /api/catalog: the router already spells out `/products`
  // and `/facets` in its own paths.
  app.use("/api", catalogRouter);
  app.use("/api/wishlist", wishlistRouter);
  app.use("/api/cart", cartRouter);
  app.use("/api/checkout", checkoutRouter);
  // Guest routes first, and this ordering is load-bearing. `ordersRouter` applies
  // `requireAuth` with a router-level `.use`, so it is a catch-all for its mount
  // path: mounted first, it would answer `POST /api/orders/lookup` with 401
  // before `guestOrdersRouter` ever saw the request, and the guest order lookup
  // would be unreachable for exactly the people who need it.
  //
  // Safe because the two routers do not overlap: guest routes are POST
  // `/lookup` and `/claim`, while the authenticated router only serves GET `/`
  // and GET `/:orderNumber`. Express matches on method too, so neither shadows
  // the other.
  app.use("/api/orders", guestOrdersRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/admin/orders", adminOrdersRouter);
  // Registered after the orders router so `/api/admin/orders/*` keeps resolving
  // to the order console; this one owns products, suppliers, customers and
  // analytics under `/api/admin/*`.
  app.use("/api/admin", adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
