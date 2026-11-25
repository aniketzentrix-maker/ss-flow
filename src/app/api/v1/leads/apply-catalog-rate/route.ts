import { action } from "@/lib/action";
import { applyCatalogRateSchema } from "@/lib/schemas";
import { applyCatalogRate } from "@/modules/leads/apply-catalog-rate";

export const POST = action("lead.manage", applyCatalogRateSchema, (session, body, key) =>
  applyCatalogRate(session, body, key),
);
