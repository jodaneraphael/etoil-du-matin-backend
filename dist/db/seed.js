import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, db } from "./client.js";
import { env } from "../env.js";
import { hashPassword } from "../lib/password.js";
import { newId } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { productVariants, products, suppliers, users } from "./schema.js";
import { orderFulfillments, orderItems, orders, payments, } from "./schema.js";
/**
 * Development/demo seed.
 *
 * Idempotent by natural key rather than by truncating: every insert is an
 * "insert if absent" keyed on the slug, email, or SKU. That matters because
 * seeding a database that already holds real orders must never delete anything.
 * The one exception is the demo account, whose password hash is refreshed on
 * every run so a local login works after the seed password changes.
 *
 * Refuses to run in production. A seed script that quietly creates a known
 * admin password on a production database is a serious liability, so the check
 * is a hard failure rather than a warning.
 */
if (env.nodeEnv === "production") {
    logger.fatal("refusing to seed a production database");
    process.exit(1);
}
const DEMO_ORDERS = [
    {
        orderNumber: "EDM-DEMO1001",
        status: "paid",
        fulfillmentStatus: "delivered",
        assignSupplier: true,
        paymentStatus: "succeeded",
        trackingNumber: "6A123456789FR",
        trackingCarrier: "La Poste",
        placedAtIso: "2026-08-14T09:24:00.000Z",
    },
    {
        orderNumber: "EDM-DEMO1002",
        status: "paid",
        fulfillmentStatus: "pending",
        // The unsourced slice an operator has to assign before forwarding.
        assignSupplier: false,
        paymentStatus: "succeeded",
        placedAtIso: "2026-09-02T15:47:00.000Z",
    },
];
const SEED = {
    supplierName: "Nordic Wholesale Co.",
    supplierWebhookName: "Maison Direct",
    adminEmail: "admin@etoil-du-matin.test",
    adminPassword: "ChangeMe!2024",
    customerEmail: "client@etoil-du-matin.test",
    customerPassword: "Client!2024",
};
const CATALOGUE = [
    {
        slug: "aurora-noise-cancelling-headphones",
        name: "Aurora Noise-Cancelling Headphones",
        brand: "Aurora Audio",
        priceCents: 24900,
        compareAtCents: 31900,
        category: "Electronics",
        gender: "unisex",
        description: "Hybrid active noise cancelling with 40mm drivers and a 38-hour battery. Multipoint pairing keeps a laptop and phone connected at once.",
        badge: "Best Seller",
        imageUrl: "https://images.etoil-du-matin.test/products/aurora-headphones.jpg",
        specs: [
            { label: "Driver", value: "40 mm dynamic" },
            { label: "Battery", value: "38 h (ANC on)" },
            { label: "Bluetooth", value: "5.3, multipoint" },
            { label: "Weight", value: "254 g" },
        ],
        variants: [
            { sku: "AUR-BLK", color: "Midnight", hex: "#1b1d23", stock: 24 },
            { sku: "AUR-SND", color: "Sand", hex: "#d8c7a8", stock: 11 },
            { sku: "AUR-FRN", color: "Fern", hex: "#5c7a63", stock: 0 },
        ],
    },
    {
        slug: "meridian-leather-weekender",
        name: "Meridian Leather Weekender",
        brand: "Meridian Goods",
        priceCents: 38500,
        category: "Accessories",
        gender: "unisex",
        subcategory: "accessories",
        description: "Full-grain vegetable-tanned leather duffel that softens with use. Brass hardware, cotton twill lining, and a shoe compartment.",
        imageUrl: "https://images.etoil-du-matin.test/products/meridian-weekender.jpg",
        specs: [
            { label: "Material", value: "Full-grain vegetable-tanned leather" },
            { label: "Dimensions", value: "55 × 30 × 28 cm" },
            { label: "Capacity", value: "38 L" },
            { label: "Hardware", value: "Solid brass" },
        ],
        variants: [
            { sku: "MER-TAN", color: "Tan", hex: "#b07d42", stock: 7 },
            { sku: "MER-BRN", color: "Espresso", hex: "#3f2a20", stock: 4 },
        ],
    },
    {
        slug: "lumen-desk-lamp",
        name: "Lumen Desk Lamp",
        brand: "Lumen Studio",
        priceCents: 8900,
        compareAtCents: 11500,
        category: "Home & Living",
        description: "Adjustable aluminium task lamp with a stepless dimmer and a warm-to-cool colour temperature range.",
        badge: "Sale",
        imageUrl: "https://images.etoil-du-matin.test/products/lumen-lamp.jpg",
        specs: [
            { label: "Colour temp", value: "2700 K – 6500 K" },
            { label: "Output", value: "900 lm" },
            { label: "Base", value: "Weighted aluminium" },
        ],
        variants: [{ sku: "LUM-WHT", color: "Chalk", hex: "#f2f0eb", stock: 40 }],
    },
    {
        slug: "celine-mille-feuille-perfume",
        name: "Céline Mille Feuille Eau de Parfum",
        brand: "Céline Parfums",
        priceCents: 16500,
        category: "Beauty",
        gender: "women",
        subcategory: "perfumes",
        description: "A warm, sweet floral built on iris, amber, and vanilla. 100ml spray, produced and filled in France.",
        imageUrl: "https://images.etoil-du-matin.test/products/mille-feuille.jpg",
        specs: [
            { label: "Concentration", value: "Eau de parfum" },
            { label: "Volume", value: "100 ml" },
            { label: "Notes", value: "Iris, amber, vanilla" },
        ],
        variants: [{ sku: "CMF-100", size: "100 ml", stock: 15 }],
    },
    {
        slug: "atelier-wool-overshirt",
        name: "Atelier Wool Overshirt",
        brand: "Atelier Nord",
        priceCents: 19500,
        category: "Fashion",
        gender: "unisex",
        subcategory: "clothing",
        description: "Heavyweight Italian wool overshirt with a chore-jacket cut, corozo buttons, and a brushed cotton lining.",
        badge: "New",
        imageUrl: "https://images.etoil-du-matin.test/products/atelier-overshirt.jpg",
        specs: [
            { label: "Fabric", value: "100% Italian wool, 480 gsm" },
            { label: "Buttons", value: "Corozo" },
            { label: "Fit", value: "Relaxed" },
        ],
        variants: [
            { sku: "ATL-NAVY-M", color: "Navy", hex: "#1f2a44", size: "M", stock: 9 },
            { sku: "ATL-NAVY-L", color: "Navy", hex: "#1f2a44", size: "L", stock: 6 },
            { sku: "ATL-OLV-S", color: "Olive", hex: "#4b5320", size: "S", stock: 2 },
        ],
    },
    {
        slug: "meridian-signet-ring",
        name: "Meridian Signet Ring",
        brand: "Meridian Goods",
        priceCents: 16500,
        category: "Accessories",
        gender: "men",
        subcategory: "jewelry",
        description: "Solid sterling silver signet with a flat face left ready for engraving. Hand-finished in a small Birmingham workshop.",
        imageUrl: "https://images.etoil-du-matin.test/products/meridian-signet.jpg",
        specs: [
            { label: "Metal", value: "925 sterling silver" },
            { label: "Band width", value: "4 mm" },
            { label: "Engraving", value: "Included, 6 characters" },
        ],
        variants: [
            { sku: "SIG-SLV-9", size: "9", stock: 8 },
            { sku: "SIG-SLV-10", size: "10", stock: 12 },
            { sku: "SIG-SLV-11", size: "11", stock: 0 },
        ],
    },
    {
        slug: "meridian-leather-cardholder",
        name: "Meridian Leather Cardholder",
        brand: "Meridian Goods",
        priceCents: 7800,
        compareAtCents: 9800,
        category: "Accessories",
        gender: "men",
        subcategory: "accessories",
        description: "Four slots in vegetable-tanned leather, slim enough for a front pocket. Edges are burnished by hand.",
        badge: "Sale",
        imageUrl: "https://images.etoil-du-matin.test/products/meridian-cardholder.jpg",
        specs: [
            { label: "Material", value: "Vegetable-tanned leather" },
            { label: "Slots", value: "4" },
            { label: "Profile", value: "8 mm slim" },
        ],
        variants: [
            { sku: "CRD-ESP", color: "Espresso", hex: "#3f2a20", stock: 34 },
            { sku: "CRD-TAN", color: "Tan", hex: "#b07d42", stock: 21 },
        ],
    },
    {
        slug: "atelier-oxford-derby",
        name: "Atelier Oxford Derby",
        brand: "Atelier Nord",
        priceCents: 24500,
        category: "Fashion",
        gender: "men",
        subcategory: "shoes",
        description: "Hand-lasted derby in Italian calfskin on a leather sole, Goodyear welted so it can be resoled.",
        badge: "Best Seller",
        imageUrl: "https://images.etoil-du-matin.test/products/atelier-derby.jpg",
        specs: [
            { label: "Upper", value: "Italian calfskin" },
            { label: "Construction", value: "Goodyear welted" },
            { label: "Sole", value: "Leather with rubber insert" },
        ],
        variants: [
            { sku: "DRB-BRN-8", color: "Chestnut", hex: "#6b4423", size: "8", stock: 7 },
            { sku: "DRB-BRN-9", color: "Chestnut", hex: "#6b4423", size: "9", stock: 11 },
            { sku: "DRB-BRN-10", color: "Chestnut", hex: "#6b4423", size: "10", stock: 4 },
            { sku: "DRB-DRK-9", color: "Dark Brown", hex: "#3b2a1d", size: "9", stock: 0 },
        ],
    },
    {
        slug: "atelier-selvedge-denim",
        name: "Atelier Selvedge Denim",
        brand: "Atelier Nord",
        priceCents: 17800,
        category: "Fashion",
        gender: "men",
        subcategory: "clothing",
        description: "Japanese selvedge denim in a straight leg, rope-dyed and sanforised so it will not shrink out of shape.",
        imageUrl: "https://images.etoil-du-matin.test/products/atelier-denim.jpg",
        specs: [
            { label: "Fabric", value: "14 oz Japanese selvedge" },
            { label: "Dye", value: "Rope-dyed indigo" },
            { label: "Fit", value: "Straight" },
        ],
        variants: [
            { sku: "DNM-IND-30", color: "Raw Indigo", hex: "#2c3e63", size: "30", stock: 14 },
            { sku: "DNM-IND-32", color: "Raw Indigo", hex: "#2c3e63", size: "32", stock: 19 },
            { sku: "DNM-IND-34", color: "Raw Indigo", hex: "#2c3e63", size: "34", stock: 6 },
        ],
    },
    {
        slug: "boise-midnight-oud",
        name: "Boisé Midnight Oud",
        brand: "Boisé",
        priceCents: 14500,
        category: "Beauty",
        gender: "men",
        subcategory: "perfumes",
        description: "A dense oud built on leather and amber, distilled in Grasse. Wears close to the skin and lasts a full day.",
        badge: "Best Seller",
        imageUrl: "https://images.etoil-du-matin.test/products/boise-oud.jpg",
        specs: [
            { label: "Concentration", value: "Eau de parfum" },
            { label: "Volume", value: "75 ml" },
            { label: "Notes", value: "Oud, leather, amber" },
        ],
        variants: [
            { sku: "OUD-75", size: "75 ml", stock: 22 },
            { sku: "OUD-150", size: "150 ml", stock: 5 },
        ],
    },
    {
        slug: "boise-cedar-vetiver",
        name: "Boisé Cedar & Vetiver",
        brand: "Boisé",
        priceCents: 9800,
        category: "Beauty",
        gender: "men",
        subcategory: "perfumes",
        description: "Clean and woody, built for daily wear. Vetiver from Haiti over a cedar base, with a grapefruit opening.",
        imageUrl: "https://images.etoil-du-matin.test/products/boise-cedar.jpg",
        specs: [
            { label: "Concentration", value: "Eau de toilette" },
            { label: "Volume", value: "100 ml" },
            { label: "Notes", value: "Grapefruit, cedar, vetiver" },
        ],
        variants: [{ sku: "CV-100", size: "100 ml", stock: 38 }],
    },
    {
        slug: "atelier-ivory-groom-tux",
        name: "Atelier Ivory Groom Tux",
        brand: "Atelier Nord",
        priceCents: 89900,
        category: "Fashion",
        gender: "men",
        subcategory: "marriage",
        description: "Peak-lapel tuxedo in ivory wool with a satin shawl collar, cut close through the chest.",
        badge: "Limited",
        imageUrl: "https://images.etoil-du-matin.test/products/atelier-tux.jpg",
        specs: [
            { label: "Fabric", value: "Ivory wool barathea" },
            { label: "Lapel", value: "Satin shawl" },
            { label: "Fit", value: "Slim" },
        ],
        variants: [
            { sku: "TUX-38", size: "38", stock: 3 },
            { sku: "TUX-40", size: "40", stock: 5 },
            { sku: "TUX-42", size: "42", stock: 0 },
        ],
    },
    {
        slug: "aurea-pavé-wedding-band",
        name: "Auréa Pavé Wedding Band",
        brand: "Auréa",
        priceCents: 89900,
        category: "Accessories",
        gender: "men",
        subcategory: "marriage",
        description: "18k white gold band with a pavé set of round brilliants, sized and finished to order.",
        imageUrl: "https://images.etoil-du-matin.test/products/aurea-pave-men.jpg",
        specs: [
            { label: "Metal", value: "18k white gold" },
            { label: "Stones", value: "0.42 ct total, VS" },
            { label: "Width", value: "3 mm" },
        ],
        variants: [
            { sku: "WBM-9", size: "9", stock: 4 },
            { sku: "WBM-10", size: "10", stock: 6 },
        ],
    },
    {
        slug: "atelier-silk-ballet-flats",
        name: "Atelier Silk Ballet Flats",
        brand: "Atelier Nord",
        priceCents: 15800,
        category: "Fashion",
        gender: "women",
        subcategory: "shoes",
        description: "Whisper-soft silk upper on a flexible leather sole, with a grosgrain trim at the throat.",
        badge: "New",
        imageUrl: "https://images.etoil-du-matin.test/products/atelier-flats.jpg",
        specs: [
            { label: "Upper", value: "Mulberry silk" },
            { label: "Sole", value: "Leather, flexible" },
            { label: "Lining", value: "Leather" },
        ],
        variants: [
            { sku: "FLT-BLK-38", color: "Black", hex: "#1a1a1a", size: "38", stock: 12 },
            { sku: "FLT-BLK-39", color: "Black", hex: "#1a1a1a", size: "39", stock: 16 },
            { sku: "FLT-CHK-38", color: "Chalk", hex: "#f2f0eb", size: "38", stock: 3 },
        ],
    },
    {
        slug: "atelier-silk-slip-dress",
        name: "Atelier Silk Slip Dress",
        brand: "Atelier Nord",
        priceCents: 24500,
        category: "Fashion",
        gender: "women",
        subcategory: "clothing",
        description: "Bias-cut mulberry slip in champagne, cut on the true bias so it skims rather than clings.",
        badge: "Best Seller",
        imageUrl: "https://images.etoil-du-matin.test/products/atelier-slip.jpg",
        specs: [
            { label: "Fabric", value: "19mm mulberry silk" },
            { label: "Cut", value: "True bias" },
            { label: "Straps", value: "Adjustable" },
        ],
        variants: [
            { sku: "SLP-CHM-S", color: "Champagne", hex: "#e8d5b5", size: "S", stock: 9 },
            { sku: "SLP-CHM-M", color: "Champagne", hex: "#e8d5b5", size: "M", stock: 14 },
            { sku: "SLP-CHM-L", color: "Champagne", hex: "#e8d5b5", size: "L", stock: 2 },
        ],
    },
    {
        slug: "meridian-milano-tote",
        name: "Meridian Milano Tote",
        brand: "Meridian Goods",
        priceCents: 38900,
        category: "Accessories",
        gender: "women",
        subcategory: "handbags",
        description: "Structured tote in smooth Italian calfskin with a detachable pouch and a rolled top handle.",
        badge: "Best Seller",
        imageUrl: "https://images.etoil-du-matin.test/products/meridian-tote.jpg",
        specs: [
            { label: "Material", value: "Smooth Italian calfskin" },
            { label: "Dimensions", value: "34 × 28 × 14 cm" },
            { label: "Hardware", value: "Palladium-plated" },
        ],
        variants: [
            { sku: "TOT-TAN", color: "Tan", hex: "#b07d42", stock: 6 },
            { sku: "TOT-BLK", color: "Black", hex: "#1a1a1a", stock: 11 },
        ],
    },
    {
        slug: "meridian-mini-bucket-bag",
        name: "Meridian Mini Bucket Bag",
        brand: "Meridian Goods",
        priceCents: 19800,
        compareAtCents: 24500,
        category: "Accessories",
        gender: "women",
        subcategory: "handbags",
        description: "Drawstring mini in soft nappa with a removable cord, small enough to sit in the hand rather than the shoulder.",
        badge: "Sale",
        imageUrl: "https://images.etoil-du-matin.test/products/meridian-bucket.jpg",
        specs: [
            { label: "Material", value: "Nappa leather" },
            { label: "Closure", value: "Drawstring" },
            { label: "Dimensions", value: "18 × 20 × 12 cm" },
        ],
        variants: [
            { sku: "BKT-SND", color: "Sand", hex: "#d8c7a8", stock: 18 },
            { sku: "BKT-BRN", color: "Espresso", hex: "#3f2a20", stock: 4 },
        ],
    },
    {
        slug: "aurea-fresh-pearl-drops",
        name: "Auréa Fresh Pearl Drops",
        brand: "Auréa",
        priceCents: 19800,
        category: "Accessories",
        gender: "women",
        subcategory: "jewelry",
        description: "Baroque freshwater pearls suspended from 14k gold-vermeil posts, each one naturally irregular.",
        badge: "Best Seller",
        imageUrl: "https://images.etoil-du-matin.test/products/aurea-pearls.jpg",
        specs: [
            { label: "Pearl", value: "7–8 mm freshwater" },
            { label: "Post", value: "14k gold vermeil" },
            { label: "Length", value: "28 mm" },
        ],
        variants: [{ sku: "PRL-GLD", color: "Gold", hex: "#c9a227", stock: 15 }],
    },
    {
        slug: "aurea-diamond-tennis-bracelet",
        name: "Auréa Diamond Tennis Bracelet",
        brand: "Auréa",
        priceCents: 129900,
        category: "Accessories",
        gender: "women",
        subcategory: "jewelry",
        description: "Graduated line of round brilliants totalling 3ct, set in white gold on a hidden clasp.",
        badge: "Limited",
        imageUrl: "https://images.etoil-du-matin.test/products/aurea-tennis.jpg",
        specs: [
            { label: "Metal", value: "18k white gold" },
            { label: "Stones", value: "3.0 ct total, VS" },
            { label: "Length", value: "17 cm" },
        ],
        variants: [{ sku: "TEN-WG", color: "White Gold", hex: "#d4d4d8", stock: 2 }],
    },
    {
        slug: "aurea-cat-eye-sunglasses",
        name: "Auréa Cat-Eye Sunglasses",
        brand: "Auréa",
        priceCents: 14500,
        category: "Accessories",
        gender: "women",
        subcategory: "accessories",
        description: "Italian acetate cat-eye with gradient lenses and a gold-tone temple detail.",
        badge: "New",
        imageUrl: "https://images.etoil-du-matin.test/products/aurea-cateye.jpg",
        specs: [
            { label: "Frame", value: "Italian acetate" },
            { label: "Lens", value: "Gradient, UV400" },
            { label: "Fit", value: "Medium" },
        ],
        variants: [
            { sku: "CEY-HNY", color: "Honey Tortoise", hex: "#a9743c", stock: 20 },
            { sku: "CEY-BLK", color: "Black", hex: "#1a1a1a", stock: 25 },
        ],
    },
    {
        slug: "boise-rose-attar",
        name: "Boisé Rose Attar",
        brand: "Boisé",
        priceCents: 16800,
        category: "Beauty",
        gender: "women",
        subcategory: "perfumes",
        description: "Rose absolute lifted with iris and warm musk. Heavier than a typical floral, and closer to the skin.",
        badge: "Best Seller",
        imageUrl: "https://images.etoil-du-matin.test/products/boise-rose.jpg",
        specs: [
            { label: "Concentration", value: "Eau de parfum" },
            { label: "Volume", value: "50 ml" },
            { label: "Notes", value: "Rose absolute, iris, musk" },
        ],
        variants: [
            { sku: "ROS-50", size: "50 ml", stock: 14 },
            { sku: "ROS-100", size: "100 ml", stock: 8 },
        ],
    },
    {
        slug: "lila-hydra-radiance-cream",
        name: "Lila Hydra Radiance Cream",
        brand: "Lila Beauty",
        priceCents: 7800,
        category: "Beauty",
        gender: "women",
        subcategory: "beauty",
        description: "Rich ceramide moisturiser with squalane, finished with a soft satin sheen rather than a shine.",
        badge: "Best Seller",
        imageUrl: "https://images.etoil-du-matin.test/products/lila-hydra.jpg",
        specs: [
            { label: "Size", value: "50 ml" },
            { label: "Key actives", value: "Ceramides, squalane" },
            { label: "Finish", value: "Satin" },
        ],
        variants: [{ sku: "HYD-50", size: "50 ml", stock: 44 }],
    },
    {
        slug: "lila-retinol-renewal-night",
        name: "Lila Retinol Renewal Night",
        brand: "Lila Beauty",
        priceCents: 8800,
        category: "Beauty",
        gender: "women",
        subcategory: "beauty",
        description: "Encapsulated retinol with peptides, buffered so it works without the usual flaking.",
        badge: "New",
        imageUrl: "https://images.etoil-du-matin.test/products/lila-retinol.jpg",
        specs: [
            { label: "Size", value: "30 ml" },
            { label: "Key actives", value: "0.3% encapsulated retinol" },
            { label: "Use", value: "PM, twice weekly to start" },
        ],
        variants: [{ sku: "RET-30", size: "30 ml", stock: 26 }],
    },
    {
        slug: "atelier-a-line-wedding-gown",
        name: "Atelier A-Line Wedding Gown",
        brand: "Atelier Nord",
        priceCents: 189900,
        category: "Fashion",
        gender: "women",
        subcategory: "marriage",
        description: "Silk mikado A-line with a chapel train, boned bodice, and hand-rolled hem.",
        badge: "Limited",
        imageUrl: "https://images.etoil-du-matin.test/products/atelier-gown.jpg",
        specs: [
            { label: "Fabric", value: "Silk mikado" },
            { label: "Train", value: "Chapel" },
            { label: "Construction", value: "Boned bodice" },
        ],
        variants: [
            { sku: "GWN-36", size: "36", stock: 2 },
            { sku: "GWN-38", size: "38", stock: 3 },
            { sku: "GWN-40", size: "40", stock: 0 },
        ],
    },
    {
        slug: "aurea-bridal-veil",
        name: "Auréa Cathedral Bridal Veil",
        brand: "Auréa",
        priceCents: 28900,
        category: "Accessories",
        gender: "women",
        subcategory: "marriage",
        description: "Silk tulle veil with a hand-rolled edge and a comb back, cut to cathedral length.",
        badge: "Best Seller",
        imageUrl: "https://images.etoil-du-matin.test/products/aurea-veil.jpg",
        specs: [
            { label: "Fabric", value: "Silk tulle" },
            { label: "Length", value: "Cathedral, 240 cm" },
            { label: "Edge", value: "Hand-rolled" },
        ],
        variants: [
            { sku: "VEL-IV", color: "Ivory", hex: "#f7f2e8", stock: 9 },
            { sku: "VEL-BLU", color: "Blush", hex: "#e8c4c4", stock: 5 },
        ],
    },
];
/**
 * Insert a row keyed on a natural key, reusing the existing id when present.
 *
 * `onDuplicateKeyUpdate` cannot update a primary key, so the id has to be read
 * first. That read is what makes the seed idempotent without fabricating ids.
 *
 * `keyColumn` must be the real Column object, not its name: passing a bare
 * string to `eq()` produces a lookup that does not reliably bind to the column,
 * and because `suppliers.name` carries only a non-unique index there is no
 * unique constraint to catch the resulting duplicate. It fails silently and
 * quietly doubles the supplier rows on every reseed.
 */
const upsertByNaturalKey = async (table, keyColumn, keyValue, build) => {
    const existing = await db
        .select({ id: table.id })
        .from(table)
        .where(eq(keyColumn, keyValue))
        .limit(1);
    const id = existing[0]?.id ?? newId();
    await db
        .insert(table)
        .values(build(id))
        .onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
    return id;
};
/** Seeds suppliers; returns the id to attach products to. */
const seedSuppliers = async () => {
    const supplierId = await upsertByNaturalKey(suppliers, suppliers.name, SEED.supplierName, (id) => ({
        id,
        name: SEED.supplierName,
        contactEmail: "orders@nordic-wholesale.test",
        channel: "email",
        endpoint: "mailto:orders@nordic-wholesale.test",
        notes: "Primary EU distributor. Ships in 2-3 business days.",
    }));
    await upsertByNaturalKey(suppliers, suppliers.name, SEED.supplierWebhookName, (id) => ({
        id,
        name: SEED.supplierWebhookName,
        contactEmail: "fulfilment@maison-direct.test",
        channel: "webhook",
        endpoint: "https://sandbox.maison-direct.test/hooks/orders",
        endpointSecret: "sandbox-only-secret-not-a-real-credential",
        notes: "API supplier. Sandbox endpoint only - never receives live traffic.",
    }));
    return supplierId;
};
const seedUsers = async () => {
    const rows = [
        {
            email: SEED.adminEmail,
            passwordHash: await hashPassword(SEED.adminPassword),
            name: "Store Administrator",
            role: "admin",
            emailVerifiedAt: new Date(),
        },
        {
            email: SEED.customerEmail,
            passwordHash: await hashPassword(SEED.customerPassword),
            name: "Camille Demo",
            role: "customer",
            emailVerifiedAt: new Date(),
        },
    ];
    for (const row of rows) {
        const existing = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, row.email))
            .limit(1);
        // The password hash *is* overwritten, which is the point of a demo account:
        // the documented password must work after any reseed. It is Argon2id, so
        // nothing recoverable is stored regardless.
        await db
            .insert(users)
            .values({ id: existing[0]?.id ?? newId(), ...row })
            .onDuplicateKeyUpdate({
            set: {
                passwordHash: row.passwordHash,
                name: row.name,
                role: row.role,
                updatedAt: new Date(),
            },
        });
    }
};
const seedCatalogue = async (supplierId) => {
    for (const item of CATALOGUE) {
        const productId = await upsertByNaturalKey(products, products.slug, item.slug, (id) => ({
            id,
            slug: item.slug,
            name: item.name,
            brand: item.brand,
            unitPriceCents: item.priceCents,
            compareAtCents: item.compareAtCents ?? null,
            imageUrl: item.imageUrl,
            gallery: [item.imageUrl],
            category: item.category,
            gender: item.gender ?? null,
            subcategory: item.subcategory ?? null,
            description: item.description,
            specs: item.specs,
            badge: item.badge ?? null,
            supplierId,
        }));
        for (const variant of item.variants) {
            const existing = await db
                .select({ id: productVariants.id })
                .from(productVariants)
                .where(eq(productVariants.sku, variant.sku))
                .limit(1);
            // `stockOnHand` is intentionally left alone on update: reseeding must never
            // resurrect inventory that has already been sold.
            await db
                .insert(productVariants)
                .values({
                id: existing[0]?.id ?? newId(),
                productId,
                sku: variant.sku,
                colorName: variant.color ?? null,
                colorValue: variant.hex ?? null,
                size: variant.size ?? null,
                stockOnHand: variant.stock,
            })
                .onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
        }
    }
};
/**
 * Demo orders.
 *
 * The catalogue alone leaves the admin console, the fulfilment queue and the
 * customer's order history all empty, which makes those surfaces impossible to
 * exercise or develop a frontend against. Two orders are enough to cover the
 * states that actually differ downstream:
 *
 *  - `EDM-DEMO1001` is fully paid and delivered, with a single assigned supplier
 *    and a succeeded payment, so the happy path has something to render.
 *  - `EDM-DEMO1002` is paid but its fulfilment has a NULL `supplier_id`. That is
 *    the "needs supplier assignment" case the queue is built around, and it can
 *    only be demonstrated if the seed contains one.
 *
 * Keyed on `order_number`, so reseeding is idempotent and never duplicates.
 *
 * Stock is deliberately NOT decremented. These rows are presentational: mutating
 * inventory to accommodate fixture data would make a reseed change real stock
 * levels, and the point of the catalogue seeder above is that it leaves
 * `stockOnHand` alone for the same reason.
 */
const seedOrders = async (supplierId) => {
    const variants = await db
        .select({
        id: productVariants.id,
        size: productVariants.size,
        colorName: productVariants.colorName,
        priceCents: products.unitPriceCents,
        productId: products.id,
        productName: products.name,
        productSlug: products.slug,
        imageUrl: products.imageUrl,
    })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .limit(20);
    const first = variants[0];
    const second = variants[1] ?? first;
    if (!first || !second) {
        logger.warn("no variants available; skipping demo orders");
        return;
    }
    const customer = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "client@etoil-du-matin.test"))
        .limit(1);
    const lines = [first, second];
    for (const demo of DEMO_ORDERS) {
        const existing = await db
            .select({ id: orders.id })
            .from(orders)
            .where(eq(orders.orderNumber, demo.orderNumber))
            .limit(1);
        const placedAt = new Date(demo.placedAtIso);
        const fulfillmentState = {
            supplierId: demo.assignSupplier ? supplierId : null,
            status: demo.fulfillmentStatus,
            trackingNumber: demo.trackingNumber ?? null,
            trackingCarrier: demo.trackingCarrier ?? null,
            forwardedAt: demo.fulfillmentStatus === "pending" ? null : placedAt,
            fulfilledAt: ["fulfilled", "shipped", "delivered"].includes(demo.fulfillmentStatus) ? placedAt : null,
            shippedAt: ["shipped", "delivered"].includes(demo.fulfillmentStatus) ? placedAt : null,
            deliveredAt: demo.fulfillmentStatus === "delivered" ? placedAt : null,
        };
        const known = existing[0];
        if (known) {
            /**
             * Reset the fulfilment rather than leaving it alone.
             *
             * These orders are fixtures, not records: an operator poking at the admin
             * console (or an integration run forwarding the unassigned slice) would
             * otherwise permanently consume the very state the demo exists to show,
             * and the next seed could not restore it. Catalogue rows deliberately do
             * not get this treatment — resetting `stockOnHand` would rewrite inventory.
             */
            await db
                .update(orderFulfillments)
                .set(fulfillmentState)
                .where(eq(orderFulfillments.orderId, known.id));
            continue;
        }
        const orderId = newId();
        const subtotalCents = lines.reduce((sum, line) => sum + line.priceCents, 0);
        const taxCents = Math.round((subtotalCents * env.taxBasisPoints) / 10_000);
        const shippingCents = subtotalCents >= env.freeShippingThresholdCents ? 0 : env.shippingFlatCents;
        await db.insert(orders).values({
            id: orderId,
            orderNumber: demo.orderNumber,
            userId: customer[0]?.id ?? null,
            shippingName: "Camille Demo",
            shippingLine1: "18 Rue des Archives",
            shippingCity: "Paris",
            shippingPostalCode: "75004",
            shippingCountry: "FR",
            // From env, not a literal. The rest of this function reads tax and shipping
            // from `env`; hardcoding the currency alone would produce demo orders whose
            // totals were computed in the store currency but labelled as USD.
            currency: env.storeCurrency,
            subtotalCents,
            shippingCents,
            taxCents,
            totalCents: subtotalCents + taxCents + shippingCents,
            status: demo.status,
            idempotencyKey: `seed-${demo.orderNumber}`,
            placedAt,
        });
        for (const line of lines) {
            await db.insert(orderItems).values({
                id: newId(),
                orderId,
                productId: line.productId,
                productName: line.productName,
                productSlug: line.productSlug,
                variantId: line.id,
                variantLabel: [line.colorName, line.size].filter(Boolean).join(" / ") || "Standard",
                imageUrl: line.imageUrl,
                quantity: 1,
                unitPriceCents: line.priceCents,
                lineTotalCents: line.priceCents,
            });
        }
        await db.insert(orderFulfillments).values({ id: newId(), orderId, ...fulfillmentState });
        if (demo.paymentStatus) {
            await db.insert(payments).values({
                id: newId(),
                orderId,
                // Placeholder shape. There is no real PaymentIntent, which is why the
                // refund route cannot be exercised against seeded data.
                stripePaymentIntentId: `pi_seed_${demo.orderNumber.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
                status: demo.paymentStatus,
                amountCents: subtotalCents + taxCents + shippingCents,
                currency: env.storeCurrency,
                cardLast4: "4242",
                cardBrand: "visa",
            });
        }
    }
};
const run = async () => {
    logger.info("seeding demo catalogue");
    const supplierId = await seedSuppliers();
    await seedUsers();
    await seedCatalogue(supplierId);
    await seedOrders(supplierId);
    const totals = await db
        .select({ total: sql `count(*)` })
        .from(products)
        .where(sql `is_active = 1`);
    const orderTotal = await db.select({ total: sql `count(*)` }).from(orders);
    logger.info({
        products: Number(totals[0]?.total ?? 0),
        orders: Number(orderTotal[0]?.total ?? 0),
        adminEmail: SEED.adminEmail,
        adminPassword: SEED.adminPassword,
    }, "seed complete");
};
run()
    .catch((error) => {
    logger.fatal({ err: error }, "seed failed");
    process.exitCode = 1;
})
    .finally(() => {
    void closeDatabase();
});
//# sourceMappingURL=seed.js.map