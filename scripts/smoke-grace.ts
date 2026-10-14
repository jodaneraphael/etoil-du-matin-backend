/**
 * Benign-duplicate recovery for refresh rotation.
 *
 * Runs against a server with `REFRESH_REUSE_GRACE_SECONDS` set (see
 * scripts/test.ts). The main suite (scripts/smoke.ts) asserts strict single-use
 * rotation with the grace window disabled; this one asserts that, inside the
 * window, a client that presents the same token twice — two tabs racing, a
 * retried request — keeps its session instead of being signed out, while a
 * replay *after* the window is still treated as theft.
 */
const B = process.env.SMOKE_BASE ?? "http://127.0.0.1:4200";

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

const json = (body: unknown) => ({ body: JSON.stringify(body) });

const rawLogin = async (email: string, password: string) => {
  const r = await fetch(`${B}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const set = r.headers.getSetCookie();
  const pick = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(";")[0]?.split("=")[1];
  return { status: r.status, rt: pick("edm_rt"), csrf: pick("edm_csrf"), set };
};

/** POST /api/auth/refresh presenting exactly one rt/csrf pair. */
const refreshWith = async (rt: string, csrf: string) => {
  const r = await fetch(`${B}/api/auth/refresh`, {
    method: "POST",
    headers: { cookie: `edm_rt=${rt}; edm_csrf=${csrf}`, "x-csrf-token": csrf },
  });
  const set = r.headers.getSetCookie();
  const pick = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(";")[0]?.split("=")[1];
  const body = await r.json().catch(() => null);
  return { status: r.status, body, rt: pick("edm_rt"), csrf: pick("edm_csrf") };
};

section("refresh reuse grace window (grace = 2s)");
{
  // A dedicated account so this suite never disturbs the fixtures the other one
  // depends on.
  const email = `grace-${Date.now().toString(36)}@etoil-du-matin.test`;
  const password = "Gr4ce!Probe#2024";
  const reg = await fetch(`${B}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...json({ name: "Grace Probe", email, password }),
  });
  check("register a throwaway account", reg.status === 200 || reg.status === 201, `status ${reg.status}`);

  const login = await rawLogin(email, password);
  if (!login.rt || !login.csrf) {
    check("login issued rt + csrf cookies", false, `status ${login.status}, cookies ${JSON.stringify(login.set)}`);
  } else {
    check("login issued rt + csrf cookies", true);

    // First refresh rotates rt1 -> rt2. rt1 is now revoked with reason "rotated".
    const first = await refreshWith(login.rt, login.csrf);
    check(
      "first refresh rotates within grace",
      first.status === 200 && !!first.rt && first.rt !== login.rt,
      `status ${first.status}`,
    );

    // The duplicate: the *old* token is presented again, still inside the grace
    // window. A racing second tab does exactly this. It must recover, not 401.
    const duplicate = await refreshWith(login.rt, login.csrf);
    check(
      "in-grace duplicate recovers instead of logging out",
      duplicate.status === 200 && !!duplicate.rt && duplicate.rt !== login.rt,
      `status ${duplicate.status} ${JSON.stringify(duplicate.body)}`,
    );

    // The recovered session must actually work — this is the assertion that
    // matters: the user is still signed in, not just handed a token-shaped 200.
    const me = await fetch(`${B}/api/auth/me`, {
      headers: { authorization: `Bearer ${duplicate.body?.accessToken}` },
    });
    check("recovered access token is accepted", me.status === 200, `status ${me.status}`);

    // Past the window, the same replay is a genuine reuse signal again.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const outside = await refreshWith(login.rt, login.csrf);
    check("out-of-grace replay is 401", outside.status === 401, `status ${outside.status}`);

    // ...and it must have revoked the family, so the live descendant dies too.
    const afterRevoke = await refreshWith(duplicate.rt!, duplicate.csrf!);
    check("out-of-grace replay revokes the family", afterRevoke.status === 401, `status ${afterRevoke.status}`);
  }
}

console.log(`\n${"=".repeat(46)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log("=".repeat(46));
process.exit(failed === 0 ? 0 : 1);
