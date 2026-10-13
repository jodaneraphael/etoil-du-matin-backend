/**
 * LIKE pattern helpers.
 *
 * Building a LIKE pattern from user input needs care in two independent ways.
 *
 * 1. Wildcards. `%` and `_` are wildcards, so a search for "50%" or "a_b" would
 *    otherwise match far more than the user asked for. They are escaped here.
 *
 * 2. The escape character itself. MySQL's default LIKE escape is a backslash,
 *    and backslash is *also* MySQL's string-literal escape character — so
 *    `ESCAPE '\'` is not valid SQL: the backslash escapes the closing quote and
 *    the literal runs on, producing a syntax error. Expressing the same thing
 *    correctly requires doubling it in the SQL text (`ESCAPE '\\'`), which in
 *    turn requires quadrupling it in a JS template literal. That is a trap that
 *    has already been fallen into once here.
 *
 *    So this module uses `!` as the escape character instead. It is not a MySQL
 *    string-literal metacharacter and not a LIKE wildcard, so `ESCAPE '!'` is
 *    unambiguous and survives every layer between here and the server.
 */
/** Escape character used in every pattern this module produces. */
export const LIKE_ESCAPE = "!";
/**
 * Escapes LIKE metacharacters in a literal term and wraps it in wildcards.
 *
 * The escape character is escaped first, so an input containing a literal `!`
 * is matched literally rather than being treated as an escape sequence.
 */
export const likeContains = (term) => {
    const escaped = term
        .replace(/[\\%_!]/g, (match) => `${LIKE_ESCAPE}${match}`)
        .trim();
    return `%${escaped}%`;
};
/** As {@link likeContains}, but anchors at the start of the column. */
export const likeStartsWith = (term) => {
    const escaped = term.replace(/[\\%_!]/g, (match) => `${LIKE_ESCAPE}${match}`).trim();
    return `${escaped}%`;
};
//# sourceMappingURL=like.js.map