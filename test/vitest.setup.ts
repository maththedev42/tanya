import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runner-level tests execute mutating tools, which take turn snapshots.
// Without this redirect every such test writes a store into the developer's
// real ~/.tanya/snapshots (hundreds of orphaned side repos per suite run).
// Tests that need their own store still win by stubbing the var themselves.
if (!process.env.TANYA_SNAPSHOTS_DIR) {
  process.env.TANYA_SNAPSHOTS_DIR = mkdtempSync(join(tmpdir(), "tanya-test-snapshots-"));
}
