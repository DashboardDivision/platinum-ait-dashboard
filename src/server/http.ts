import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { env } from "@/lib/env";
import { HttpError } from "./session";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

/** Service-to-service auth for n8n. A bearer token on internal APIs, not a human login factor. */
export function requireIntegrationToken(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = env().INTEGRATION_TOKEN;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "Invalid integration token");
}

/** Same-origin check for state-changing browser requests (CSRF), on top of SameSite=Lax cookies. */
export function requireSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const app = new URL(env().APP_URL).origin;
  if (origin !== app) throw new HttpError(403, "Cross-site request blocked");
}

export function handle<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof ZodError) return json({ error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
      console.error("[api] unhandled", err instanceof Error ? err.message : err);
      return json({ error: "Something went wrong" }, 500);
    }
  };
}
