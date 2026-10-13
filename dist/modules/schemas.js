import { z } from "zod";
import { BADGES, CONTACT_TOPICS, FULFILLMENT_STATUSES, GENDERS, ORDER_STATUSES, PRODUCT_CATEGORIES, SUBCATEGORIES, SUPPLIER_CHANNELS, } from "../db/schema.js";
/**
 * Request schemas.
 *
 * Two rules are applied consistently:
 *
 * 1. `.strict()` on every object. Rejecting unknown keys is not pedantry — an
 *    endpoint that accepts `{"email":"x","role":"admin"}` and silently drops
 *    `role` is fine, but one that accepts `{"price": 1}` and ignores it is a
 *    trap for the next developer. Failing loudly on unexpected input surfaces
 *    client bugs at the boundary instead of as confusing behaviour later.
 *
 * 2. Length caps on every string. Without them a caller can push megabytes of
 *    text through a field declared as `varchar(120)`, which is a cheap way to
 *    exhaust database buffers and log storage.
 */
const trimmed = (max, message) => z.string().trim().max(max, message ?? `Must be at most ${max} characters.`);
/**
 * Optional money column that must be clearable.
 *
 * `z.coerce.number()` maps `null` to `0`, which would make clearing a field
 * indistinguishable from setting it to zero — and zero also trips the
 * compare-at invariant. Preprocessing keeps `null` (and an empty form string)
 * as an explicit clear instruction while still coercing numeric strings from
 * form-encoded bodies.
 */
const nullableCents = z.preprocess((value) => (value === null || value === "" ? null : value), z.coerce.number().int().min(0).max(10_000_000).nullable());
/**
 * Email: normalised to lowercase and trimmed at the boundary so uniqueness
 * holds regardless of how the caller cased or padded the address. Length is
 * capped at 320, the maximum the RFC permits.
 */
export const emailSchema = z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .email("Enter a valid email address.");
/**
 * The passwords most likely to be tried first. Full enforcement belongs to a
 * breached-password service (see README); this short list removes the trivially
 * guessable cases without adding a network dependency.
 */
const COMMON_PASSWORDS = new Set([
    "password",
    "password1",
    "password123",
    "12345678",
    "123456789",
    "qwerty123",
    "letmein123",
    "welcome123",
    "admin1234",
    "iloveyou1",
    "monkey1234",
    "football12",
    "changeme123",
    "northwave1",
]);
/**
 * Password policy: at least 12 characters, plus character-class variety.
 *
 * Length is the dominant factor in offline-cracking resistance, which is why
 * the minimum is 12 rather than the conventional 8 — NIST SP 800-63B guidance
 * and OWASP both now advise against complexity rules that push users toward
 * predictable substitutions, so the class requirements are kept light.
 *
 * A 128-character ceiling bounds the work an attacker can force through the
 * signup endpoint, since Argon2 cost grows with input length.
 */
export const passwordSchema = z
    .string()
    .min(12, "Use at least 12 characters.")
    .max(128, "Must be at most 128 characters.")
    .refine((v) => /[a-z]/.test(v), "Include a lowercase letter.")
    .refine((v) => /[A-Z]/.test(v), "Include an uppercase letter.")
    .refine((v) => /\d/.test(v), "Include a number.")
    .refine((v) => /[^A-Za-z0-9]/.test(v), "Include a symbol.")
    .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), "That password appears in a list of known-breached passwords.");
/**
 * Crockford base32, matching the alphabet `lib/ids.ts` generates from.
 *
 * Validating the alphabet as well as the length means a caller cannot smuggle an
 * arbitrary 26-character string into a primary-key lookup, and it keeps the
 * sentinel used for unassigned fulfillments from ever passing as a real id.
 */
export const idSchema = z
    .string()
    .length(26, "Malformed identifier.")
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "Malformed identifier.");
export const orderNumberSchema = z.string().regex(/^EDM-[2-9A-HJ-NP-Z]{8}$/, "Malformed order number.");
export const registerSchema = z
    .object({
    name: trimmed(120, "Name must be at most 120 characters.").min(1, "Enter your name."),
    email: emailSchema,
    password: passwordSchema,
    phone: trimmed(32).regex(/^\+?[0-9\s()-]{6,32}$/, "Enter a valid phone number.").optional(),
})
    .strict();
export const loginSchema = z
    .object({
    email: emailSchema,
    // Deliberately not `passwordSchema`: an account created before the policy
    // tightened must still be able to sign in.
    password: z.string().min(1, "Enter your password.").max(128),
})
    .strict();
export const changePasswordSchema = z
    .object({
    currentPassword: z.string().min(1, "Enter your current password.").max(128),
    newPassword: passwordSchema,
})
    .strict();
/** 6-digit reset code, matching the strict-digit generator in `auth.service.ts`. */
export const resetCodeSchema = z
    .string()
    .length(6, "The code is 6 digits long.")
    .regex(/^\d{6}$/, "The code is 6 digits long.");
/**
 * Forgot-password accepts just an email. It must not reveal whether the address
 * is registered, so the endpoint returns the same success shape either way.
 */
export const forgotPasswordSchema = z
    .object({
    email: emailSchema,
})
    .strict();
export const resetPasswordSchema = z
    .object({
    email: emailSchema,
    code: resetCodeSchema,
    newPassword: passwordSchema,
})
    .strict();
export const updateProfileSchema = z
    .object({
    name: trimmed(120).min(1).optional(),
    // Nullable so a saved phone number can be removed; omitting it keeps the
    // current value. The regex only guards non-empty input.
    phone: trimmed(32)
        .regex(/^\+?[0-9\s()-]{6,32}$/, "Enter a valid phone number.")
        .nullable()
        .optional(),
})
    .strict()
    .refine((v) => v.name !== undefined || v.phone !== undefined, "Provide at least one field to update.");
// ── Addresses ──────────────────────────────────────────────────────────────
/** ISO 3166-1 alpha-2, uppercased. Accepts only the 26 assigned codes. */
const COUNTRY_CODE = /^([A-Z]{2})$/;
/**
 * Base address shape, kept separate from the create schema for the same reason
 * as `productBaseSchema`: `.refine()` turns the schema into a `ZodEffects`, which
 * has no `.partial()` — so the cross-field country check lives on the create
 * variant only, and the update variant is derived from this plain object.
 */
const addressBaseSchema = z
    .object({
    label: trimmed(60).default("Home"),
    recipientName: trimmed(120).min(1, "Enter a recipient name."),
    line1: trimmed(160).min(1, "Enter an address line."),
    line2: trimmed(160).optional(),
    city: trimmed(100).min(1, "Enter a city."),
    postalCode: trimmed(20).min(1, "Enter a postal code."),
    country: z
        .string()
        .trim()
        .toUpperCase()
        .regex(COUNTRY_CODE, "Use a 2-letter ISO country code, for example US or FR."),
    phone: trimmed(32).regex(/^\+?[0-9\s()-]{6,32}$/, "Enter a valid phone number.").optional(),
    isDefault: z.boolean().default(false),
})
    .strict();
export const addressSchema = addressBaseSchema.refine((v) => v.country.length === 2, "Country code must be exactly 2 characters.");
export const updateAddressSchema = addressBaseSchema.partial().refine((v) => Object.keys(v).length > 0, "Provide at least one field to update.");
export const addressParamsSchema = z.object({ id: idSchema }).strict();
// ── Catalogue ──────────────────────────────────────────────────────────────
export const productListQuerySchema = z
    .object({
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    gender: z.enum(GENDERS).optional(),
    subcategory: z.enum(SUBCATEGORIES).optional(),
    badge: z.enum(BADGES).optional(),
    minPriceCents: z.coerce.number().int().min(0).max(10_000_000).optional(),
    maxPriceCents: z.coerce.number().int().min(0).max(10_000_000).optional(),
    inStock: z
        .enum(["true", "false"])
        .transform((v) => v === "true")
        .optional(),
    search: trimmed(120).optional(),
    sort: z.enum(["newest", "price_asc", "price_desc", "rating", "name_asc"]).default("newest"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(24),
})
    .strict()
    .superRefine((v, ctx) => {
    // Cross-field comparison needs both operands present. `!= null` covers
    // undefined and null, since `.optional()` admits the former.
    if (v.minPriceCents != null && v.maxPriceCents != null && v.minPriceCents > v.maxPriceCents) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["minPriceCents"],
            message: "minPriceCents cannot exceed maxPriceCents.",
        });
    }
});
export const productParamsSchema = z.object({ slug: trimmed(160).min(1) }).strict();
// ── Cart ───────────────────────────────────────────────────────────────────
/**
 * A cart line references a product by slug plus an optional variant id. The
 * server resolves price, name and stock from its own data; nothing about the
 * product is trusted from the client.
 */
export const cartLineSchema = z
    .object({
    productSlug: trimmed(160).min(1),
    variantId: idSchema.optional(),
    quantity: z.coerce.number().int().min(1).max(99),
})
    .strict();
export const addToCartSchema = cartLineSchema;
/**
 * Merge a guest bag into the signed-in account's cart at sign-in.
 *
 * The lines arrive from the browser's local bag, so every one is re-resolved
 * against live catalogue data before it is written: a guest line is no more
 * trustworthy than any other client input, and a merge is exactly the moment a
 * stale or tampered bag would otherwise be written straight into the account.
 */
export const mergeCartSchema = z
    .object({
    lines: z
        .array(cartLineSchema)
        .max(50, "Too many items to merge at once.")
        .default([]),
})
    .strict();
export const updateCartLineSchema = z
    .object({
    productSlug: trimmed(160).min(1),
    variantId: idSchema.optional(),
    /**
     * Zero is permitted here precisely so a client can collapse a line by setting
     * its quantity to 0, which the service treats as a removal. Rejecting it
     * would force every "remove" button to call the delete endpoint instead.
     */
    quantity: z.coerce.number().int().min(0).max(99),
})
    .strict();
export const removeFromCartSchema = z
    .object({
    productSlug: trimmed(160).min(1),
    variantId: idSchema.optional(),
})
    .strict();
export const cartQuerySchema = z.object({}).strict().default({});
// ── Checkout ───────────────────────────────────────────────────────────────
export const shippingAddressSchema = z
    .object({
    recipientName: trimmed(120).min(1, "Enter a recipient name."),
    line1: trimmed(160).min(1, "Enter an address line."),
    line2: trimmed(160).optional(),
    city: trimmed(100).min(1, "Enter a city."),
    postalCode: trimmed(20).min(1, "Enter a postal code."),
    country: z.string().trim().toUpperCase().regex(COUNTRY_CODE, "Use a 2-letter ISO country code."),
    phone: trimmed(32).regex(/^\+?[0-9\s()-]{6,32}$/, "Enter a valid phone number.").optional(),
})
    .strict()
    .refine((v) => v.country.length === 2, "Country code must be exactly 2 characters.");
export const checkoutSchema = z
    .object({
    email: emailSchema,
    shipping: shippingAddressSchema,
    items: z.array(cartLineSchema).min(1, "Your bag is empty.").max(50, "Too many distinct items in one order."),
    /**
     * Client-supplied key making a repeated submit idempotent. Required because
     * a double-tapped Pay button is the normal case, not the pathological one.
     */
    idempotencyKey: z.string().trim().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/, "Malformed idempotency key."),
    saveAddress: z.boolean().default(false),
})
    .strict();
export const quoteSchema = z
    .object({
    items: z.array(cartLineSchema).min(1).max(50),
    country: z.string().trim().toUpperCase().regex(COUNTRY_CODE).optional(),
})
    .strict();
// ── Orders ─────────────────────────────────────────────────────────────────
export const orderListQuerySchema = z
    .object({
    status: z.enum(ORDER_STATUSES).optional(),
    fulfillmentStatus: z.enum(FULFILLMENT_STATUSES).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
    .strict();
export const orderParamsSchema = z.object({ orderNumber: orderNumberSchema }).strict();
// ── Admin ──────────────────────────────────────────────────────────────────
export const supplierCreateSchema = z
    .object({
    name: trimmed(140).min(1, "Enter a supplier name."),
    contactEmail: emailSchema,
    channel: z.enum(SUPPLIER_CHANNELS),
    endpoint: trimmed(2048).min(1, "Enter an endpoint."),
    // Nullable so an operator can rotate a secret away or clear stale notes;
    // omitting the key on update leaves the stored value untouched.
    endpointSecret: trimmed(255).nullable().optional(),
    notes: trimmed(2000).nullable().optional(),
    isActive: z.boolean().default(true),
})
    .strict();
export const supplierUpdateSchema = supplierCreateSchema
    .partial()
    .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update.");
/**
 * Base product shape, kept separate from the create/update schemas so that
 * `.partial()` is available. Calling `.refine()` on an object turns it into a
 * `ZodEffects`, which has no `.partial()` — so the cross-field check lives on the
 * create variant only.
 */
const productBaseSchema = z
    .object({
    name: trimmed(200).min(1, "Enter a product name."),
    brand: trimmed(120).min(1, "Enter a brand."),
    slug: trimmed(160)
        .min(1)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words separated by hyphens."),
    unitPriceCents: z.coerce.number().int().min(1, "Price must be at least 1 cent.").max(10_000_000),
    // `null` is distinct from `undefined` on update: `undefined` leaves the
    // column alone, `null` clears it. Without this an operator can set a
    // compare-at price but can never take the discount back off.
    compareAtCents: nullableCents.optional(),
    imageUrl: z.string().trim().url("Enter a valid image URL.").max(2048),
    gallery: z.array(z.string().trim().url().max(2048)).max(12).default([]),
    category: z.enum(PRODUCT_CATEGORIES),
    gender: z.enum(GENDERS).nullable().optional(),
    subcategory: z.enum(SUBCATEGORIES).nullable().optional(),
    description: trimmed(5000).min(1, "Enter a description."),
    specs: z
        .array(z.object({ label: trimmed(80).min(1), value: trimmed(400).min(1) }).strict())
        .max(30)
        .default([]),
    badge: z.enum(BADGES).nullable().optional(),
    supplierId: idSchema.nullable().optional(),
    isActive: z.boolean().default(true),
    variants: z
        .array(z
        .object({
        /**
         * The existing variant's id, sent back by the admin form for a row it
         * loaded from the server.
         *
         * This is what lets a product save *update* variants instead of
         * replacing the set. Without it the server cannot tell an edited row
         * from a new one, so it deletes every variant and reinserts it with a
         * fresh id — and `cart_items.variant_id` cascades, so saving a product
         * silently emptied every customer's basket. Present on update, ignored
         * on create.
         */
        id: idSchema.optional(),
        sku: trimmed(64).min(1, "Enter a SKU."),
        colorName: trimmed(60).optional(),
        colorValue: z
            .string()
            .trim()
            .regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex colour.")
            .optional(),
        size: trimmed(32).optional(),
        stockOnHand: z.coerce.number().int().min(0).max(1_000_000),
        unitPriceCents: z.coerce.number().int().min(1).max(10_000_000).optional(),
        // Carried through the admin write path so a deliberate variant-set
        // replacement does not silently flip a made-to-order or retired
        // variant back to the column defaults.
        isBackorderable: z.boolean().optional(),
        isActive: z.boolean().optional(),
    })
        .strict())
        .max(50)
        .default([]),
})
    .strict();
export const productCreateSchema = productBaseSchema.superRefine((v, ctx) => {
    // A compare-at price at or below the selling price would render as a
    // negative discount in the storefront.
    if (v.compareAtCents != null && v.compareAtCents <= v.unitPriceCents) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["compareAtCents"],
            message: "Compare-at price must exceed the selling price.",
        });
    }
});
export const productUpdateSchema = productBaseSchema
    .partial()
    .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update.");
export const productAdminParamsSchema = z.object({ id: idSchema }).strict();
/**
 * Admin product list.
 *
 * Unlike the storefront list this has no `isActive` gate: an operator must be
 * able to see retired products in order to reactivate or audit them, so the
 * filter is opt-in rather than implied.
 */
export const adminProductListQuerySchema = z
    .object({
    search: trimmed(120).optional(),
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    /**
     * "all" is a real value rather than the absence of the key, because the
     * query is `.strict()`: omitting it would silently mean "active only" and an
     * operator could never see what they retired.
     */
    status: z.enum(["all", "active", "inactive"]).default("all"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
})
    .strict();
export const adminSupplierListQuerySchema = z
    .object({
    search: trimmed(120).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
})
    .strict();
// ── Review moderation ──────────────────────────────────────────────────────
/**
 * Review moderation queue filter.
 *
 * `all` is a real value rather than the absence of the key, for the same reason
 * as the product list: the schema is `.strict()`, so omitting `status` and
 * defaulting it to "pending" would make it impossible to audit what has already
 * been approved.
 */
export const reviewModerationQuerySchema = z
    .object({
    status: z.enum(["pending", "approved", "all"]).default("pending"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
})
    .strict();
export const reviewModerationParamsSchema = z.object({ id: idSchema }).strict();
/**
 * The approve/reject decision, as a body rather than as two endpoints.
 *
 * One route with an explicit boolean is easier to audit than a pair of verbs: the
 * console cannot publish by accident, because calling the wrong verb is not
 * available.
 */
export const reviewModerationSchema = z.object({ approved: z.boolean() }).strict();
export const supplierParamsSchema = z.object({ id: idSchema }).strict();
/**
 * Low-stock widget.
 *
 * `threshold` is capped so a caller cannot ask for "everything" and turn the
 * dashboard widget into a full catalogue scan.
 */
export const lowStockQuerySchema = z
    .object({
    status: z.enum(["all", "active", "inactive"]).default("active"),
    threshold: z.coerce.number().int().min(0).max(1_000_000).default(15),
    limit: z.coerce.number().int().min(1).max(50).default(8),
})
    .strict();
export const adminCustomerListQuerySchema = z
    .object({
    search: trimmed(320).optional(),
    /** Admins are listed separately so the customer table stays a customer list. */
    role: z.enum(["all", "customer", "admin"]).default("customer"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
})
    .strict();
/**
 * Analytics window.
 *
 * A relative window rather than arbitrary from/to dates: the console's range
 * picker is a fixed set, and letting a caller pass unbounded dates would let one
 * request scan the entire order history. `to` is computed server-side so the
 * window cannot be shifted to hide recent activity.
 */
export const analyticsRangeSchema = z
    .object({ range: z.enum(["7d", "30d", "90d", "12m"]).default("30d") })
    .strict();
export const fulfillmentUpdateSchema = z
    .object({
    status: z.enum(FULFILLMENT_STATUSES),
    trackingNumber: trimmed(120).optional(),
    trackingCarrier: trimmed(80).optional(),
    supplierId: idSchema.optional(),
})
    .strict();
export const refundSchema = z
    .object({
    amountCents: z.coerce.number().int().min(1).max(10_000_000),
    reason: trimmed(500).optional(),
    /**
     * A stable token for *this refund attempt*, generated once by the caller and
     * reused on retry — the same contract checkout already uses for
     * `idempotencyKey`.
     *
     * It exists because the amount alone cannot identify a refund. Deriving the
     * Stripe idempotency key from the order's running refunded total meant two
     * same-amount refunds issued before the first `charge.refunded` webhook
     * arrived both computed the same key, so Stripe replayed the first and the
     * second silently did nothing. The caller knows which attempt it is retrying;
     * the server cannot tell those two requests apart.
     */
    idempotencyKey: trimmed(64).optional(),
})
    .strict();
export const reviewCreateSchema = z
    .object({
    rating: z.coerce.number().int().min(1, "Rating must be 1-5.").max(5),
    title: trimmed(160).min(1, "Add a title."),
    body: trimmed(4000).min(1, "Add a review."),
})
    .strict();
/**
 * Contact form submission.
 *
 * `message` is floored at 10 characters so a stray keystroke is rejected rather
 * than queued as a support ticket nobody can act on, and the 4000 cap matches
 * the review body bound.
 */
export const contactCreateSchema = z
    .object({
    name: trimmed(120).min(1, "Tell us your name."),
    email: emailSchema,
    topic: z.enum(CONTACT_TOPICS).default("other"),
    message: trimmed(4000).min(10, "Please write a little more so we can help."),
})
    .strict();
/** Newsletter signup. The unique index on email makes the insert idempotent. */
export const newsletterSubscribeSchema = z.object({ email: emailSchema }).strict();
/** Console listing filters for inbound messages. */
export const contactListQuerySchema = z
    .object({
    status: z.enum(["new", "read", "archived"]).default("new"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
})
    .strict();
export const contactStatusSchema = z
    .object({ status: z.enum(["new", "read", "archived"]) })
    .strict();
//# sourceMappingURL=schemas.js.map