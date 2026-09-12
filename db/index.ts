import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Configure it in wrangler.jsonc before enabling live replay persistence."
    );
  }

  return drizzle(env.DB, { schema });
}
