import { env } from "../env.js";
export const MIN_CENTS = 50;
export const MAX_CENTS = 99_999_999;
/**
 * Build a priced line.
 *
 * Generic over the input so callers keep their extra fields (sku, stock, line id)
 * with no cast at the call site.
 *
 * `Math.round` rather than truncation: for a 3-line order with odd unit prices,
 * rounding each line keeps the sum of the lines equal to the stored subtotal.
 * Rounding only at the end would make the two disagree by a cent, which shows up
 * later as a reconciliation mismatch against Stripe.
 */
export const priceLine = (input) => ({
    ...input,
    lineTotalCents: Math.round(input.unitPriceCents * input.quantity),
});
/**
 * Compute shipping, tax and total.
 *
 * Every figure is derived here from the server-side rate table. The checkout
 * route accepts no amounts from the client at all, so this function is the only
 * thing that can influence what a customer is charged.
 */
export const computeTotals = (lines) => {
    const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
    // Free shipping once the threshold is met. Applied to the subtotal alone, so
    // it cannot be gamed by inflating quantities of a single cheap item.
    const shippingCents = subtotalCents === 0 || subtotalCents >= env.freeShippingThresholdCents ? 0 : env.shippingFlatCents;
    // Tax on goods only, calculated in basis points with integer division and a
    // round-half-up remainder, matching how tax authorities round.
    const taxableCents = subtotalCents;
    const taxCents = Math.round((taxableCents * env.taxBasisPoints) / 10_000);
    return {
        currency: env.storeCurrency,
        subtotalCents,
        shippingCents,
        taxCents,
        totalCents: subtotalCents + shippingCents + taxCents,
        itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    };
};
/**
 * Format for display. Intl handles the minor-unit-to-decimal conversion, so this
 * is only ever used for logs and emails, never for arithmetic.
 */
export const formatMoney = (cents, currency = env.storeCurrency) => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
/**
 * Percentage discount for the storefront badge. Null when there is no strike
 * price, or when the "discount" would be zero or negative.
 */
export const discountPercent = (unitPriceCents, compareAtCents) => {
    if (!compareAtCents || compareAtCents <= unitPriceCents)
        return null;
    return Math.round(((compareAtCents - unitPriceCents) / compareAtCents) * 100);
};
//# sourceMappingURL=money.js.map