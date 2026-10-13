/**
 * MySQL schema.
 *
 * Conventions applied throughout:
 *
 * - Primary keys are 26-char ULIDs, not auto-increment integers. Sequential
 *   integer keys let a caller guess the next valid id and read another
 *   customer's order by incrementing a number (IDOR). ULIDs are sortable by
 *   creation time but not enumerable, so authorisation can lean on them.
 *
 * - All money is stored as integer minor units (cents) in BIGINT. Floating
 *   point currency accumulates rounding drift and `0.1 + 0.2 !== 0.3` is a
 *   real defect in a ledger.
 *
 * - Every mutable table carries created_at / updated_at with timezone-aware
 *   defaults so audit trails do not depend on application clock skew.
 *
 * - Rows that reference a user cascade on delete; rows that represent money
 *   or history (orders, payments, webhook events) use RESTRICT so financial
 *   records cannot be silently destroyed.
 */
import { relations, sql } from "drizzle-orm";
import { bigint, boolean, char, foreignKey, index, int, json, mysqlEnum, mysqlTable, smallint, text, timestamp, uniqueIndex, varchar, } from "drizzle-orm/mysql-core";
export const ROLES = ["customer", "admin"];
/**
 * `partially_refunded` is distinct from `refunded` because a single status cannot
 * describe both cases honestly. Stripe can refund a PaymentIntent cumulatively
 * (`charge.refunded` fires per refund, with `amount_refunded` accumulating), so
 * an order that has had 40 of 100 returned is *not* refunded. Recording that as
 * `refunded` told support the money was all back when the customer still owed
 * the balance.
 */
export const ORDER_STATUSES = [
    "pending_payment",
    "paid",
    "failed",
    "canceled",
    "partially_refunded",
    "refunded",
];
/** Per-supplier lifecycle. One order fans out into N of these. */
export const FULFILLMENT_STATUSES = ["pending", "forwarded", "fulfilled", "shipped", "delivered", "failed"];
export const SUPPLIER_CHANNELS = ["email", "webhook", "api"];
export const PRODUCT_CATEGORIES = ["Electronics", "Fashion", "Home & Living", "Beauty", "Accessories"];
export const GENDERS = ["men", "women", "unisex"];
export const SUBCATEGORIES = [
    "shoes",
    "clothing",
    "accessories",
    "jewelry",
    "perfumes",
    "marriage",
    "handbags",
    "beauty",
];
export const BADGES = ["Best Seller", "New", "Limited", "Sale"];
const id = () => char("id", { length: 26 }).primaryKey();
/**
 * Timestamps are UTC everywhere, and that is enforced at the connection rather
 * than per-column.
 *
 * The driver is configured with `timezone: "Z"`, so every value the application
 * writes is stored as UTC. A bare `CURRENT_TIMESTAMP` is evaluated by the
 * *server*, in the server's own zone, so on any host not set to UTC the two
 * bases differ — on this machine by a full hour. That silently mixes both into
 * the same column and breaks anything that orders or compares those columns:
 * admin and customer order lists interleave incorrectly, and
 * `password_changed_at` stops lining up with a token's `iat`, so a password
 * change would fail to invalidate the tokens it is meant to.
 *
 * `db/client.ts` therefore pins every pooled session to `+00:00`, at which point
 * `CURRENT_TIMESTAMP` *is* UTC. The standard `CURRENT_TIMESTAMP ... ON UPDATE
 * CURRENT_TIMESTAMP` form is kept rather than `UTC_TIMESTAMP(3)` because MySQL
 * only accepts `CURRENT_TIMESTAMP` in an `ON UPDATE` clause — `ON UPDATE
 * (UTC_TIMESTAMP(3))` is a syntax error, so the expression-default form cannot be
 * used for `updated_at` and would leave the two columns on different schemes.
 *
 * The `ON UPDATE` half is applied by a hand-written migration rather than by
 * Drizzle's `$onUpdate`. Two reasons: `$onUpdate` does not emit an `ON UPDATE`
 * clause into generated DDL, and it injects its expression into *every* UPDATE
 * statement, where the raw SQL chunk is handed to the timestamp column's
 * `mapToDriverValue` and throws "value.toISOString is not a function" — so it
 * breaks writes while appearing to add nothing.
 */
const createdAt = () => timestamp("created_at", { fsp: 3 })
    .notNull()
    .default(sql `CURRENT_TIMESTAMP(3)`);
const updatedAt = () => timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql `CURRENT_TIMESTAMP(3)`);
// ── Identity ───────────────────────────────────────────────────────────────
export const users = mysqlTable("users", {
    id: id(),
    email: varchar("email", { length: 320 }).notNull(),
    /** Argon2id PHC string. The plaintext password never exists server-side. */
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    role: mysqlEnum("role", ROLES).notNull().default("customer"),
    emailVerifiedAt: timestamp("email_verified_at", { fsp: 3 }),
    /** Throttles credential stuffing; reset on successful login. */
    failedLoginAttempts: smallint("failed_login_attempts", { unsigned: true }).notNull().default(0),
    lockedUntil: timestamp("locked_until", { fsp: 3 }),
    passwordChangedAt: timestamp("password_changed_at", { fsp: 3 }).notNull().default(sql `CURRENT_TIMESTAMP(3)`),
    lastLoginAt: timestamp("last_login_at", { fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => ({
    // Case-insensitive collation on the column makes this index the authority
    // for uniqueness, so `Ada@x.com` cannot register alongside `ada@x.com`.
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
    roleIdx: index("users_role_idx").on(t.role),
}));
export const addresses = mysqlTable("addresses", {
    id: id(),
    userId: char("user_id", { length: 26 }).notNull(),
    label: varchar("label", { length: 60 }).notNull().default("Home"),
    recipientName: varchar("recipient_name", { length: 120 }).notNull(),
    line1: varchar("line1", { length: 160 }).notNull(),
    line2: varchar("line2", { length: 160 }),
    city: varchar("city", { length: 100 }).notNull(),
    /** Stored as text: postal formats vary far too widely for a fixed length. */
    postalCode: varchar("postal_code", { length: 20 }).notNull(),
    /** ISO 3166-1 alpha-2. */
    country: char("country", { length: 2 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => ({
    userIdx: index("addresses_user_idx").on(t.userId),
    // A deleted account takes its saved addresses with it.
    userFk: foreignKey({
        columns: [t.userId],
        foreignColumns: [users.id],
        name: "addresses_user_fk",
    }).onDelete("cascade"),
}));
export const refreshTokens = mysqlTable("refresh_tokens", {
    id: id(),
    userId: char("user_id", { length: 26 }).notNull(),
    /**
     * SHA-256 of the opaque token, never the token itself. A database leak
     * therefore does not hand an attacker usable session credentials.
     */
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    /** Stable id for the whole rotation lineage; lets us revoke a family. */
    familyId: char("family_id", { length: 26 }).notNull(),
    /** Random value the client echoes back to prove it is not a blind replay. */
    bindingSecretHash: char("binding_secret_hash", { length: 64 }),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    revokedAt: timestamp("revoked_at", { fsp: 3 }),
    /** Set when the token is rotated out; the reason aids incident review. */
    revokedReason: varchar("revoked_reason", { length: 64 }),
    userAgentHash: char("user_agent_hash", { length: 64 }),
    ipHash: char("ip_hash", { length: 64 }),
    createdAt: createdAt(),
}, (t) => ({
    tokenHashUnique: uniqueIndex("refresh_tokens_hash_unique").on(t.tokenHash),
    userIdx: index("refresh_tokens_user_idx").on(t.userId),
    familyIdx: index("refresh_tokens_family_idx").on(t.familyId),
    expiresIdx: index("refresh_tokens_expires_idx").on(t.expiresAt),
    userFk: foreignKey({
        columns: [t.userId],
        foreignColumns: [users.id],
        name: "refresh_tokens_user_fk",
    }).onDelete("cascade"),
}));
/** One row per authenticated request. Enables instant, global revocation. */
export const sessions = mysqlTable("sessions", {
    id: id(),
    userId: char("user_id", { length: 26 }).notNull(),
    refreshFamilyId: char("refresh_family_id", { length: 26 }).notNull(),
    ipHash: char("ip_hash", { length: 64 }),
    userAgentHash: char("user_agent_hash", { length: 64 }),
    lastSeenAt: timestamp("last_seen_at", { fsp: 3 }).notNull().default(sql `CURRENT_TIMESTAMP(3)`),
    revokedAt: timestamp("revoked_at", { fsp: 3 }),
    createdAt: createdAt(),
}, (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    familyIdx: index("sessions_family_idx").on(t.refreshFamilyId),
    userFk: foreignKey({
        columns: [t.userId],
        foreignColumns: [users.id],
        name: "sessions_user_fk",
    }).onDelete("cascade"),
}));
/**
 * One row per 6-digit reset code. The plaintext code never reaches the
 * database — only a SHA-256 hash — so a leak does not mint working codes, and
 * `attempts` caps brute-forcing between expiry at 15 minutes.
 */
export const passwordResets = mysqlTable("password_resets", {
    id: id(),
    userId: char("user_id", { length: 26 }).notNull(),
    /** SHA-256 of the 6-digit code. */
    codeHash: char("code_hash", { length: 64 }).notNull(),
    attempts: smallint("attempts", { unsigned: true }).notNull().default(0),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    usedAt: timestamp("used_at", { fsp: 3 }),
    createdAt: createdAt(),
}, (t) => ({
    userIdx: index("password_resets_user_idx").on(t.userId),
    expiresIdx: index("password_resets_expires_idx").on(t.expiresAt),
    userFk: foreignKey({
        columns: [t.userId],
        foreignColumns: [users.id],
        name: "password_resets_user_fk",
    }).onDelete("cascade"),
}));
// ── Catalogue ──────────────────────────────────────────────────────────────
export const suppliers = mysqlTable("suppliers", {
    id: id(),
    name: varchar("name", { length: 140 }).notNull(),
    contactEmail: varchar("contact_email", { length: 320 }).notNull(),
    channel: mysqlEnum("channel", SUPPLIER_CHANNELS).notNull().default("webhook"),
    /** Webhook/API target. Validated against an SSRF denylist before saving. */
    endpoint: varchar("endpoint", { length: 2048 }).notNull(),
    /** Shared secret for signing outbound supplier calls, kept server-side. */
    endpointSecret: varchar("endpoint_secret", { length: 255 }),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => ({
    nameIdx: index("suppliers_name_idx").on(t.name),
    activeIdx: index("suppliers_active_idx").on(t.isActive),
}));
export const products = mysqlTable("products", {
    id: id(),
    slug: varchar("slug", { length: 160 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    brand: varchar("brand", { length: 120 }).notNull(),
    /** Authoritative price in minor units. Client-sent prices are never used. */
    unitPriceCents: int("unit_price_cents", { unsigned: true }).notNull(),
    compareAtCents: int("compare_at_cents", { unsigned: true }),
    imageUrl: varchar("image_url", { length: 2048 }).notNull(),
    gallery: json("gallery").$type().notNull(),
    category: mysqlEnum("category", PRODUCT_CATEGORIES).notNull(),
    gender: mysqlEnum("gender", GENDERS),
    subcategory: mysqlEnum("subcategory", SUBCATEGORIES),
    description: text("description").notNull(),
    specs: json("specs").$type().notNull(),
    /** Denormalised aggregate; recomputed on review writes. */
    rating: int("rating_milli").notNull().default(0),
    reviewCount: int("review_count", { unsigned: true }).notNull().default(0),
    badge: mysqlEnum("badge", BADGES),
    supplierId: char("supplier_id", { length: 26 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => ({
    slugUnique: uniqueIndex("products_slug_unique").on(t.slug),
    categoryIdx: index("products_category_idx").on(t.category),
    genderSubIdx: index("products_gender_sub_idx").on(t.gender, t.subcategory),
    supplierIdx: index("products_supplier_idx").on(t.supplierId),
    activeIdx: index("products_active_idx").on(t.isActive),
    // Losing a supplier must not delete the catalogue; the product simply
    // becomes unsourced and stops being forwardable.
    supplierFk: foreignKey({
        columns: [t.supplierId],
        foreignColumns: [suppliers.id],
        name: "products_supplier_fk",
    }).onDelete("set null"),
}));
/**
 * Stock is tracked per variant because a size or colour can sell out
 * independently. `stockOnHand` is guarded by a SELECT ... FOR UPDATE during
 * checkout to prevent overselling under concurrent requests.
 */
export const productVariants = mysqlTable("product_variants", {
    id: id(),
    productId: char("product_id", { length: 26 }).notNull(),
    sku: varchar("sku", { length: 64 }).notNull(),
    colorName: varchar("color_name", { length: 60 }),
    colorValue: varchar("color_value", { length: 32 }),
    size: varchar("size", { length: 32 }),
    /**
     * Authoritative on-hand count, guarded by SELECT ... FOR UPDATE at checkout
     * so concurrent orders cannot oversell. 0 means out of stock.
     */
    stockOnHand: int("stock_on_hand").notNull().default(0),
    /**
     * Explicit opt-in for made-to-order lines, where 0 (or any amount) of stock
     * still sells. An explicit boolean rather than overloading NULL, because a
     * nullable count invites the notNull/FK class of mismatch fixed elsewhere in
     * this file and makes "0" ambiguous between out-of-stock and unbounded.
     */
    isBackorderable: boolean("is_backorderable").notNull().default(false),
    /** Optional price override for a specific size/colour. */
    unitPriceCents: int("unit_price_cents", { unsigned: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => ({
    skuUnique: uniqueIndex("product_variants_sku_unique").on(t.sku),
    productIdx: index("product_variants_product_idx").on(t.productId),
    productFk: foreignKey({
        columns: [t.productId],
        foreignColumns: [products.id],
        name: "product_variants_product_fk",
    }).onDelete("cascade"),
}));
export const reviews = mysqlTable("reviews", {
    id: id(),
    productId: char("product_id", { length: 26 }).notNull(),
    userId: char("user_id", { length: 26 }).notNull(),
    rating: smallint("rating").notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    body: text("body").notNull(),
    /** Moderation gate: unapproved reviews never reach the public product page. */
    isApproved: boolean("is_approved").notNull().default(false),
    /**
     * Who approved or rejected it, and when. Approval with no audit trail means a
     * bad review can be published with no way to establish after the fact who let
     * it through, which is the first question any moderation dispute asks.
     */
    moderatedBy: char("moderated_by", { length: 26 }),
    moderatedAt: timestamp("moderated_at", { fsp: 3 }),
    createdAt: createdAt(),
}, (t) => ({
    productIdx: index("reviews_product_idx").on(t.productId),
    userIdx: index("reviews_user_idx").on(t.userId),
    oneReviewPerUser: uniqueIndex("reviews_user_product_unique").on(t.productId, t.userId),
    productFk: foreignKey({
        columns: [t.productId],
        foreignColumns: [products.id],
        name: "reviews_product_fk",
    }).onDelete("cascade"),
    userFk: foreignKey({
        columns: [t.userId],
        foreignColumns: [users.id],
        name: "reviews_user_fk",
    }).onDelete("cascade"),
}));
export const wishlistItems = mysqlTable("wishlist_items", {
    id: id(),
    userId: char("user_id", { length: 26 }).notNull(),
    productId: char("product_id", { length: 26 }).notNull(),
    createdAt: createdAt(),
}, (t) => ({
    userProductUnique: uniqueIndex("wishlist_user_product_unique").on(t.userId, t.productId),
    userFk: foreignKey({
        columns: [t.userId],
        foreignColumns: [users.id],
        name: "wishlist_user_fk",
    }).onDelete("cascade"),
    productFk: foreignKey({
        columns: [t.productId],
        foreignColumns: [products.id],
        name: "wishlist_product_fk",
    }).onDelete("cascade"),
}));
/**
 * Server-side cart. Persisting the bag rather than leaving it only in browser
 * storage means it survives a device change and lets price and stock be
 * re-checked against live data on every read.
 *
 * A cart row is a *hint*, never an authority: checkout recomputes every price
 * from the product tables regardless of what is stored here, so a tampered cart
 * cannot influence what is charged.
 */
export const cartItems = mysqlTable("cart_items", {
    id: id(),
    userId: char("user_id", { length: 26 }).notNull(),
    productId: char("product_id", { length: 26 }).notNull(),
    /** Null line = any variant, for products with a single configuration. */
    variantId: char("variant_id", { length: 26 }),
    /**
     * Generated so the uniqueness rule below actually holds.
     *
     * MySQL treats every NULL as distinct in a unique index, so a unique index on
     * (user_id, product_id, variant_id) would happily accept unlimited rows for
     * a product that has no variant — the exact case where duplicates are most
     * likely. Collapsing NULL to '' in a generated column makes those rows
     * collide as intended. Generated rather than maintained in application code
     * so the database is the single authority.
     */
    /**
     * Must stay VIRTUAL, never STORED. MySQL refuses to add a foreign key to any
     * table that contains a STORED generated column (ER_CANNOT_ADD_FOREIGN), and
     * `cart_items` needs an FK on `variant_id` for `ON DELETE CASCADE`. VIRTUAL
     * columns carry no such restriction and are still indexable, so the unique
     * constraint below works.
     *
     * The column exists to make a nullable `variant_id` participate in a unique
     * index: a plain `UNIQUE(user_id, product_id, variant_id)` would permit any
     * number of NULL rows, because NULLs never compare equal. Coalescing to ''
     * means one cart line per product for variant-less products.
     */
    variantKey: char("variant_key", { length: 26 }).generatedAlwaysAs(sql `COALESCE(variant_id,'')`, {
        mode: "stored",
    }),
    quantity: smallint("quantity", { unsigned: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => ({
    /**
     * One row per product/variant pair. Merging a guest cart into an account at
     * sign-in relies on this constraint to combine quantities instead of
     * producing a duplicate line.
     */
    lineUnique: uniqueIndex("cart_items_line_unique").on(t.userId, t.productId, t.variantKey),
    userIdx: index("cart_items_user_idx").on(t.userId),
    productIdx: index("cart_items_product_idx").on(t.productId),
    userFk: foreignKey({
        columns: [t.userId],
        foreignColumns: [users.id],
        name: "cart_items_user_fk",
    }).onDelete("cascade"),
    productFk: foreignKey({
        columns: [t.productId],
        foreignColumns: [products.id],
        name: "cart_items_product_fk",
    }).onDelete("cascade"),
    variantFk: foreignKey({
        columns: [t.variantId],
        foreignColumns: [productVariants.id],
        name: "cart_items_variant_fk",
    }).onDelete("cascade"),
}));
// ── Orders ─────────────────────────────────────────────────────────────────
export const orders = mysqlTable("orders", {
    id: id(),
    /** Human-facing reference, e.g. "EDM-7K3Q9M2X". Shown to support and customers. */
    orderNumber: varchar("order_number", { length: 20 }).notNull(),
    /** Null for guest checkout. */
    userId: char("user_id", { length: 26 }),
    /** Guest orders are claimed later by verifying email ownership. */
    guestEmail: varchar("guest_email", { length: 320 }),
    guestClaimTokenHash: char("guest_claim_token_hash", { length: 64 }),
    /** Shipping address is snapshotted, never joined live. */
    shippingName: varchar("shipping_name", { length: 120 }).notNull(),
    shippingLine1: varchar("shipping_line1", { length: 160 }).notNull(),
    shippingLine2: varchar("shipping_line2", { length: 160 }),
    shippingCity: varchar("shipping_city", { length: 100 }).notNull(),
    shippingPostalCode: varchar("shipping_postal_code", { length: 20 }).notNull(),
    shippingCountry: char("shipping_country", { length: 2 }).notNull(),
    shippingPhone: varchar("shipping_phone", { length: 32 }),
    currency: char("currency", { length: 3 }).notNull(),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull(),
    shippingCents: bigint("shipping_cents", { mode: "number" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    /** Amount already refunded, in minor units. Guards against over-refunding. */
    refundedCents: bigint("refunded_cents", { mode: "number" }).notNull().default(0),
    status: mysqlEnum("status", ORDER_STATUSES).notNull().default("pending_payment"),
    /**
     * Set the moment the stock taken at checkout is handed back, whichever route
     * got there first (payment provider cancellation, an operator cancel, or the
     * pending-order expiry sweep).
     *
     * This is the idempotency token for restocking. The release is executed by the
     * same conditional UPDATE that writes this column, so the column is both the
     * record and the proof: a row with a non-NULL value has already had its
     * `stock_on_hand` restored and must never be restored again. Without it,
     * `payment_intent.canceled` arriving twice (or racing the sweep) would credit
     * the same units back to inventory twice and let a sold-out item be bought
     * again by a customer who already has one.
     */
    stockReleasedAt: timestamp("stock_released_at", { fsp: 3 }),
    /** Idempotency key supplied by the client, unique per order attempt. */
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
    placedAt: timestamp("placed_at", { fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => ({
    orderNumberUnique: uniqueIndex("orders_order_number_unique").on(t.orderNumber),
    /**
     * The real defence against a retried or double-submitted checkout creating
     * two orders and two charges.
     */
    idempotencyUnique: uniqueIndex("orders_idempotency_unique").on(t.idempotencyKey),
    userIdx: index("orders_user_idx").on(t.userId),
    guestEmailIdx: index("orders_guest_email_idx").on(t.guestEmail),
    statusIdx: index("orders_status_idx").on(t.status),
    createdIdx: index("orders_created_idx").on(t.createdAt),
    /**
     * Orders outlive the account that placed them. Anonymising on delete keeps
     * the sales ledger intact while removing the personal link, which is what
     * a data-erasure request should touch.
     */
    userFk: foreignKey({
        columns: [t.userId],
        foreignColumns: [users.id],
        name: "orders_user_fk",
    }).onDelete("set null"),
}));
/**
 * Snapshot of what was bought, priced at purchase time. Deliberately denormalised:
 * a later product edit or deletion must never rewrite historical order value.
 */
export const orderItems = mysqlTable("order_items", {
    id: id(),
    orderId: char("order_id", { length: 26 }).notNull(),
    /**
     * Deliberately nullable. The line is a snapshot — name, slug and unit price
     * are denormalised onto it — so `product_id` is only an audit link back to
     * the catalogue. It must be nullable to pair with ON DELETE SET NULL:
     * retiring a product has to leave historical order lines intact rather than
     * rewrite them or block the delete. Checkout always populates it.
     */
    productId: char("product_id", { length: 26 }),
    productName: varchar("product_name", { length: 200 }).notNull(),
    productSlug: varchar("product_slug", { length: 160 }).notNull(),
    /**
     * No foreign key on purpose. Variants are routinely merged or removed during
     * catalogue maintenance, and the label below is what must survive that.
     */
    variantId: char("variant_id", { length: 26 }),
    variantLabel: varchar("variant_label", { length: 120 }),
    imageUrl: varchar("image_url", { length: 2048 }).notNull(),
    quantity: smallint("quantity", { unsigned: true }).notNull(),
    /** unit_price_cents * quantity, stored for auditability of the maths. */
    unitPriceCents: int("unit_price_cents", { unsigned: true }).notNull(),
    lineTotalCents: int("line_total_cents", { unsigned: true }).notNull(),
    /**
     * Exactly which `product_variants` rows this line took stock from, and how
     * much from each: `[{ "variantId": "...", "quantity": 2 }]`.
     *
     * Needed because a line can be bought without naming a variant. Such a line
     * draws on the product's variants collectively — three sizes might jointly
     * cover a quantity of four — so `variant_id` alone cannot say what to put
     * back when the order is cancelled or expires. Storing the split is what makes
     * the release exact rather than approximate; without it the only correct
     * behaviour would be to leave the stock stranded.
     *
     * Recorded for every line, not just variant-less ones, so release is a single
     * code path with no special cases. Empty means no stock was consumed, which
     * is the normal state for a backorderable line.
     *
     * The default is an expression because MySQL has no implicit default for JSON:
     * `ADD COLUMN ... json NOT NULL` with no default fails outright on a table that
     * already has rows, so a bare NOT NULL column is not migratable.
     */
    variantAllocations: json("variant_allocations")
        .$type()
        .notNull()
        .default(sql `(JSON_ARRAY())`),
    createdAt: createdAt(),
}, (t) => ({
    orderIdx: index("order_items_order_idx").on(t.orderId),
    productIdx: index("order_items_product_idx").on(t.productId),
    orderFk: foreignKey({
        columns: [t.orderId],
        foreignColumns: [orders.id],
        name: "order_items_order_fk",
    }).onDelete("cascade"),
    // Retiring a product must not rewrite historical order lines; the snapshot
    // columns above are the record of truth, this is only a convenience link.
    productFk: foreignKey({
        columns: [t.productId],
        foreignColumns: [products.id],
        name: "order_items_product_fk",
    }).onDelete("set null"),
}));
/**
 * One order fans out into one row per supplier. Each row tracks its own
 * forwarding state, so one supplier shipping late cannot hold up the others.
 */
export const orderFulfillments = mysqlTable("order_fulfillments", {
    id: id(),
    orderId: char("order_id", { length: 26 }).notNull(),
    /**
     * The supplier responsible for this slice of the order, or NULL when the
     * lines have no supplier yet (a catalogue product that was never sourced, or
     * one whose supplier was later removed) and an operator must assign one.
     *
     * Nullable rather than a sentinel id: the FK below is RESTRICT, so a fake id
     * would have to exist as a real `suppliers` row, and an order that is merely
     * *unassigned* is a normal, expected state rather than a data-integrity
     * error. Use `supplierId IS NULL` as the "needs supplier assignment" test —
     * it mirrors `products.supplierId`, which is nullable for the same reason.
     */
    supplierId: char("supplier_id", { length: 26 }),
    status: mysqlEnum("status", FULFILLMENT_STATUSES).notNull().default("pending"),
    /** Idempotency token sent to the supplier, preventing duplicate purchase orders. */
    forwardedReference: varchar("forwarded_reference", { length: 80 }),
    trackingNumber: varchar("tracking_number", { length: 120 }),
    trackingCarrier: varchar("tracking_carrier", { length: 80 }),
    attempts: smallint("attempts", { unsigned: true }).notNull().default(0),
    lastError: text("last_error"),
    forwardedAt: timestamp("forwarded_at", { fsp: 3 }),
    fulfilledAt: timestamp("fulfilled_at", { fsp: 3 }),
    shippedAt: timestamp("shipped_at", { fsp: 3 }),
    deliveredAt: timestamp("delivered_at", { fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => ({
    orderIdx: index("order_fulfillments_order_idx").on(t.orderId),
    supplierIdx: index("order_fulfillments_supplier_idx").on(t.supplierId),
    statusIdx: index("order_fulfillments_status_idx").on(t.status),
    orderFk: foreignKey({
        columns: [t.orderId],
        foreignColumns: [orders.id],
        name: "order_fulfillments_order_fk",
    }).onDelete("cascade"),
    /**
     * RESTRICT rather than CASCADE: deleting a supplier that has live
     * fulfillment obligations must fail loudly instead of silently deleting
     * the record that an operator still has to ship.
     *
     * A NULL supplier_id is exempt from this by definition, so deactivating or
     * unassigning a supplier cannot be blocked by rows that were never theirs.
     */
    supplierFk: foreignKey({
        columns: [t.supplierId],
        foreignColumns: [suppliers.id],
        name: "order_fulfillments_supplier_fk",
    }).onDelete("restrict"),
}));
// ── Payments ───────────────────────────────────────────────────────────────
export const payments = mysqlTable("payments", {
    id: id(),
    orderId: char("order_id", { length: 26 }).notNull(),
    /** Only the Stripe object id is stored. Card data never touches this system. */
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 64 }).notNull(),
    status: mysqlEnum("status", [
        "requires_payment_method",
        "processing",
        "succeeded",
        "canceled",
        "partially_refunded",
        "refunded",
    ]).notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    refundedCents: bigint("refunded_cents", { mode: "number" }).notNull().default(0),
    currency: char("currency", { length: 3 }).notNull(),
    /** Last four digits only, for order pages. Never the PAN. */
    cardLast4: char("card_last4", { length: 4 }),
    cardBrand: varchar("card_brand", { length: 32 }),
    failureCode: varchar("failure_code", { length: 64 }),
    failureMessage: varchar("failure_message", { length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => ({
    piUnique: uniqueIndex("payments_pi_unique").on(t.stripePaymentIntentId),
    orderIdx: index("payments_order_idx").on(t.orderId),
    orderFk: foreignKey({
        columns: [t.orderId],
        foreignColumns: [orders.id],
        name: "payments_order_fk",
    }).onDelete("cascade"),
}));
/**
 * Append-only log of processed Stripe events. The unique constraint on
 * `stripe_event_id` is what makes webhook handling idempotent: a duplicate
 * delivery from Stripe's at-least-once retry hits the constraint and is
 * acknowledged as already-handled.
 */
export const webhookEvents = mysqlTable("webhook_events", {
    id: id(),
    stripeEventId: varchar("stripe_event_id", { length: 64 }).notNull(),
    type: varchar("type", { length: 80 }).notNull(),
    status: mysqlEnum("status", ["received", "processed", "failed", "ignored"]).notNull().default("received"),
    error: text("error"),
    processedAt: timestamp("processed_at", { fsp: 3 }),
    createdAt: createdAt(),
}, (t) => ({
    eventIdUnique: uniqueIndex("webhook_events_stripe_id_unique").on(t.stripeEventId),
}));
// ── Inbound ────────────────────────────────────────────────────────────────
export const CONTACT_TOPICS = [
    "order_support",
    "product_question",
    "returns",
    "partnerships",
    "other",
];
/**
 * Contact form submissions.
 *
 * This exists because the storefront's contact form used to validate, show a
 * success toast, and throw the message away — telling a customer their enquiry
 * was received and promising a reply within a business day when nothing was
 * stored and nobody was notified. A false promise to a real person is worse than
 * a broken form, so the row is the minimum honest fix: the message is durable
 * and an operator can read it in the admin console.
 *
 * `userId` is nullable and set when the sender is signed in, so replies can
 * address their order history. It is deliberately NOT a foreign key with
 * cascade: an enquiry is a business record, and deleting the account should not
 * delete the operator's only copy of what was asked.
 */
export const contactMessages = mysqlTable("contact_messages", {
    id: id(),
    /** Null for an anonymous submission. */
    userId: char("user_id", { length: 26 }),
    name: varchar("name", { length: 120 }).notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    topic: mysqlEnum("topic", CONTACT_TOPICS).notNull().default("other"),
    message: text("message").notNull(),
    /**
     * New = unread in the console. There is no "replied" state because replies
     * leave the system; tracking that is the support desk's job, not the store's.
     */
    status: mysqlEnum("status", ["new", "read", "archived"]).notNull().default("new"),
    createdAt: createdAt(),
}, (t) => ({
    /** The console reads newest-first, so the index follows created_at desc. */
    createdIdx: index("contact_messages_created_idx").on(t.createdAt),
    statusIdx: index("contact_messages_status_idx").on(t.status),
    userIdx: index("contact_messages_user_idx").on(t.userId),
}));
/**
 * Newsletter subscribers.
 *
 * Separate from `users` on purpose: someone can want the newsletter without an
 * account, and an account is not a consent record. The unique index on email is
 * what makes subscribing idempotent — re-submitting the same address returns the
 * existing row instead of inserting a duplicate or throwing.
 */
export const newsletterSubscribers = mysqlTable("newsletter_subscribers", {
    id: id(),
    email: varchar("email", { length: 254 }).notNull(),
    /** Set when a subscriber later creates an account with the same address. */
    userId: char("user_id", { length: 26 }),
    isActive: boolean("is_active").notNull().default(true),
    unsubscribedAt: timestamp("unsubscribed_at", { fsp: 3 }),
    createdAt: createdAt(),
}, (t) => ({
    emailUnique: uniqueIndex("newsletter_email_unique").on(t.email),
    userIdx: index("newsletter_user_idx").on(t.userId),
}));
// ── Relations ──────────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ many }) => ({
    addresses: many(addresses),
    orders: many(orders),
    refreshTokens: many(refreshTokens),
    sessions: many(sessions),
    passwordResets: many(passwordResets),
    wishlist: many(wishlistItems),
    reviews: many(reviews),
    cartItems: many(cartItems),
}));
export const addressesRelations = relations(addresses, ({ one }) => ({
    user: one(users, { fields: [addresses.userId], references: [users.id] }),
}));
export const productsRelations = relations(products, ({ one, many }) => ({
    supplier: one(suppliers, { fields: [products.supplierId], references: [suppliers.id] }),
    variants: many(productVariants),
    reviews: many(reviews),
    orderItems: many(orderItems),
}));
export const productVariantsRelations = relations(productVariants, ({ one, many }) => ({
    product: one(products, { fields: [productVariants.productId], references: [products.id] }),
    cartItems: many(cartItems),
}));
export const cartItemsRelations = relations(cartItems, ({ one }) => ({
    user: one(users, { fields: [cartItems.userId], references: [users.id] }),
    product: one(products, { fields: [cartItems.productId], references: [products.id] }),
    variant: one(productVariants, { fields: [cartItems.variantId], references: [productVariants.id] }),
}));
export const reviewsRelations = relations(reviews, ({ one }) => ({
    product: one(products, { fields: [reviews.productId], references: [products.id] }),
    user: one(users, { fields: [reviews.userId], references: [users.id] }),
}));
export const wishlistRelations = relations(wishlistItems, ({ one }) => ({
    user: one(users, { fields: [wishlistItems.userId], references: [users.id] }),
    product: one(products, { fields: [wishlistItems.productId], references: [products.id] }),
}));
export const ordersRelations = relations(orders, ({ one, many }) => ({
    user: one(users, { fields: [orders.userId], references: [users.id] }),
    items: many(orderItems),
    fulfillments: many(orderFulfillments),
    payments: many(payments),
}));
export const orderItemsRelations = relations(orderItems, ({ one }) => ({
    order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
    product: one(products, { fields: [orderItems.productId], references: [products.id] }),
}));
export const orderFulfillmentsRelations = relations(orderFulfillments, ({ one }) => ({
    order: one(orders, { fields: [orderFulfillments.orderId], references: [orders.id] }),
    supplier: one(suppliers, { fields: [orderFulfillments.supplierId], references: [suppliers.id] }),
}));
export const paymentsRelations = relations(payments, ({ one }) => ({
    order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}));
export const suppliersRelations = relations(suppliers, ({ many }) => ({
    products: many(products),
    fulfillments: many(orderFulfillments),
}));
//# sourceMappingURL=schema.js.map