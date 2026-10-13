import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { contactMessages, newsletterSubscribers } from "../../db/schema.js";
import { isDuplicateEntry, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { logger, maskEmail } from "../../lib/logger.js";
/**
 * Persist a contact submission.
 *
 * `userId` is attached when the sender is signed in so the console can show their
 * order history alongside the message. It is null otherwise, and the column is
 * not a foreign key — an enquiry outlives the account that made it.
 *
 * The id is generated up front rather than read back: MySQL has no
 * `INSERT ... RETURNING`, and the alternative is a second query to fetch a row we
 * just wrote and already know the primary key of.
 */
export const createMessage = async (input, userId) => {
    const id = newId();
    await db.insert(contactMessages).values({ id, userId, ...input });
    return { id };
};
/**
 * Newest-first page of messages in one triage state.
 *
 * The console needs triage, not search, so a single status filter is enough.
 * Ordering is `createdAt` descending with `id` as a tiebreak: the column has
 * millisecond precision, so two submissions landing in the same millisecond
 * would otherwise come back in an arbitrary order and paginate inconsistently.
 */
export const listMessages = async (query) => {
    const rows = await db
        .select({
        id: contactMessages.id,
        name: contactMessages.name,
        email: contactMessages.email,
        topic: contactMessages.topic,
        message: contactMessages.message,
        status: contactMessages.status,
        userId: contactMessages.userId,
        createdAt: contactMessages.createdAt,
    })
        .from(contactMessages)
        .where(eq(contactMessages.status, query.status))
        .orderBy(desc(contactMessages.createdAt), desc(contactMessages.id))
        .limit(query.limit);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
};
/** Unread count, for the console badge. */
export const countUnread = async () => {
    const [row] = await db
        .select({ total: sql `count(*)` })
        .from(contactMessages)
        .where(eq(contactMessages.status, "new"));
    return Number(row?.total ?? 0);
};
/**
 * Move a message between triage states.
 *
 * Guarded on the id and reported as 404 when nothing matched, so a stale console
 * tab cannot report success for a row that has since been deleted.
 */
export const setMessageStatus = async (id, status) => {
    await db.update(contactMessages).set({ status }).where(eq(contactMessages.id, id));
    // Existence is confirmed by the read-back in `getMessage` rather than by an
    // affected-row count: MySQL reports 0 affected rows when a row is updated to the
    // values it already held, so a count would 404 a legitimate no-op. The read-back
    // cannot distinguish that case from a missing row.
};
/** Single message, for the console detail pane. */
export const getMessage = async (id) => {
    const [row] = await db.select().from(contactMessages).where(eq(contactMessages.id, id)).limit(1);
    if (!row)
        throw notFound("Message not found.");
    return { ...row, createdAt: row.createdAt.toISOString() };
};
/**
 * Subscribe an address to the newsletter.
 *
 * Idempotent by design: the footer sits on every page, so the same person will
 * submit it more than once, and "you're already on the list" is a friendlier and
 * more truthful answer than a 409. The upsert also revives a previously
 * unsubscribed address, which is what someone clicking Subscribe again after
 * opting out actually intends.
 *
 * `userId` is only overwritten when the new value is non-null, via `coalesce`: a
 * guest subscribing with an address that later belongs to an account should not
 * blank the link on re-subscribe.
 */
export const subscribe = async (email, userId) => {
    const [existing] = await db
        .select({ isActive: newsletterSubscribers.isActive })
        .from(newsletterSubscribers)
        .where(eq(newsletterSubscribers.email, email))
        .limit(1);
    try {
        await db
            .insert(newsletterSubscribers)
            .values({ id: newId(), email, userId })
            .onDuplicateKeyUpdate({
            set: {
                isActive: true,
                unsubscribedAt: null,
                userId: sql `coalesce(${userId}, newsletter_subscribers.user_id)`,
            },
        });
    }
    catch (error) {
        // A duplicate slipping through is still a success from the caller's view.
        if (!isDuplicateEntry(error))
            throw error;
        return { alreadySubscribed: true };
    }
    return { alreadySubscribed: existing?.isActive === true };
};
/**
 * Opt out.
 *
 * A soft unsubscribe rather than a delete: the address is personal data with a
 * history, and a later complaint about being subscribed after unsubscribing is
 * answerable only if the row survives. Re-subscribing clears the timestamp.
 *
 * **Every outcome is a success.** An unknown address, an active subscriber and an
 * already-unsubscribed address are all reported identically, because the endpoint
 * takes an email address from an unauthenticated caller and any difference in the
 * response turns it into a membership oracle: POST an address, get a 204 if they
 * are on the list and a 400 if not, and the whole subscriber base can be
 * enumerated one guess at a time. Which is worse than the disclosure it was
 * presumably trying to avoid.
 *
 * Reporting "not on the list" to the person clicking their own unsubscribe link
 * buys nothing either: it cannot be actioned, because there is nothing to remove.
 * The distinct case is logged instead, where an operator can see it and a
 * mis-scoped campaign can be spotted.
 */
export const unsubscribe = async (email) => {
    // `isActive` is fetched but only used to decide whether a write is needed. The
    // UPDATE itself is the idempotent statement; skipping it for an
    // already-unsubscribed row just avoids a pointless write.
    const [existing] = await db
        .select({ isActive: newsletterSubscribers.isActive })
        .from(newsletterSubscribers)
        .where(eq(newsletterSubscribers.email, email))
        .limit(1);
    if (!existing) {
        // Masked: the address is PII, and this is a log line.
        logger.info({ email: maskEmail(email) }, "unsubscribe requested for an address that was never subscribed");
        return;
    }
    // Idempotent: unsubscribing an already-unsubscribed address is a no-op, not an
    // error, so a double-clicked link does not surface a failure to the customer.
    if (!existing.isActive)
        return;
    await db
        .update(newsletterSubscribers)
        .set({ isActive: false, unsubscribedAt: new Date() })
        .where(eq(newsletterSubscribers.email, email));
};
/** Active subscribers only — unsubscribed addresses are not "the list". */
export const listSubscribers = async (limit) => {
    const rows = await db
        .select({
        email: newsletterSubscribers.email,
        isActive: newsletterSubscribers.isActive,
        createdAt: newsletterSubscribers.createdAt,
    })
        .from(newsletterSubscribers)
        .where(eq(newsletterSubscribers.isActive, true))
        .orderBy(desc(newsletterSubscribers.createdAt))
        .limit(limit);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
};
/** Size of the active list, for the console. */
export const countSubscribers = async () => {
    const [row] = await db
        .select({ total: sql `count(*)` })
        .from(newsletterSubscribers)
        .where(eq(newsletterSubscribers.isActive, true));
    return Number(row?.total ?? 0);
};
//# sourceMappingURL=contact.service.js.map