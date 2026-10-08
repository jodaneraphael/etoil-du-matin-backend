import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  FULFILLMENT_STATUSES,
  orderFulfillments,
  orderItems,
  orders,
  productVariants,
  products,
  suppliers,
  users,
  type FulfillmentStatus,
  type OrderStatus,
  type Product,
  type UserRole,
} from "../../db/schema.js";
import { env } from "../../env.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { LIKE_ESCAPE, likeContains } from "../../lib/like.js";
import type {
  AdminCustomerListQuery,
  AdminProductListQuery,
  AdminSupplierListQuery,
  AnalyticsRange,
  LowStockQuery,
  ProductCreateInput,
  ProductUpdateInput,
  SupplierCreateInput,
  SupplierUpdateInput,
} from "../schemas.js";

/**
 * Admin console read/write side.
 *
 * Two rules run through everything here:
 *
 * 1. Nothing is derived from a client-supplied figure. Prices, stock, revenue
 *    and counts are all read from the database, so the console can only ever
 *    display what checkout would actually honour.
 *
 * 2. Deletes are retirements, not DELETEs. A product that has been ordered and
 *    a supplier with live fulfillment obligations both carry history the ledger
 *    needs; flipping `is_active` hides them from the storefront and the
 *    forwarding queue while leaving the sales record intact. The FKs on
 *    `order_items` (SET NULL) and `order_fulfillments` (RESTRICT) mean a hard
 *    delete would either rewrite history or hard-fail with an opaque error.
 *
 * The order/fulfillment console already lives in `orders.service.ts`; this
 * module owns products, suppliers, customers and analytics.
 */

// ── Shared helpers ─────────────────────────────────────────────────────────

/** An order that actually took money: charged, possibly since refunded. */
const CHARGED: OrderStatus[] = ["paid", "refunded"];

/** Net value of an order after any refund, in cents. */
const netCents = (total: number, refunded: number): number => total - refunded;

/** Wrap a `COUNT()`/`SUM()` (BIGINT in MySQL) as a plain number. */
const n = (value: unknown): number => Number(value ?? 0);

/**
 * Assert a supplier id resolves, so a bad id becomes a 404 naming the problem
 * instead of a 500 from the foreign key.
 */
const assertSupplierExists = async (supplierId: string): Promise<void> => {
  const [row] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
  if (!row) throw notFound("Supplier not found.");
};

/** Turn a duplicate-key database error into a clean 409. */
const rethrowDuplicate = (error: unknown, message: string): never => {
  if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ER_DUP_ENTRY") {
    throw conflict(message);
  }
  throw error;
};

// ── Products ───────────────────────────────────────────────────────────────

export interface AdminProductListItem {
  id: string;
  slug: string;
  name: string;
  brand: string;
  category: Product["category"];
  gender: Product["gender"];
  subcategory: Product["subcategory"];
  unitPriceCents: number;
  compareAtCents: number | null;
  badge: Product["badge"];
  imageUrl: string;
  isActive: boolean;
  /** Number of variant rows attached to the product. */
  variantCount: number;
  /** Sum of on-hand stock across all variants. 0 means fully sold out. */
  totalStock: number;
  rating: number;
  reviewCount: number;
  createdAt: string;
}

export interface AdminVariantView {
  id: string;
  sku: string;
  colorName: string | null;
  colorValue: string | null;
  size: string | null;
  stockOnHand: number;
  isBackorderable: boolean;
  unitPriceCents: number | null;
  isActive: boolean;
}

export interface AdminProductDetail extends AdminProductListItem {
  gallery: string[];
  description: string;
  specs: { label: string; value: string }[];
  supplierId: string | null;
  variants: AdminVariantView[];
}

/**
 * Variant counts and stock for a page of products in one grouped query.
 *
 * LEFT JOIN semantics: a product with no variants gets 0, not a missing row.
 */
const variantAggregates = async (productIds: string[]): Promise<Map<string, { variantCount: number; totalStock: number }>> => {
  const out = new Map<string, { variantCount: number; totalStock: number }>();
  if (productIds.length === 0) return out;
  const rows = await db
    .select({
      productId: productVariants.productId,
      variantCount: count(),
      totalStock: sql<number>`COALESCE(SUM(${productVariants.stockOnHand}), 0)`,
    })
    .from(productVariants)
    .where(inArray(productVariants.productId, productIds))
    .groupBy(productVariants.productId);
  for (const row of rows) {
    out.set(row.productId, { variantCount: n(row.variantCount), totalStock: n(row.totalStock) });
  }
  return out;
};

const toListItem = (p: Product, agg: { variantCount: number; totalStock: number } | undefined): AdminProductListItem => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  brand: p.brand,
  category: p.category,
  gender: p.gender,
  subcategory: p.subcategory,
  unitPriceCents: p.unitPriceCents,
  compareAtCents: p.compareAtCents,
  badge: p.badge,
  imageUrl: p.imageUrl,
  isActive: p.isActive,
  variantCount: agg?.variantCount ?? 0,
  totalStock: agg?.totalStock ?? 0,
  rating: p.rating / 1000,
  reviewCount: p.reviewCount,
  createdAt: p.createdAt.toISOString(),
});

/**
 * Admin product list.
 *
 * Includes retired products (the `status` filter defaults to "all") so an
 * operator can find and reactivate something they took down.
 */
export const listAdminProducts = async (filters: AdminProductListQuery) => {
  const where = [];
  if (filters.category) where.push(eq(products.category, filters.category));
  if (filters.status === "active") where.push(eq(products.isActive, true));
  if (filters.status === "inactive") where.push(eq(products.isActive, false));
  if (filters.search) {
    const term = likeContains(filters.search);
    where.push(
      sql`(${products.name} LIKE ${term} ESCAPE ${LIKE_ESCAPE} OR ${products.brand} LIKE ${term} ESCAPE ${LIKE_ESCAPE} OR ${products.slug} LIKE ${term} ESCAPE ${LIKE_ESCAPE})`,
    );
  }
  const w = where.length > 0 ? and(...where) : undefined;

  const [countRow] = await db.select({ total: count() }).from(products).where(w);
  const total = n(countRow?.total);

  const rows = await db
    .select()
    .from(products)
    .where(w)
    .orderBy(desc(products.createdAt))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  const aggs = await variantAggregates(rows.map((r) => r.id));

  return {
    products: rows.map((r) => toListItem(r, aggs.get(r.id))),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
  };
};

/** Full product with variants, for the edit form. Includes retired products. */
export const getAdminProduct = async (id: string): Promise<AdminProductDetail> => {
  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!product) throw notFound("Product not found.");

  const variantRows = await db.select().from(productVariants).where(eq(productVariants.productId, id));
  const aggs = await variantAggregates([id]);

  return {
    ...toListItem(product, aggs.get(id)),
    gallery: product.gallery,
    description: product.description,
    specs: product.specs,
    supplierId: product.supplierId,
    variants: variantRows.map((v) => ({
      id: v.id,
      sku: v.sku,
      colorName: v.colorName,
      colorValue: v.colorValue,
      size: v.size,
      stockOnHand: v.stockOnHand,
      isBackorderable: v.isBackorderable,
      unitPriceCents: v.unitPriceCents,
      isActive: v.isActive,
    })),
  };
};

const variantInserts = (productId: string, variants: ProductCreateInput["variants"]) =>
  variants.map((v) => ({
    id: newId(),
    productId,
    sku: v.sku,
    colorName: v.colorName ?? null,
    colorValue: v.colorValue ?? null,
    size: v.size ?? null,
    stockOnHand: v.stockOnHand,
    unitPriceCents: v.unitPriceCents ?? null,
    isBackorderable: v.isBackorderable ?? false,
    isActive: v.isActive ?? true,
  }));

type VariantInput = ProductCreateInput["variants"][number];
type VariantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Bring a product's variants in line with an incoming set, by diff.
 *
 * The previous implementation deleted every variant and reinserted the whole set
 * with fresh ids. That is destructive in a way that is invisible from the API
 * response: `cart_items.variant_id` carries `ON DELETE CASCADE`, so saving a
 * product — even to change one price — deleted the matching row from every
 * open basket in the system. Customers lost their carts by an operator pressing
 * Save, and the only trace was a set of empty carts.
 *
 * The diff keeps every variant the form still lists on its existing id:
 *
 *   present with an id  -> UPDATE, and only the columns that actually changed
 *   present without an id -> INSERT (a genuinely new row)
 *   absent from the form -> DELETE (a variant the operator removed on purpose)
 *
 * Two details matter:
 *
 *   - Rows are locked `FOR UPDATE` in primary-key order. Without the lock two
 *     concurrent saves could both read the same "existing" set and each delete
 *     what the other had just inserted.
 *   - An id that does not belong to this product is rejected rather than
 *     ignored. Silently inserting a row with someone else's variant id would let
 *     a crafted request re-point a variant at a different product.
 */
const syncVariants = async (tx: VariantTx, productId: string, incoming: VariantInput[]): Promise<void> => {
  const existing = await tx
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, productId))
    .orderBy(productVariants.id)
    .for("update");

  const existingById = new Map(existing.map((v) => [v.id, v]));
  const claimed = new Set<string>();
  const toUpdate: { id: string; changes: Partial<typeof productVariants.$inferInsert> }[] = [];
  const toInsert: VariantInput[] = [];

  for (const variant of incoming) {
    const id = variant.id;

    if (id === undefined) {
      toInsert.push(variant);
      continue;
    }

    const current = existingById.get(id);
    if (!current) {
      throw badRequest("One of those options no longer exists. Reload the product and try again.");
    }
    if (claimed.has(id)) {
      throw badRequest("The same option is listed twice.");
    }
    claimed.add(id);

    /**
     * Only the fields the operator can actually have changed are compared.
     * `stockOnHand` is included on purpose: it is a real inventory edit and has
     * to be written even though it is not part of the "identity" of a variant.
     */
    const changes: Partial<typeof productVariants.$inferInsert> = {};
    const assign = <K extends keyof VariantInput & keyof typeof productVariants.$inferInsert>(
      field: K,
      value: VariantInput[K],
    ) => {
      const next = value ?? null;
      if (current[field] !== next) changes[field] = value as never;
    };

    assign("sku", variant.sku);
    assign("colorName", variant.colorName);
    assign("colorValue", variant.colorValue);
    assign("size", variant.size);
    assign("unitPriceCents", variant.unitPriceCents);
    assign("isBackorderable", variant.isBackorderable ?? false);
    assign("isActive", variant.isActive ?? true);
    if (current.stockOnHand !== variant.stockOnHand) changes.stockOnHand = variant.stockOnHand;

    // A variant with nothing to change is skipped rather than written, so
    // `updated_at` keeps meaning "this row was actually edited".
    if (Object.keys(changes).length > 0) toUpdate.push({ id, changes });
  }

  const removed = existing.filter((v) => !claimed.has(v.id)).map((v) => v.id);

  // Deletes first: that frees the SKUs of rows the form dropped, so a rename
  // into a just-removed SKU does not trip the unique index mid-batch.
  if (removed.length > 0) {
    await tx.delete(productVariants).where(inArray(productVariants.id, removed));
  }

  for (const { id, changes } of toUpdate) {
    await tx.update(productVariants).set(changes).where(eq(productVariants.id, id));
  }

  if (toInsert.length > 0) {
    await tx.insert(productVariants).values(variantInserts(productId, toInsert));
  }
};

/** Create a product and, in the same transaction, its initial variants. */
export const createProduct = async (input: ProductCreateInput): Promise<AdminProductDetail> => {
  if (input.supplierId) await assertSupplierExists(input.supplierId);
  const id = newId();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(products).values({
        id,
        slug: input.slug,
        name: input.name,
        brand: input.brand,
        unitPriceCents: input.unitPriceCents,
        compareAtCents: input.compareAtCents ?? null,
        imageUrl: input.imageUrl,
        gallery: input.gallery,
        category: input.category,
        gender: input.gender ?? null,
        subcategory: input.subcategory ?? null,
        description: input.description,
        specs: input.specs,
        badge: input.badge ?? null,
        supplierId: input.supplierId ?? null,
        isActive: input.isActive,
      });
      if (input.variants.length > 0) {
        await tx.insert(productVariants).values(variantInserts(id, input.variants));
      }
    });
  } catch (error) {
    rethrowDuplicate(error, "A product with that slug, or one of those SKUs, already exists.");
  }

  return getAdminProduct(id);
};

/**
 * Update a product.
 *
 * When `variants` is present it is treated as the complete replacement set and
 * diffed inside the transaction; when it is absent the variants are left
 * untouched. That lets a price or description edit avoid ever touching stock rows,
 * while a deliberate variant edit still adds and removes exactly what the operator
 * asked for.
 *
 * Variant rows keep their ids across an edit. See `syncVariants` for why that is
 * load-bearing rather than cosmetic.
 */
export const updateProduct = async (id: string, patch: ProductUpdateInput): Promise<AdminProductDetail> => {
  const existing = await getAdminProduct(id);
  if (patch.supplierId) await assertSupplierExists(patch.supplierId);

  // Re-run the compare-at invariant against the merged value: a patch that only
  // lowers the selling price can push it to or below the existing compare-at.
  // `0` is treated as "not set" so a stored zero can never wedge a row into
  // un-updatable; the clear instruction is `null`.
  const nextUnit = patch.unitPriceCents ?? existing.unitPriceCents;
  const nextCompare = patch.compareAtCents !== undefined ? patch.compareAtCents : existing.compareAtCents;
  if (nextCompare != null && nextCompare > 0 && nextCompare <= nextUnit) {
    throw badRequest("Compare-at price must exceed the selling price.");
  }

  const set: Partial<typeof products.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.brand !== undefined) set.brand = patch.brand;
  if (patch.slug !== undefined) set.slug = patch.slug;
  if (patch.unitPriceCents !== undefined) set.unitPriceCents = patch.unitPriceCents;
  if (patch.compareAtCents !== undefined) set.compareAtCents = patch.compareAtCents;
  if (patch.imageUrl !== undefined) set.imageUrl = patch.imageUrl;
  if (patch.gallery !== undefined) set.gallery = patch.gallery;
  if (patch.category !== undefined) set.category = patch.category;
  if (patch.gender !== undefined) set.gender = patch.gender;
  if (patch.subcategory !== undefined) set.subcategory = patch.subcategory;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.specs !== undefined) set.specs = patch.specs;
  if (patch.badge !== undefined) set.badge = patch.badge;
  if (patch.supplierId !== undefined) set.supplierId = patch.supplierId;
  if (patch.isActive !== undefined) set.isActive = patch.isActive;

  try {
    await db.transaction(async (tx) => {
      if (Object.keys(set).length > 0) {
        await tx.update(products).set(set).where(eq(products.id, id));
      }
      if (patch.variants !== undefined) {
        await syncVariants(tx, id, patch.variants);
      }
    });
  } catch (error) {
    rethrowDuplicate(error, "A product with that slug, or one of those SKUs, already exists.");
  }

  return getAdminProduct(id);
};

/** Retire a product: hidden from the storefront, history preserved. */
export const archiveProduct = async (id: string): Promise<AdminProductDetail> => {
  await db.update(products).set({ isActive: false }).where(eq(products.id, id));
  return getAdminProduct(id);
};

/**
 * Products whose combined variant stock has fallen to or below a threshold.
 *
 * Sold-out products are included: "0 left" is exactly the row an operator needs
 * to see, and excluding it would hide the most urgent case. Ordered ascending so
 * the emptiest shelves sit at the top of the widget.
 *
 * Back-orderable variants are excluded from the sum: a made-to-order line is
 * always purchasable, so counting it as low stock would fill the alerts list with
 * products that are not actually at risk.
 */
export const listLowStock = async (filters: LowStockQuery) => {
  const where = [sql`COALESCE(stock.total_stock, 0) <= ${filters.threshold}`];
  if (filters.status === "active") where.push(eq(products.isActive, true));
  if (filters.status === "inactive") where.push(eq(products.isActive, false));

  const rows = await db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      imageUrl: products.imageUrl,
      totalStock: sql<number>`COALESCE(stock.total_stock, 0)`,
    })
    .from(products)
    .leftJoin(
      db
        .select({
          productId: productVariants.productId,
          // The alias is load-bearing: an unnamed aggregate column in a derived
          // table is addressed by its own expression text, so the outer
          // `stock.total_stock` reference would not resolve without it.
          totalStock: sql<number>`COALESCE(SUM(${productVariants.stockOnHand}), 0)`.as("total_stock"),
        })
        .from(productVariants)
        .where(and(eq(productVariants.isActive, true), eq(productVariants.isBackorderable, false)))
        .groupBy(productVariants.productId)
        .as("stock"),
      eq(products.id, sql`stock.product_id`),
    )
    .where(and(...where))
    .orderBy(asc(sql`COALESCE(stock.total_stock, 0)`))
    .limit(filters.limit);

  return {
    products: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      imageUrl: r.imageUrl,
      totalStock: n(r.totalStock),
    })),
  };
};

// ── Suppliers ──────────────────────────────────────────────────────────────

export interface AdminSupplierView {
  id: string;
  name: string;
  channel: (typeof suppliers.$inferSelect)["channel"];
  contactEmail: string;
  endpoint: string;
  notes: string | null;
  isActive: boolean;
  /** How many catalogue products currently point at this supplier. */
  productCount: number;
  createdAt: string;
}

const toSupplierView = (s: typeof suppliers.$inferSelect, productCount: number): AdminSupplierView => ({
  id: s.id,
  name: s.name,
  channel: s.channel,
  contactEmail: s.contactEmail,
  endpoint: s.endpoint,
  notes: s.notes,
  isActive: s.isActive,
  productCount,
  createdAt: s.createdAt.toISOString(),
});

export const listSuppliers = async (filters: AdminSupplierListQuery) => {
  const where = [];
  if (filters.status === "active") where.push(eq(suppliers.isActive, true));
  if (filters.status === "inactive") where.push(eq(suppliers.isActive, false));
  if (filters.search) {
    const term = likeContains(filters.search);
    where.push(sql`(${suppliers.name} LIKE ${term} ESCAPE ${LIKE_ESCAPE} OR ${suppliers.contactEmail} LIKE ${term} ESCAPE ${LIKE_ESCAPE})`);
  }
  const w = where.length > 0 ? and(...where) : undefined;

  const rows = await db.select().from(suppliers).where(w).orderBy(asc(suppliers.name));

  const countRows = await db
    .select({ supplierId: products.supplierId, count: count() })
    .from(products)
    .where(isNotNull(products.supplierId))
    .groupBy(products.supplierId);
  const counts = new Map(countRows.map((r) => [r.supplierId as string, n(r.count)]));

  return { suppliers: rows.map((s) => toSupplierView(s, counts.get(s.id) ?? 0)) };
};

export const createSupplier = async (input: SupplierCreateInput): Promise<AdminSupplierView> => {
  const id = newId();
  try {
    await db.insert(suppliers).values({
      id,
      name: input.name,
      contactEmail: input.contactEmail,
      channel: input.channel,
      endpoint: input.endpoint,
      endpointSecret: input.endpointSecret ?? null,
      notes: input.notes ?? null,
      isActive: input.isActive,
    });
  } catch (error) {
    rethrowDuplicate(error, "A supplier with those details already exists.");
  }
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  return toSupplierView(row!, 0);
};

export const updateSupplier = async (id: string, patch: SupplierUpdateInput): Promise<AdminSupplierView> => {
  const [existing] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (!existing) throw notFound("Supplier not found.");

  const set: Partial<typeof suppliers.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.contactEmail !== undefined) set.contactEmail = patch.contactEmail;
  if (patch.channel !== undefined) set.channel = patch.channel;
  if (patch.endpoint !== undefined) set.endpoint = patch.endpoint;
  if (patch.endpointSecret !== undefined) set.endpointSecret = patch.endpointSecret || null;
  if (patch.notes !== undefined) set.notes = patch.notes || null;
  if (patch.isActive !== undefined) set.isActive = patch.isActive;

  if (Object.keys(set).length > 0) {
    await db.update(suppliers).set(set).where(eq(suppliers.id, id));
  }

  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  const [countRow] = await db
    .select({ count: count() })
    .from(products)
    .where(eq(products.supplierId, id));
  return toSupplierView(row!, n(countRow?.count));
};

/**
 * Retire a supplier.
 *
 * A hard delete would be rejected by the RESTRICT foreign key on
 * `order_fulfillments` for any supplier that still owes a shipment, which is
 * the exact case an operator needs to see. Deactivating keeps them visible in
 * the console but stops them being assigned new work.
 */
export const archiveSupplier = async (id: string): Promise<AdminSupplierView> => {
  const [existing] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (!existing) throw notFound("Supplier not found.");
  await db.update(suppliers).set({ isActive: false }).where(eq(suppliers.id, id));
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  const [countRow] = await db.select({ count: count() }).from(products).where(eq(products.supplierId, id));
  return toSupplierView(row!, n(countRow?.count));
};

// ── Customers ──────────────────────────────────────────────────────────────

export interface AdminCustomerView {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** Charged (paid or refunded) orders. */
  orderCount: number;
  /** Net revenue across those orders, after refunds. */
  lifetimeValueCents: number;
  createdAt: string;
  lastSeenAt: string | null;
}

export const listCustomers = async (filters: AdminCustomerListQuery) => {
  const where = [];
  if (filters.role !== "all") where.push(eq(users.role, filters.role));
  if (filters.search) {
    const term = likeContains(filters.search);
    where.push(sql`(${users.name} LIKE ${term} ESCAPE ${LIKE_ESCAPE} OR ${users.email} LIKE ${term} ESCAPE ${LIKE_ESCAPE})`);
  }
  const w = where.length > 0 ? and(...where) : undefined;

  const [countRow] = await db.select({ total: count() }).from(users).where(w);
  const total = n(countRow?.total);

  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(w)
    .orderBy(desc(users.createdAt))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  const ids = rows.map((r) => r.id);
  const stats = new Map<string, { orderCount: number; ltv: number }>();
  if (ids.length > 0) {
    const agg = await db
      .select({
        userId: orders.userId,
        orderCount: count(),
        ltv: sql<number>`COALESCE(SUM(${orders.totalCents} - ${orders.refundedCents}), 0)`,
      })
      .from(orders)
      .where(and(inArray(orders.userId, ids), inArray(orders.status, CHARGED)))
      .groupBy(orders.userId);
    for (const row of agg) {
      if (row.userId) stats.set(row.userId, { orderCount: n(row.orderCount), ltv: n(row.ltv) });
    }
  }

  return {
    customers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      orderCount: stats.get(r.id)?.orderCount ?? 0,
      lifetimeValueCents: stats.get(r.id)?.ltv ?? 0,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastLoginAt?.toISOString() ?? null,
    })),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
  };
};

// ── Analytics ──────────────────────────────────────────────────────────────

const RANGE_DAYS: Record<AnalyticsRange, number> = { "7d": 7, "30d": 30, "90d": 90, "12m": 365 };

export interface AnalyticsSeriesPoint {
  /** "YYYY-MM-DD" for day ranges, "YYYY-MM" for the year range. */
  label: string;
  revenueCents: number;
  orderCount: number;
}

export interface AnalyticsSummary {
  range: { from: string; to: string };
  orders: { count: number; paidCount: number; pendingCount: number; refundedCount: number };
  revenue: { grossCents: number; refundedCents: number; netCents: number; averageOrderCents: number; currency: string };
  customers: { total: number; newInRange: number };
  catalogue: { activeProducts: number; outOfStock: number };
  topProducts: { productId: string; name: string; slug: string; unitsSold: number; revenueCents: number }[];
  revenueByCategory: { category: string; revenueCents: number }[];
  fulfillments: Record<FulfillmentStatus, number>;
  series: AnalyticsSeriesPoint[];
}

/**
 * Build a dense, ordered list of bucket labels covering the window.
 *
 * Filling the gaps matters for the chart: a sparse series makes a quiet Tuesday
 * render as a straight line from Monday to Wednesday, which reads as "no sales"
 * when it should read as "zero sales".
 */
const bucketLabels = (from: Date, to: Date, monthly: boolean): string[] => {
  const labels: string[] = [];
  const cursor = new Date(from);
  if (monthly) cursor.setUTCDate(1);
  // Bounded so a malformed range can never spin here.
  while (cursor <= to && labels.length < 400) {
    labels.push(monthly ? cursor.toISOString().slice(0, 7) : cursor.toISOString().slice(0, 10));
    if (monthly) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return labels;
};

/**
 * Dashboard analytics for a relative window.
 *
 * Revenue figures and the chart series are computed from the *same* fetched
 * order rows, so the headline totals can never disagree with the bars beneath
 * them. Everything else (customers, catalogue, top products, fulfilments) is a
 * dedicated aggregate query.
 */
export const getAnalytics = async (range: AnalyticsRange): Promise<AnalyticsSummary> => {
  const to = new Date();
  const from = new Date(to.getTime() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
  const monthly = range === "12m";

  const orderRows = await db
    .select({ totalCents: orders.totalCents, refundedCents: orders.refundedCents, status: orders.status, createdAt: orders.createdAt })
    .from(orders)
    .where(and(gte(orders.createdAt, from), lte(orders.createdAt, to)));

  let grossCents = 0;
  let refundedCents = 0;
  let paidCount = 0;
  let pendingCount = 0;
  let refundedCount = 0;
  const bucketTotals = new Map<string, { revenueCents: number; orderCount: number }>();

  for (const row of orderRows) {
    const isCharged = row.status === "paid" || row.status === "refunded";
    if (row.status === "paid") paidCount += 1;
    if (row.status === "refunded") refundedCount += 1;
    if (row.status === "pending_payment") pendingCount += 1;
    if (!isCharged) continue;

    grossCents += n(row.totalCents);
    refundedCents += n(row.refundedCents);

    const label = monthly ? row.createdAt.toISOString().slice(0, 7) : row.createdAt.toISOString().slice(0, 10);
    const bucket = bucketTotals.get(label) ?? { revenueCents: 0, orderCount: 0 };
    bucket.revenueCents += netCents(n(row.totalCents), n(row.refundedCents));
    bucket.orderCount += 1;
    bucketTotals.set(label, bucket);
  }

  const netCentsTotal = grossCents - refundedCents;
  const chargedCount = paidCount + refundedCount;

  const [custRow] = await db
    .select({
      total: count(),
      newInRange: sql<number>`COALESCE(SUM(CASE WHEN ${users.createdAt} >= ${from} THEN 1 ELSE 0 END), 0)`,
    })
    .from(users)
    .where(eq(users.role, "customer"));

  const [activeRow] = await db.select({ active: count() }).from(products).where(eq(products.isActive, true));
  const [oosRow] = await db
    .select({ outOfStock: count() })
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        sql`NOT EXISTS (
          SELECT 1 FROM ${productVariants} pv
          WHERE pv.product_id = ${products.id} AND pv.is_active = 1 AND (pv.is_backorderable = 1 OR pv.stock_on_hand > 0)
        )`,
      ),
    );

  const topProductRows = await db
    .select({
      productId: orderItems.productId,
      name: orderItems.productName,
      slug: orderItems.productSlug,
      unitsSold: sql<number>`COALESCE(SUM(${orderItems.quantity}), 0)`,
      revenueCents: sql<number>`COALESCE(SUM(${orderItems.lineTotalCents}), 0)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(inArray(orders.status, CHARGED), gte(orders.createdAt, from), lte(orders.createdAt, to)))
    .groupBy(orderItems.productId, orderItems.productName, orderItems.productSlug)
    .orderBy(desc(sql`SUM(${orderItems.lineTotalCents})`))
    .limit(10);

  const categoryRows = await db
    .select({ category: products.category, revenueCents: sql<number>`COALESCE(SUM(${orderItems.lineTotalCents}), 0)` })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(products, eq(orderItems.productId, products.id))
    .where(and(inArray(orders.status, CHARGED), gte(orders.createdAt, from), lte(orders.createdAt, to)))
    .groupBy(products.category)
    .orderBy(desc(sql`SUM(${orderItems.lineTotalCents})`));

  const fulfillmentRows = await db
    .select({ status: orderFulfillments.status, count: count() })
    .from(orderFulfillments)
    .groupBy(orderFulfillments.status);
  const fulfillments = Object.fromEntries(FULFILLMENT_STATUSES.map((s) => [s, 0])) as Record<FulfillmentStatus, number>;
  for (const row of fulfillmentRows) fulfillments[row.status] = n(row.count);

  const series = bucketLabels(from, to, monthly).map((label) => {
    const bucket = bucketTotals.get(label);
    return { label, revenueCents: bucket?.revenueCents ?? 0, orderCount: bucket?.orderCount ?? 0 };
  });

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    orders: { count: orderRows.length, paidCount, pendingCount, refundedCount },
    revenue: {
      grossCents,
      refundedCents,
      netCents: netCentsTotal,
      averageOrderCents: chargedCount > 0 ? Math.round(grossCents / chargedCount) : 0,
      currency: env.storeCurrency,
    },
    customers: { total: n(custRow?.total), newInRange: n(custRow?.newInRange) },
    catalogue: { activeProducts: n(activeRow?.active), outOfStock: n(oosRow?.outOfStock) },
    topProducts: topProductRows.map((r) => ({
      productId: r.productId ?? "",
      name: r.name,
      slug: r.slug,
      unitsSold: n(r.unitsSold),
      revenueCents: n(r.revenueCents),
    })),
    revenueByCategory: categoryRows.map((r) => ({ category: r.category, revenueCents: n(r.revenueCents) })),
    fulfillments,
    series,
  };
};
