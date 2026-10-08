import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { badRequest } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { requireAdmin, requireAuth } from "../../middleware/auth.js";
import { writeLimiter } from "../../middleware/security.js";
import { asyncHandler } from "../../middleware/validate.js";

/**
 * Backend-owned location for uploaded admin media. Resolved from this file's
 * URL so it is stable regardless of the process working directory: three
 * levels up from `src/modules/admin/` is the backend's root `uploads/`.
 */
export const MEDIA_ROOT = fileURLToPath(new URL("../../../uploads", import.meta.url));

/** MIME type → extension. Everything else is rejected, never stored. */
const ALLOWED_MEDIA: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
]);

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

export const adminMediaRouter = Router();

adminMediaRouter.use(requireAuth, requireAdmin);

/**
 * Accept a base64 image data URL (exactly what a `FileReader` produces) and
 * store it on the backend's own disk, returning an absolute URL.
 *
 * The product form stays a simple URL field; swapping in object storage later
 * only changes this handler, never the client. Server-side MIME allow-list and
 * size cap are the security boundary — the extension comes from the validated
 * type, never from the client, and the key cannot collide because `newId()` is
 * unguessable.
 *
 * Mounted in `app.ts` BEFORE the shared 64kb JSON parser with its own larger
 * limit, mirroring the webhook router: base64 inflates an image ~33%, so a
 * several-megabyte file needs several megabytes of JSON.
 */
adminMediaRouter.post(
  "/",
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { dataUrl } = (req.body ?? {}) as { dataUrl?: unknown };
    if (typeof dataUrl !== "string") throw badRequest("Provide an image as a data URL.");

    const match = /^data:([a-z0-9]+(?:\/[a-z0-9.+-]+)?);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) throw badRequest("Malformed image data URL.");
    const [, mime, base64] = match as unknown as [string, string, string];
    const ext = ALLOWED_MEDIA.get(mime);
    if (!ext) throw badRequest("Only PNG, JPEG, WebP, GIF and AVIF images are accepted");

    const payload = Buffer.from(base64, "base64");
    // `Buffer.from` never throws on invalid base64 — it silently drops bad
    // characters — so an empty buffer is the truthful signal for a garbage body.
    if (payload.length === 0 || payload.length > MAX_MEDIA_BYTES) {
      throw badRequest("Image must be between 1 byte and 8 MB.");
    }

    const filename = `${newId()}.${ext}`;
    await mkdir(MEDIA_ROOT, { recursive: true });
    await writeFile(join(MEDIA_ROOT, filename), payload);

    const proto = req.get("x-forwarded-proto") ?? req.protocol;
    res.status(201).json({ url: `${proto}://${req.get("host")}/uploads/${filename}` });
  }),
);