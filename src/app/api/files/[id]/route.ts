import { handle } from "@/server/http";
import { requireApiUser } from "@/server/session";
import { authorizeDocument, readStored } from "@/server/documents";

/** Authorized, ownership-checked download. No public or permanent file URLs exist. */
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireApiUser();
  const { id } = await ctx.params;
  const d = await authorizeDocument(u, id);
  const buf = await readStored(d.storageKey);
  const inline = new URL(req.url).searchParams.get("inline") === "1" && d.mimeType.startsWith("image/");
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": d.mimeType,
      "content-length": String(buf.length),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${d.originalName.replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});
