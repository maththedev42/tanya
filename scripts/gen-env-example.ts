// Regenerate .env.example from the runtime-flag registry.
// Usage: npx tsx scripts/gen-env-example.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderEnvExample } from "../src/config/runtimeFlags";

const target = join(import.meta.dirname, "..", ".env.example");
writeFileSync(target, renderEnvExample(), "utf8");
console.log(`wrote ${target}`);
