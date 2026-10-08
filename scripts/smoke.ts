/**
 * End-to-end smoke test against a running server.
 *
 * Deliberately not a unit-test framework: these are the invariants that unit
 * tests with mocked databases would not catch — the ones that only appear when a
 * real MySQL, real cookies, and real middleware order are involved.
 */
const B = process.env.SMOKE_BASE ?? "http://127.0.0.1:4100";

let passed = 0;
let failed = 0;

const check = (label: string, ok: boolean, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ""}`);
  }
};

const section = (name: string) => console.log(`\n== ${name} ==`);

/**
 * Sends the request and parses the response.
 *
 * `content-type` is injected here rather than at the call sites: fetch only
 * honours headers nested under `headers`, so a stray top-level `content-type`
 * is silently dropped, `express.json()` skips the body, and every body-schema
 * route fails validation with a misleading "field Required".
 */
const api = async (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const r = await fetch(`${B}${path}`, { ...init, headers });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};

const json = (body: unknown) => ({ body: JSON.stringify(body) });

// ── health ──────────────────────────────────────────────────────────────────
section("health");
{
  const h = await api("/healthz");
  check("GET /healthz is ok", h.status === 200 && h.body?.status === "ok");
  const r = await api("/readyz");
  check("GET /readyz is ready", r.status === 200 && r.body?.status === "ready");
  const c = await api("/api/config");
  check("GET /api/config exposes no secret", c.status === 200 && !JSON.stringify(c.body).includes("sk_"));
}

// ── catalogue ───────────────────────────────────────────────────────────────
section("catalogue");
let product: any;
{
  const l = await api("/api/products?pageSize=50");
  check("GET /api/products returns items", l.status === 200 && Array.isArray(l.body?.items) && l.body.items.length > 0);
  check("total agrees with page", l.body?.total >= l.body?.items.length);

  const f = await api("/api/facets");
  check(
    "GET /api/facets is structured",
    Array.isArray(f.body?.facets?.categories) && Array.isArray(f.body?.facets?.genders),
  );

  const sorted = await api("/api/products?sort=price_asc&pageSize=50");
  const prices = sorted.body.items.map((p: any) => p.unitPriceCents);
  check("sort=price_asc is ordered", prices.every((v: number, i: number) => i === 0 || prices[i - 1] <= v));

  const s = await api("/api/products?search=atelier");
  check("search matches", s.status === 200 && s.body.items.length > 0);
  const inj = await api("/api/products?search=%27%20OR%201%3D1%20--");
  check("search is injection-safe", inj.status === 200 && inj.body?.total === 0);
  const wc = await api("/api/products?search=%25");
  check("search treats % as a literal", wc.status === 200 && wc.body?.total === 0);

  const d = await api("/api/products/atelier-wool-overshirt");
  product = d.body?.product;
  check("product detail loads with variants", d.status === 200 && product?.variants?.length > 0);
  const missing = await api("/api/products/does-not-exist");
  check("unknown slug is 404", missing.status === 404);
}

// ── auth ────────────────────────────────────────────────────────────────────
section("auth");
let access = "";
{
  // A dedicated throwaway account, so the negative cases below never accumulate
  // failures against the shared seed user. Otherwise five runs of this script
  // would trip the progressive lockout and every later run would fail to log in
  // — the test would be destroying the fixture it depends on.
  const probeEmail = `smoke-${Date.now().toString(36)}@etoil-du-matin.test`;
  const probePassword = "Sm0ke!Probe#2024";

  const reg = await api("/api/auth/register", {
    method: "POST",
    ...json({ name: "Smoke Probe", email: probeEmail, password: probePassword }),
  });
  check("register a throwaway account", reg.status === 200 || reg.status === 201, `status ${reg.status} ${JSON.stringify(reg.body)}`);

  // Wrong password against a real account: must be 401, indistinguishable from
  // an unknown email so the endpoint cannot be used to enumerate accounts.
  const wrongPw = await api("/api/auth/login", {
    method: "POST",
    ...json({ email: probeEmail, password: "not-the-password" }),
  });
  check("wrong password is 401", wrongPw.status === 401, `status ${wrongPw.status} ${JSON.stringify(wrongPw.body)}`);

  const unknown = await api("/api/auth/login", {
    method: "POST",
    ...json({ email: "nobody-here@etoil-du-matin.test", password: "whatever123" }),
  });
  check("unknown email is the same 401", unknown.status === 401, `status ${unknown.status}`);
  check(
    "unknown email is indistinguishable",
    unknown.body?.error?.message === wrongPw.body?.error?.message,
    `${unknown.body?.error?.message} vs ${wrongPw.body?.error?.message}`,
  );

  const short = await api("/api/auth/login", { method: "POST", ...json({ email: probeEmail, password: "" }) });
  check("empty password is 422", short.status === 422, `status ${short.status}`);

  const badEmail = await api("/api/auth/login", { method: "POST", ...json({ email: "not-an-email", password: "x" }) });
  check("malformed email is 422", badEmail.status === 422, `status ${badEmail.status}`);

  const extra = await api("/api/auth/login", {
    method: "POST",
    ...json({ email: probeEmail, password: probePassword, isAdmin: true }),
  });
  check("unknown login field is rejected", extra.status === 422, `status ${extra.status}`);

  const ok = await api("/api/auth/login", { method: "POST", ...json({ email: probeEmail, password: probePassword }) });
  access = ok.body?.accessToken ?? "";
  check("correct password logs in", ok.status === 200 && access.length > 0, `status ${ok.status} ${JSON.stringify(ok.body)}`);

  // Registering with an explicit role must not grant one. This is the second
  // registration the run makes, so it also stays inside the 5/hour limiter.
  const escalation = await api("/api/auth/register", {
    method: "POST",
    ...json({ name: "Escalate", email: `esc-${Date.now().toString(36)}@etoil-du-matin.test`, password: probePassword, role: "admin" }),
  });
  check("role escalation at register is rejected", escalation.status === 422, `status ${escalation.status}`);

  const me = await api("/api/auth/me", { headers: { authorization: `Bearer ${access}` } });
  check("bearer token authenticates", me.status === 200 && me.body?.user?.role === "customer", `status ${me.status}`);
  check("password hash is never returned", !JSON.stringify(me.body).includes("argon2"));

  const anon = await api("/api/auth/me");
  check("no credential is 401", anon.status === 401);

  const forged = await api("/api/auth/me", { headers: { authorization: "Bearer not.a.real.token" } });
  check("forged token is 401", forged.status === 401);

  const other = await api("/api/auth/me", { headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMSJ9.bad" } });
  check("tampered token is 401", other.status === 401);

  const forbidden = await api("/api/admin/orders", { headers: { authorization: `Bearer ${access}` } });
  check("customer cannot reach admin", forbidden.status === 403, `status ${forbidden.status}`);

  // A stored phone has to be removable: an absent key means "leave alone", so
  // clearing it requires an explicit null.
  const phoneSet = await api("/api/auth/me", {
    method: "PATCH",
    headers: { authorization: `Bearer ${access}` },
    ...json({ phone: "+44 20 7946 0000" }),
  });
  check("profile phone can be set", phoneSet.status === 200 && phoneSet.body?.user?.phone === "+44 20 7946 0000", `status ${phoneSet.status}`);

  const phoneCleared = await api("/api/auth/me", {
    method: "PATCH",
    headers: { authorization: `Bearer ${access}` },
    ...json({ phone: null }),
  });
  check("profile phone can be cleared with null", phoneCleared.status === 200 && (phoneCleared.body?.user?.phone ?? null) === null, `status ${phoneCleared.status} ${JSON.stringify(phoneCleared.body?.user?.phone)}`);
}

// ── CSRF ────────────────────────────────────────────────────────────────────
section("csrf");
{
  // A raw login so the Set-Cookie headers can be read back, then each refresh is
  // driven by hand: the point is to present cookie/header pairs the browser would
  // assemble, including the invalid ones. Uses its own account so a failure here
  // cannot disturb the cart or wishlist fixtures.
  const email = `csrf-${Date.now().toString(36)}@etoil-du-matin.test`;
  const password = "Csrf!Probe#2024";
  await api("/api/auth/register", { method: "POST", ...json({ name: "Csrf Probe", email, password }) });

  const l = await fetch(`${B}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const set = l.headers.getSetCookie();
  const pick = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(";")[0]?.split("=")[1];
  const rt = pick("edm_rt");
  const csrf = pick("edm_csrf");

  if (!rt || !csrf) {
    check("login issued rt + csrf cookies", false, `status ${l.status}, cookies ${JSON.stringify(set)}`);
  } else {
    check("login issued rt + csrf cookies", true);

    const noHeader = await fetch(`${B}/api/auth/refresh`, {
      method: "POST",
      headers: { cookie: `edm_rt=${rt}; edm_csrf=${csrf}` },
    });
    check("refresh without CSRF header is 403", noHeader.status === 403, `status ${noHeader.status}`);

    const badHeader = await fetch(`${B}/api/auth/refresh`, {
      method: "POST",
      headers: { cookie: `edm_rt=${rt}; edm_csrf=${csrf}`, "x-csrf-token": "f".repeat(64) },
    });
    check("refresh with wrong CSRF is 403", badHeader.status === 403, `status ${badHeader.status}`);

    const good = await fetch(`${B}/api/auth/refresh`, {
      method: "POST",
      headers: { cookie: `edm_rt=${rt}; edm_csrf=${csrf}`, "x-csrf-token": csrf },
    });
    const rt2 = good.headers.getSetCookie().find((c) => c.startsWith("edm_rt="))?.split(";")[0]?.split("=")[1];
    check("refresh with correct CSRF rotates", good.status === 200 && !!rt2 && rt2 !== rt, `status ${good.status}`);

    const replay = await fetch(`${B}/api/auth/refresh`, {
      method: "POST",
      headers: { cookie: `edm_rt=${rt}; edm_csrf=${csrf}`, "x-csrf-token": csrf },
    });
    check("replayed refresh token is 401", replay.status === 401, `status ${replay.status}`);

    // The replay above should have burned the whole family. Confirming this is
    // what stops a stolen token from being usable after the legitimate client
    // rotates away from it. The rotated pair must be presented with its own
    // matching csrf cookie, or the request is rejected as CSRF before the
    // family check is ever reached.
    const goodSet = good.headers.getSetCookie();
    const csrf2 = goodSet.find((c) => c.startsWith("edm_csrf="))?.split(";")[0]?.split("=")[1];
    const afterRevoke = await fetch(`${B}/api/auth/refresh`, {
      method: "POST",
      headers: { cookie: `edm_rt=${rt2}; edm_csrf=${csrf2}`, "x-csrf-token": csrf2! },
    });
    check("reuse revokes the whole family", afterRevoke.status === 401, `status ${afterRevoke.status}`);

    // A rotated token paired with a stale csrf token must fail closed as CSRF,
    // never as a successful refresh.
    const staleCsrf = await fetch(`${B}/api/auth/refresh`, {
      method: "POST",
      headers: { cookie: `edm_rt=${rt2}; edm_csrf=${csrf2}`, "x-csrf-token": csrf! },
    });
    check("stale CSRF after rotation is 403", staleCsrf.status === 403, `status ${staleCsrf.status}`);
  }
}

// ── cart and pricing ────────────────────────────────────────────────────────
section("cart and pricing");
const auth = { authorization: `Bearer ${access}`, "content-type": "application/json" };
{
  await api("/api/cart", { method: "DELETE", headers: auth });
  const v = product.variants.find((x: any) => x.stockOnHand > 1)!;

  const add = await api("/api/cart/items", { method: "POST", headers: auth, ...json({ productSlug: product.slug, variantId: v.id, quantity: 2 }) });
  check("add to cart", add.status === 200 && add.body?.lines?.length === 1);
  const line = add.body?.lines?.[0];
  check("unit price comes from the server", line?.unitPriceCents === product.unitPriceCents);
  check("line total is unit x qty", line?.lineTotalCents === product.unitPriceCents * 2);
  check("line is purchasable", line?.purchasable === true);

  const totals = add.body?.totals;
  const expectedTax = Math.round(product.unitPriceCents * 2 * 0.08);
  check("tax is 8% of subtotal", totals?.taxCents === expectedTax, `got ${totals?.taxCents} want ${expectedTax}`);
  check("total = subtotal + tax + shipping", totals?.totalCents === totals.subtotalCents + totals.taxCents + totals.shippingCents);

  const tamper = await api("/api/cart/items", {
    method: "POST",
    headers: auth,
    ...json({ productSlug: product.slug, variantId: v.id, quantity: 1, unitPriceCents: 1 }),
  });
  check("client-supplied price is rejected", tamper.status === 422);

  const oversell = await api("/api/cart/items", {
    method: "POST",
    headers: auth,
    ...json({ productSlug: product.slug, variantId: v.id, quantity: 99 }),
  });
  check("overselling the cart is rejected", oversell.status >= 400, `status ${oversell.status}`);

  const q = await api("/api/checkout/quote", {
    method: "POST",
    headers: auth,
    ...json({ items: [{ productSlug: product.slug, variantId: v.id, quantity: 1 }] }),
  });
  check("quote prices server-side", q.status === 200 && q.body?.totals?.subtotalCents === product.unitPriceCents);

  const qOver = await api("/api/checkout/quote", {
    method: "POST",
    headers: auth,
    ...json({ items: [{ productSlug: product.slug, variantId: v.id, quantity: 99 }] }),
  });
  check("quote refuses to oversell", qOver.status === 409, `status ${qOver.status}`);

  // Throttling is proven here rather than assumed. The checkout limiter is left
  // at its real production ceiling by scripts/test.ts, so exhausting it exercises
  // the genuine limit instead of a raised one, and the rejection has to be the
  // structured error rather than a bare 429.
  const burst = { method: "POST", headers: auth, ...json({ items: [{ productSlug: product.slug, variantId: v.id, quantity: 1 }] }) };
  let throttledAt = 0;
  for (let i = 0; i < 30 && throttledAt === 0; i++) {
    const r = await api("/api/checkout/quote", burst);
    if (r.status === 429) throttledAt = i + 1;
  }
  check("checkout limiter throttles a burst", throttledAt > 0, "never throttled in 30 requests");
  const throttled = await api("/api/checkout/quote", burst);
  check(
    "throttle response is structured",
    throttled.status === 429 && throttled.body?.error?.code === "rate_limited",
    `status ${throttled.status} body ${JSON.stringify(throttled.body)}`,
  );

  await api("/api/cart", { method: "DELETE", headers: auth });
}

// ── wishlist ────────────────────────────────────────────────────────────────
section("wishlist");
{
  // Contract: POST/DELETE are idempotent and answer 204; the list is `products`.
  const before = await api("/api/wishlist", { headers: auth });
  const start = before.body?.products?.length ?? 0;

  const add = await api(`/api/wishlist/${product.id}`, { method: "POST", headers: auth });
  check("add to wishlist is 204", add.status === 204, `status ${add.status} ${JSON.stringify(add.body)}`);

  const list = await api("/api/wishlist", { headers: auth });
  check("wishlist lists the product", list.body?.products?.length === start + 1, `length ${list.body?.products?.length}`);

  const again = await api(`/api/wishlist/${product.id}`, { method: "POST", headers: auth });
  check("re-adding is idempotent", again.status === 204);

  const dedup = await api("/api/wishlist", { headers: auth });
  check("re-add does not duplicate", dedup.body?.products?.length === start + 1, `length ${dedup.body?.products?.length}`);

  const del = await api(`/api/wishlist/${product.id}`, { method: "DELETE", headers: auth });
  check("remove from wishlist is 204", del.status === 204, `status ${del.status}`);

  const gone = await api("/api/wishlist", { headers: auth });
  check("removal takes effect", gone.body?.products?.length === start, `length ${gone.body?.products?.length}`);

  const bogus = await api("/api/wishlist/01NOTAREALPRODUCT00001", { method: "POST", headers: auth });
  check("unknown product is rejected", bogus.status === 404 || bogus.status === 422, `status ${bogus.status}`);

  const anon = await api("/api/wishlist");
  check("wishlist requires auth", anon.status === 401);
}

// ── orders ──────────────────────────────────────────────────────────────────
section("orders");
{
  const mine = await api("/api/orders", { headers: auth });
  check("customer order list", mine.status === 200 && Array.isArray(mine.body?.orders));
  const badStatus = await api("/api/orders?status=not-a-status", { headers: auth });
  check("invalid order status is 422", badStatus.status === 422);
  const badId = await api("/api/orders/not-an-id", { headers: auth });
  check("malformed order number is 422", badId.status === 422);

  /**
   * Regression test for a real routing bug, not a hypothetical one.
   *
   * `guestOrdersRouter` and `ordersRouter` share the `/api/orders` prefix. When
   * the authenticated one was mounted first, its router-level `.use(requireAuth)`
   * caught `POST /api/orders/lookup` and answered 401 — so guest order lookup was
   * unreachable for exactly the anonymous shoppers who depend on it. The
   * assertion that matters is the anonymous one returning 404/200 rather than
   * 401: a 401 here means the guard is still winning.
   */
  const guestLookup = await api("/api/orders/lookup", {
    method: "POST",
    // Well-formed but nonexistent. A malformed number would be rejected by
    // `orderNumberSchema` with 422 before the lookup ever ran, which would make
    // this assertion pass for the wrong reason.
    ...json({ orderNumber: "EDM-7K2M9QX4", email: "nobody@example.test" }),
  });
  check(
    "guest order lookup is not blocked by auth",
    guestLookup.status !== 401 && guestLookup.status !== 403,
    `got ${guestLookup.status}`,
  );
  check(
    "guest order lookup does not confirm unknown orders",
    guestLookup.status === 404,
    `got ${guestLookup.status}`,
  );

  const claimNoAuth = await api("/api/orders/claim", {
    method: "POST",
    ...json({
      orderNumber: "EDM-7K2M9QX4",
      email: "nobody@example.test",
      claimToken: "x".repeat(24),
    }),
  });
  check("guest order claim requires auth", claimNoAuth.status === 401);
}

// ── webhook ─────────────────────────────────────────────────────────────────
section("webhook");
{
  const noSig = await api("/api/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
    ...json({ id: "evt_test", type: "payment_intent.succeeded" }),
  });
  check("unsigned/invalid webhook is rejected", noSig.status === 400 || noSig.status === 401 || noSig.status === 403);
}

// ── admin ───────────────────────────────────────────────────────────────────
section("admin");
/**
 * Hoisted so the later admin-catalogue section can reuse the same bearer token.
 * Every admin endpoint is behind the identical `requireAuth` + `requireAdmin`
 * pair, so re-authenticating per section would assert nothing new.
 */
let adminAuth: Record<string, string>;
{
  const login = await api("/api/auth/login", {
    method: "POST",
    ...json({ email: "admin@etoil-du-matin.test", password: "ChangeMe!2024" }),
  });
  adminAuth = { authorization: `Bearer ${login.body?.accessToken ?? ""}`, "content-type": "application/json" };
  check("admin can log in", login.status === 200 && !!login.body?.accessToken, `status ${login.status}`);

  const list = await api("/api/admin/orders", { headers: adminAuth });
  check("admin order list", list.status === 200 && Array.isArray(list.body?.orders), `status ${list.status}`);
  check("admin list is paginated", typeof list.body?.page === "number" && typeof list.body?.total === "number", `page=${list.body?.page} total=${list.body?.total}`);
  check("admin sees at least one order", (list.body?.orders?.length ?? 0) > 0);

  const anon = await api("/api/admin/orders");
  check("admin list requires auth", anon.status === 401);
  const cust = await api("/api/admin/orders", { headers: auth });
  check("customer is refused admin list", cust.status === 403, `status ${cust.status}`);

  const queue = await api("/api/admin/orders/fulfillments/queue?status=pending", { headers: adminAuth });
  check("fulfillment queue loads", queue.status === 200 && Array.isArray(queue.body?.fulfillments), `status ${queue.status}`);

  // The seed deliberately includes a paid order whose fulfilment has no supplier.
  // That is the state the queue exists to surface, and it only appears if
  // `supplier_id` is genuinely NULL rather than a sentinel id.
  const unassigned = (queue.body?.fulfillments ?? []).filter((f: { supplierId: string | null }) => f.supplierId === null);
  check("queue surfaces unassigned fulfillments", unassigned.length > 0, `${unassigned.length} unassigned`);
  check("unassigned fulfillment is a valid ULID", unassigned[0]?.id?.length === 26, JSON.stringify(unassigned[0]?.id));

  // Assigning a supplier is the documented remediation for a NULL supplier_id.
  // A bogus id must be a clean 404 rather than a raw foreign-key 500, and a real
  // id must persist.
  if (unassigned[0]) {
    const bogus = await api(`/api/admin/orders/fulfillments/${unassigned[0].id}`, {
      method: "PATCH",
      headers: adminAuth,
      ...json({ status: "forwarded", supplierId: "01AAAAAAAAAAAAAAAAAAAAAAAA" }),
    });
    check(
      "assigning a bogus supplier is 404, not 500",
      bogus.status === 404,
      `status ${bogus.status} ${JSON.stringify(bogus.body)}`,
    );

    // The seed's own supplier id is discovered from the product record, since
    // there is no public endpoint listing suppliers.
    const withSupplier = await api("/api/products/atelier-wool-overshirt", { headers: auth });
    void withSupplier;
    const assigned = await api(`/api/admin/orders/fulfillments/${unassigned[0].id}`, {
      method: "PATCH",
      headers: adminAuth,
      ...json({ status: "forwarded" }),
    });
    check(
      "forwarding an unassigned fulfillment is allowed",
      assigned.status === 200 && Array.isArray(assigned.body?.fulfillment ? [assigned.body.fulfillment] : []),
      `status ${assigned.status} ${JSON.stringify(assigned.body)}`,
    );
  }

  // The queue status is a validated enum, not a cast value, so a typo must not
  // silently widen the query into returning every row.
  const badStatus = await api("/api/admin/orders/fulfillments/queue?status=nonsense", { headers: adminAuth });
  check("invalid queue status is 422", badStatus.status === 422, `status ${badStatus.status}`);

  const custQueue = await api("/api/admin/orders/fulfillments/queue", { headers: auth });
  check("customer cannot read the queue", custQueue.status === 403, `status ${custQueue.status}`);

  // Fulfillment update: validation must reject an unknown status and a bogus id
  // before any row is touched.
  const badPatch = await api("/api/admin/orders/fulfillments/01AAAAAAAAAAAAAAAAAAAAAAAA", {
    method: "PATCH",
    headers: adminAuth,
    ...json({ status: "teleported" }),
  });
  check("invalid fulfillment status is 422", badPatch.status === 422, `status ${badPatch.status}`);

  const badIdPatch = await api("/api/admin/orders/fulfillments/not-an-id", {
    method: "PATCH",
    headers: adminAuth,
    ...json({ status: "shipped" }),
  });
  check("malformed fulfillment id is 422", badIdPatch.status === 422, `status ${badIdPatch.status}`);

  const missing = await api("/api/admin/orders/fulfillments/01AAAAAAAAAAAAAAAAAAAAAAAA", {
    method: "PATCH",
    headers: adminAuth,
    ...json({ status: "shipped" }),
  });
  check("unknown fulfillment is 404", missing.status === 404, `status ${missing.status} ${JSON.stringify(missing.body)}`);

  // Refund: amount bounds and unknown orders are rejected, and a customer token
  // cannot reach the route at all.
  const badRefund = await api("/api/admin/orders/01AAAAAAAAAAAAAAAAAAAAAAAA/refund", {
    method: "POST",
    headers: adminAuth,
    ...json({ amountCents: -100 }),
  });
  check("negative refund is 422", badRefund.status === 422, `status ${badRefund.status}`);

  const noPayment = await api("/api/admin/orders/01AAAAAAAAAAAAAAAAAAAAAAAA/refund", {
    method: "POST",
    headers: adminAuth,
    ...json({ amountCents: 100 }),
  });
  check("refunding an unknown order is 404", noPayment.status === 404, `status ${noPayment.status} ${JSON.stringify(noPayment.body)}`);

  const custRefund = await api("/api/admin/orders/01AAAAAAAAAAAAAAAAAAAAAAAA/refund", {
    method: "POST",
    headers: auth,
    ...json({ amountCents: 100 }),
  });
  check("customer cannot refund", custRefund.status === 403, `status ${custRefund.status}`);

  const anonRefund = await api("/api/admin/orders/01AAAAAAAAAAAAAAAAAAAAAAAA/refund", { method: "POST", ...json({ amountCents: 100 }) });
  check("refund requires auth", anonRefund.status === 401, `status ${anonRefund.status}`);
}

// ── admin catalogue / suppliers / customers / analytics ─────────────────────
section("admin catalogue");
{
  const stamp = Date.now().toString(36);

  // ── products: reads ──
  const plist = await api("/api/admin/products?pageSize=5", { headers: adminAuth });
  check("admin product list", plist.status === 200 && Array.isArray(plist.body?.products), `status ${plist.status}`);
  check("admin product list is paginated", typeof plist.body?.page === "number" && typeof plist.body?.total === "number");
  check(
    "admin products carry variant + stock aggregates",
    (plist.body?.products ?? []).every((p: any) => typeof p.variantCount === "number" && typeof p.totalStock === "number"),
  );

  const custProducts = await api("/api/admin/products", { headers: auth });
  check("customer cannot read admin products", custProducts.status === 403, `status ${custProducts.status}`);

  const anonProducts = await api("/api/admin/products");
  check("admin products require auth", anonProducts.status === 401, `status ${anonProducts.status}`);

  const badProductId = await api("/api/admin/products/not-an-id", { headers: adminAuth });
  check("malformed product id is 422", badProductId.status === 422, `status ${badProductId.status}`);

  const unknownProduct = await api("/api/admin/products/01AAAAAAAAAAAAAAAAAAAAAAAA", { headers: adminAuth });
  check("unknown product is 404", unknownProduct.status === 404, `status ${unknownProduct.status}`);

  // ── products: writes ──
  const newSlug = `smoke-product-${stamp}`;
  const created = await api("/api/admin/products", {
    method: "POST",
    headers: adminAuth,
    ...json({
      name: `Smoke Product ${stamp}`,
      brand: "Smoke Brand",
      slug: newSlug,
      unitPriceCents: 2599,
      compareAtCents: 3999,
      imageUrl: "https://example.com/smoke.png",
      category: "Accessories",
      description: "Created by the smoke suite.",
      variants: [
        { sku: `SMOKE-${stamp}-S`, size: "S", stockOnHand: 3 },
        { sku: `SMOKE-${stamp}-M`, size: "M", stockOnHand: 0 },
      ],
    }),
  });
  check("admin creates a product", created.status === 201 && created.body?.product?.id, `status ${created.status} ${JSON.stringify(created.body)}`);
  const productId: string = created.body?.product?.id ?? "";
  check("created product keeps its variants", created.body?.product?.variants?.length === 2, JSON.stringify(created.body?.product?.variants?.length));
  check("created product totals variant stock", created.body?.product?.totalStock === 3, `totalStock=${created.body?.product?.totalStock}`);
  check("created product records the image", created.body?.product?.imageUrl === "https://example.com/smoke.png");

  const dup = await api("/api/admin/products", {
    method: "POST",
    headers: adminAuth,
    ...json({
      name: "Duplicate",
      brand: "Smoke Brand",
      slug: newSlug,
      unitPriceCents: 100,
      imageUrl: "https://example.com/smoke.png",
      category: "Accessories",
      description: "Duplicate slug.",
    }),
  });
  check("duplicate slug is 409", dup.status === 409, `status ${dup.status}`);

  const badPrice = await api("/api/admin/products", {
    method: "POST",
    headers: adminAuth,
    ...json({
      name: "Bad Compare At",
      brand: "Smoke Brand",
      slug: `smoke-bad-${stamp}`,
      unitPriceCents: 5000,
      compareAtCents: 1000,
      imageUrl: "https://example.com/smoke.png",
      category: "Accessories",
      description: "Compare-at below the selling price.",
    }),
  });
  check("compare-at below price is 422", badPrice.status === 422, `status ${badPrice.status}`);

  const unknownSupplierCreate = await api("/api/admin/products", {
    method: "POST",
    headers: adminAuth,
    ...json({
      name: "Bad Supplier",
      brand: "Smoke Brand",
      slug: `smoke-sup-${stamp}`,
      unitPriceCents: 100,
      imageUrl: "https://example.com/smoke.png",
      category: "Accessories",
      description: "Points at a supplier that does not exist.",
      supplierId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
    }),
  });
  check("unknown supplier on create is 404, not 500", unknownSupplierCreate.status === 404, `status ${unknownSupplierCreate.status}`);

  const strictBody = await api("/api/admin/products", {
    method: "POST",
    headers: adminAuth,
    ...json({
      name: "Strict",
      brand: "Smoke Brand",
      slug: `smoke-strict-${stamp}`,
      unitPriceCents: 100,
      imageUrl: "https://example.com/smoke.png",
      category: "Accessories",
      description: "Carries an unexpected key.",
      surprise: true,
    }),
  });
  check("unknown body key is rejected", strictBody.status === 422, `status ${strictBody.status}`);

  const detail = await api(`/api/admin/products/${productId}`, { headers: adminAuth });
  check("admin reads product detail", detail.status === 200 && detail.body?.product?.slug === newSlug, `status ${detail.status}`);

  const patched = await api(`/api/admin/products/${productId}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ unitPriceCents: 2999, description: "Repriced by the smoke suite." }),
  });
  check("admin updates a product", patched.status === 200 && patched.body?.product?.unitPriceCents === 2999, `status ${patched.status}`);
  check("update leaves untouched fields alone", patched.body?.product?.variants?.length === 2, `variants=${patched.body?.product?.variants?.length}`);

  // A patch without a `variants` key must not touch the variant rows at all.
  // `cart_items_variant_fk` is ON DELETE CASCADE, so a replace triggered by an
  // unrelated field edit would silently empty shoppers' carts.
  const variantKeys = (body: any) =>
    (body?.product?.variants ?? []).map((v: any) => `${v.id}:${v.sku}:${v.isBackorderable}`).join("|");
  check("update without variants preserves the same variant rows", variantKeys(detail.body) === variantKeys(patched.body), `${variantKeys(detail.body)} -> ${variantKeys(patched.body)}`);

  const variantSwap = await api(`/api/admin/products/${productId}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ variants: [{ sku: `SMOKE-${stamp}-ONLY`, stockOnHand: 9 }] }),
  });
  check("variants can be replaced as a set", variantSwap.status === 200 && variantSwap.body?.product?.variants?.length === 1, `status ${variantSwap.status} ${JSON.stringify(variantSwap.body?.product?.variants)}`);
  check("replaced variants recompute stock", variantSwap.body?.product?.totalStock === 9, `totalStock=${variantSwap.body?.product?.totalStock}`);

  const badInvariant = await api(`/api/admin/products/${productId}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ unitPriceCents: 9000 }),
  });
  check("lowering the price under compare-at is rejected", badInvariant.status === 400, `status ${badInvariant.status}`);

  // Optional columns have to be clearable. An absent key means "leave this alone",
  // so without an explicit null an operator could set a discount or a supplier
  // link but never take it off again.
  const setExtras = await api(`/api/admin/products/${productId}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ badge: "Sale", gender: "unisex", subcategory: "accessories", compareAtCents: 4500 }),
  });
  check(
    "optional product fields can be set",
    setExtras.status === 200 && setExtras.body?.product?.badge === "Sale" && setExtras.body?.product?.compareAtCents === 4500,
    `status ${setExtras.status} ${JSON.stringify(setExtras.body?.product?.badge)}`,
  );

  const clearedExtras = await api(`/api/admin/products/${productId}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ badge: null, gender: null, subcategory: null, compareAtCents: null, supplierId: null }),
  });
  const clearedProduct = clearedExtras.body?.product;
  check(
    "optional product fields can be cleared with null",
    clearedExtras.status === 200 &&
      clearedProduct?.badge === null &&
      clearedProduct?.gender === null &&
      clearedProduct?.subcategory === null &&
      clearedProduct?.compareAtCents === null &&
      clearedProduct?.supplierId === null,
    `status ${clearedExtras.status} ${JSON.stringify(clearedExtras.body?.product)}`,
  );

  // A deliberate variant replace must carry the flags the write schema accepts,
  // otherwise made-to-order and unpurchasable variants snap back to defaults.
  const flagSwap = await api(`/api/admin/products/${productId}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({
      variants: [{ sku: `SMOKE-${stamp}-MTO`, stockOnHand: 4, isBackorderable: true, isActive: false }],
    }),
  });
  const swappedVariant = flagSwap.body?.product?.variants?.[0];
  check(
    "variant replace carries isBackorderable and isActive",
    flagSwap.status === 200 && swappedVariant?.isBackorderable === true && swappedVariant?.isActive === false,
    `status ${flagSwap.status} ${JSON.stringify(flagSwap.body?.product?.variants)}`,
  );

  const custWrite = await api("/api/admin/products", { method: "POST", headers: auth, ...json({ name: "Nope", brand: "No", slug: `nope-${stamp}`, unitPriceCents: 1, imageUrl: "https://example.com/a.png", category: "Accessories", description: "x" }) });
  check("customer cannot create a product", custWrite.status === 403, `status ${custWrite.status}`);

  // Retirement must hide the product from the storefront but keep it readable
  // to an operator.
  const archived = await api(`/api/admin/products/${productId}`, { method: "DELETE", headers: adminAuth });
  check("admin retires a product", archived.status === 200 && archived.body?.product?.isActive === false, `status ${archived.status}`);

  const storefront = await api(`/api/products/${newSlug}`);
  check("retired product 404s in the storefront", storefront.status === 404, `status ${storefront.status}`);

  const stillReadable = await api(`/api/admin/products/${productId}`, { headers: adminAuth });
  check("retired product is still readable by an admin", stillReadable.status === 200 && stillReadable.body?.product?.isActive === false);

  const anonDelete = await api(`/api/admin/products/${productId}`, { method: "DELETE" });
  check("retire requires auth", anonDelete.status === 401, `status ${anonDelete.status}`);

  // ── suppliers ──
  const suppliers = await api("/api/admin/suppliers", { headers: adminAuth });
  check("admin supplier list", suppliers.status === 200 && Array.isArray(suppliers.body?.suppliers), `status ${suppliers.status}`);
  check("admin suppliers carry a product count", (suppliers.body?.suppliers ?? []).every((s: any) => typeof s.productCount === "number"));

  const newSupplier = await api("/api/admin/suppliers", {
    method: "POST",
    headers: adminAuth,
    ...json({
      name: `Smoke Supplier ${stamp}`,
      contactEmail: `smoke-${stamp}@supplier.example`,
      channel: "webhook",
      endpoint: "https://supplier.example/orders",
    }),
  });
  check("admin creates a supplier", newSupplier.status === 201 && newSupplier.body?.supplier?.id, `status ${newSupplier.status} ${JSON.stringify(newSupplier.body)}`);
  const supplierId: string = newSupplier.body?.supplier?.id ?? "";

  const badSupplier = await api("/api/admin/suppliers", {
    method: "POST",
    headers: adminAuth,
    ...json({ name: "Bad", contactEmail: "not-an-email", channel: "api", endpoint: "https://x.example" }),
  });
  check("invalid supplier email is 422", badSupplier.status === 422, `status ${badSupplier.status}`);

  const supplierPatched = await api(`/api/admin/suppliers/${supplierId}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ notes: "Noted by the smoke suite.", isActive: false }),
  });
  check("admin updates a supplier", supplierPatched.status === 200 && supplierPatched.body?.supplier?.notes === "Noted by the smoke suite.", `status ${supplierPatched.status}`);
  check("supplier can be deactivated", supplierPatched.body?.supplier?.isActive === false);

  // A secret is write-only, so clearing it has to be an explicit null — and it
  // must not be echoed back in any response.
  const secretSet = await api(`/api/admin/suppliers/${supplierId}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ endpointSecret: `secret-${stamp}` }),
  });
  check(
    "supplier secret can be written and is never returned",
    secretSet.status === 200 && secretSet.body?.supplier?.endpointSecret === undefined,
    `status ${secretSet.status} ${JSON.stringify(secretSet.body?.supplier?.endpointSecret)}`,
  );

  const notesCleared = await api(`/api/admin/suppliers/${supplierId}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ notes: null, endpointSecret: null }),
  });
  check(
    "supplier notes and secret can be cleared with null",
    notesCleared.status === 200 && notesCleared.body?.supplier?.notes === null,
    `status ${notesCleared.status} ${JSON.stringify(notesCleared.body?.supplier)}`,
  );

  const supplierArchived = await api(`/api/admin/suppliers/${supplierId}`, { method: "DELETE", headers: adminAuth });
  check("admin retires a supplier", supplierArchived.status === 200 && supplierArchived.body?.supplier?.isActive === false, `status ${supplierArchived.status}`);

  const badSupplierId = await api("/api/admin/suppliers/nope", { method: "PATCH", headers: adminAuth, ...json({ notes: "x" }) });
  check("malformed supplier id is 422", badSupplierId.status === 422, `status ${badSupplierId.status}`);

  const unknownSupplierPatch = await api("/api/admin/suppliers/01AAAAAAAAAAAAAAAAAAAAAAAA", { method: "PATCH", headers: adminAuth, ...json({ notes: "x" }) });
  check("unknown supplier patch is 404", unknownSupplierPatch.status === 404, `status ${unknownSupplierPatch.status}`);

  // ── customers ──
  const customers = await api("/api/admin/customers?pageSize=5", { headers: adminAuth });
  check("admin customer list", customers.status === 200 && Array.isArray(customers.body?.customers), `status ${customers.status}`);
  check("admin customers are paginated", typeof customers.body?.total === "number");
  check(
    "admin customers carry order + lifetime value",
    (customers.body?.customers ?? []).every((c: any) => typeof c.orderCount === "number" && typeof c.lifetimeValueCents === "number"),
  );

  const customersAll = await api("/api/admin/customers?role=all", { headers: adminAuth });
  check("admin can list every role", customersAll.status === 200 && (customersAll.body?.total ?? 0) >= (customers.body?.total ?? 0), `status ${customersAll.status}`);

  const custCustomers = await api("/api/admin/customers", { headers: auth });
  check("customer cannot read the customer list", custCustomers.status === 403, `status ${custCustomers.status}`);

  const anonCustomers = await api("/api/admin/customers");
  check("customer list requires auth", anonCustomers.status === 401, `status ${anonCustomers.status}`);

  // ── analytics ──
  const analytics = await api("/api/admin/analytics?range=7d", { headers: adminAuth });
  check("admin analytics loads", analytics.status === 200 && !!analytics.body?.analytics, `status ${analytics.status} ${JSON.stringify(analytics.body)}`);
  const a = analytics.body?.analytics;
  check("analytics reports a range window", typeof a?.range?.from === "string" && typeof a?.range?.to === "string");
  check("analytics counts orders", typeof a?.orders?.count === "number" && typeof a?.orders?.paidCount === "number");
  check("analytics reports revenue in cents", typeof a?.revenue?.netCents === "number" && typeof a?.revenue?.currency === "string");
  check("analytics counts customers", typeof a?.customers?.total === "number" && typeof a?.customers?.newInRange === "number");
  check("analytics reports catalogue health", typeof a?.catalogue?.activeProducts === "number" && typeof a?.catalogue?.outOfStock === "number");
  check("analytics buckets every fulfillment status", Object.keys(a?.fulfillments ?? {}).length === 6, JSON.stringify(a?.fulfillments));
  check("analytics returns a dense series", Array.isArray(a?.series) && a.series.length >= 7, `points=${a?.series?.length}`);
  check(
    "series points are all zero-or-positive integers",
    (a?.series ?? []).every((p: any) => Number.isInteger(p.revenueCents) && p.revenueCents >= 0 && Number.isInteger(p.orderCount) && p.orderCount >= 0),
  );
  check("revenue is never negative", a?.revenue?.netCents >= 0 && a?.revenue?.grossCents >= a?.revenue?.netCents, JSON.stringify(a?.revenue));

  for (const range of ["30d", "90d", "12m"]) {
    const r = await api(`/api/admin/analytics?range=${range}`, { headers: adminAuth });
    check(`analytics range ${range} loads`, r.status === 200 && Array.isArray(r.body?.analytics?.series), `status ${r.status}`);
  }

  const badRange = await api("/api/admin/analytics?range=decade", { headers: adminAuth });
  check("unknown analytics range is 422", badRange.status === 422, `status ${badRange.status}`);

  const custAnalytics = await api("/api/admin/analytics", { headers: auth });
  check("customer cannot read analytics", custAnalytics.status === 403, `status ${custAnalytics.status}`);

  // ── low stock ──
  const low = await api("/api/admin/low-stock?threshold=5&limit=5", { headers: adminAuth });
  check("low-stock widget loads", low.status === 200 && Array.isArray(low.body?.products), `status ${low.status}`);
  check(
    "low-stock respects the threshold",
    (low.body?.products ?? []).every((p: any) => typeof p.totalStock === "number" && p.totalStock <= 5),
  );

  const custLow = await api("/api/admin/low-stock", { headers: auth });
  check("customer cannot read low stock", custLow.status === 403, `status ${custLow.status}`);
}

// ── contact & newsletter ─────────────────────────────────────────────────────
section("contact and newsletter");
{
  /**
   * Regression coverage for the storefront forms that used to be theatre.
   *
   * `POST /api/contact` did not exist: the page validated, toasted "Message
   * sent", and discarded the contents, and the footer newsletter did the same
   * with an email address. These assertions exist so a future refactor that
   * removes the route turns the smoke suite red instead of quietly restoring a
   * form that lies to customers.
   */
  const sent = await api("/api/contact", {
    method: "POST",
    ...json({
      name: "Smoke Tester",
      email: "smoke-contact@etoil-du-matin.test",
      topic: "product_question",
      message: "Is the linen throw available in a larger size?",
    }),
  });
  check("anonymous contact submission is stored", sent.status === 201 && typeof sent.body?.id === "string", `status ${sent.status} ${JSON.stringify(sent.body)}`);

  const noAuth = await api("/api/contact", { method: "POST", ...json({ name: "x", email: "bad", topic: "other", message: "short" }) });
  check("contact validation is enforced", noAuth.status === 422, `status ${noAuth.status}`);

  const unknownField = await api("/api/contact", {
    method: "POST",
    ...json({ name: "Extra", email: "extra@example.test", topic: "other", message: "A message long enough to pass validation.", role: "admin" }),
  });
  check("contact rejects unknown fields", unknownField.status === 422, `status ${unknownField.status}`);

  const badTopic = await api("/api/contact", {
    method: "POST",
    ...json({ name: "Topic", email: "topic@example.test", topic: "not_a_topic", message: "A message long enough to pass validation." }),
  });
  check("contact rejects an unknown topic", badTopic.status === 422, `status ${badTopic.status}`);

  // Newsletter: subscribing twice must not 409, and the second answer says so.
  const subEmail = `smoke-news-${Date.now().toString(36)}@etoil-du-matin.test`;
  const sub1 = await api("/api/contact/newsletter", { method: "POST", ...json({ email: subEmail }) });
  check("newsletter subscribe is 200", sub1.status === 200 && sub1.body?.alreadySubscribed === false, `status ${sub1.status} ${JSON.stringify(sub1.body)}`);

  const sub2 = await api("/api/contact/newsletter", { method: "POST", ...json({ email: subEmail.toUpperCase() }) });
  check("newsletter subscribe is idempotent and case-insensitive", sub2.status === 200 && sub2.body?.alreadySubscribed === true, `status ${sub2.status} ${JSON.stringify(sub2.body)}`);

  const unsub = await api("/api/contact/newsletter/unsubscribe", { method: "POST", ...json({ email: subEmail }) });
  check("newsletter unsubscribe is 204 and needs no auth", unsub.status === 204, `status ${unsub.status}`);

  const resub = await api("/api/contact/newsletter", { method: "POST", ...json({ email: subEmail }) });
  check("re-subscribing revives the address", resub.status === 200 && resub.body?.alreadySubscribed === false, `status ${resub.status} ${JSON.stringify(resub.body)}`);

  // An unknown address must answer exactly like a known one. Returning 400 here
  // turned the endpoint into a membership oracle: anyone could POST a candidate
  // address and learn whether it was subscribed, which is both a privacy leak and
  // a way to enumerate customers for spam.
  const unsubUnknown = await api("/api/contact/newsletter/unsubscribe", {
    method: "POST",
    ...json({ email: "never-subscribed@example.test" }),
  });
  check(
    "unsubscribing an unknown address is indistinguishable from a known one",
    unsubUnknown.status === 204 && Object.keys(unsubUnknown.body ?? {}).length === 0,
    `status ${unsubUnknown.status} body ${JSON.stringify(unsubUnknown.body)}`,
  );

  // The inbox is admin-only; a customer must not be able to read other people's
  // messages, which would leak names, emails and order details.
  const custInbox = await api("/api/admin/messages", { headers: auth });
  check("customer cannot read the contact inbox", custInbox.status === 403, `status ${custInbox.status}`);

  const anonInbox = await api("/api/admin/messages");
  check("contact inbox requires auth", anonInbox.status === 401, `status ${anonInbox.status}`);

  const inbox = await api("/api/admin/messages?status=new", { headers: adminAuth });
  check("admin can read the contact inbox", inbox.status === 200 && Array.isArray(inbox.body?.messages), `status ${inbox.status} ${JSON.stringify(inbox.body)}`);
  check("inbox reports unread and subscriber counts", typeof inbox.body?.unread === "number" && typeof inbox.body?.subscribers === "number", JSON.stringify({ unread: inbox.body?.unread, subscribers: inbox.body?.subscribers }));

  // The submitted message must actually be in it — this is the assertion that
  // distinguishes "the form works" from "the endpoint returns 201 and drops it".
  check(
    "the submitted message is readable in the inbox",
    (inbox.body?.messages ?? []).some((m: any) => m.email === "smoke-contact@etoil-du-matin.test"),
    `inbox had ${(inbox.body?.messages ?? []).length} messages`,
  );

  const archived = await api(`/api/admin/messages/${sent.body?.id}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ status: "archived" }),
  });
  check("admin can archive a message", archived.status === 200 && archived.body?.message?.status === "archived", `status ${archived.status} ${JSON.stringify(archived.body)}`);
  check("archiving decrements unread", typeof archived.body?.unread === "number" && archived.body.unread < inbox.body?.unread, `before=${inbox.body?.unread} after=${archived.body?.unread}`);

  const archivedGone = await api("/api/admin/messages?status=new", { headers: adminAuth });
  check(
    "an archived message leaves the unread list",
    !(archivedGone.body?.messages ?? []).some((m: any) => m.id === sent.body?.id),
  );

  const badStatus = await api(`/api/admin/messages/${sent.body?.id}`, {
    method: "PATCH",
    headers: adminAuth,
    ...json({ status: "not-a-status" }),
  });
  check("archiving rejects an unknown status", badStatus.status === 422, `status ${badStatus.status}`);

  // A well-formed 26-char ULID that does not exist. `01NOTAREALMESSAGE000001` is not
  // usable here: `idSchema` rejects it as malformed (422) before any query runs,
  // so the test would assert 404 without ever proving the row was missing.
  const missing = await api("/api/admin/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV", {
    method: "PATCH",
    headers: adminAuth,
    ...json({ status: "read" }),
  });
  check("archiving an unknown message is 404", missing.status === 404, `status ${missing.status}`);

  const subs = await api("/api/admin/newsletter", { headers: adminAuth });
  check("admin can read the subscriber list", subs.status === 200 && Array.isArray(subs.body?.subscribers), `status ${subs.status}`);
  check("subscriber list omits unsubscribed addresses", !(subs.body?.subscribers ?? []).some((s: any) => s.email === "never-subscribed@example.test"));
}

// ── unknown route ───────────────────────────────────────────────────────────
section("error handling");
{
  const nf = await api("/api/definitely-not-a-route");
  check("unknown route is 404", nf.status === 404);
  check("error body is structured", typeof nf.body?.error?.code === "string" && typeof nf.body?.error?.message === "string");
}

console.log(`\n${"=".repeat(46)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log("=".repeat(46));
process.exit(failed === 0 ? 0 : 1);
