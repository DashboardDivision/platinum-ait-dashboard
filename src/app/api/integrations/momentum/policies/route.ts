import { z } from "zod";
import { handle, json, requireIntegrationToken } from "@/server/http";
import { importMomentumPolicies } from "@/server/production";

const Row = z.object({
  producerId: z.string().min(1),
  externalRef: z.string().min(1),
  policyType: z.string().min(1),
  carrier: z.string().nullish(),
  businessType: z.enum(["new", "renewal", "rewrite", "endorsement", "quote"]),
  writtenDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  termMonths: z.number().int().nullish(),
  termPremiumCents: z.number().int().nullish(),
  annualizedCents: z.number().int().nullish(),
  cancelled: z.boolean().optional(),
  cancellationDeltaCents: z.number().int().nullish(),
});

/** Read-only Momentum AMP sync pushes policies here. Upserts by policy number; never duplicates. */
export const POST = handle(async (req: Request) => {
  requireIntegrationToken(req);
  const body = z.object({ rows: z.array(Row).max(2000) }).parse(await req.json());
  return json(await importMomentumPolicies(body.rows));
});
