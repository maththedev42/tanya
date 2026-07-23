import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { findWorkspaceFiles, readWorkspaceFile, type ValidationIssue, type Validator } from "./core";

// Cheap, dependency-free static checks that run at finalization against the
// session's changed files. Each is objective (ERROR tier, zero false-positive
// space) — they encode failures that shipped to production and broke things:
//   - a goose migration with no `-- +goose Up/Down` annotations crash-looped an
//     API for hours (goose can't parse it);
//   - two migrations sharing a numeric prefix silently mis-ordered;
//   - ~25 localization keys added to the code with entries in only one of four
//     locale files (twice, on different projects).

const MIGRATION_SQL = /(?:^|\/)migrations?\/[^/]*\.sql$/i;

/** readdir with file types, or null if the directory can't be read. Kept as a
 *  direct call (no explicit annotation) so TS infers `Dirent<string>[]`. */
async function safeReaddir(absDir: string) {
  try {
    return await readdir(absDir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** A goose migration must be annotated. We only demand it when the file's
 *  sibling .sql migrations already use goose — that discriminator keeps us off
 *  Prisma / golang-migrate / plain-SQL dirs (zero false positives). */
export const gooseMigrationValidator: Validator = {
  id: "task.gooseMigration",
  async run(workspace, manifest) {
    const files = manifest.changedFiles.filter((f) => MIGRATION_SQL.test(f));
    if (files.length === 0) return [];
    const issues: ValidationIssue[] = [];
    for (const file of files) {
      const content = await readWorkspaceFile(workspace, file);
      if (content === null) continue;
      const hasUp = /^--\s*\+goose\s+Up\b/m.test(content);
      const hasDown = /^--\s*\+goose\s+Down\b/m.test(content);
      if (hasUp && hasDown) continue;
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
      if (!(await siblingsUseGoose(workspace, dir, file))) continue;
      const missing = [!hasUp ? "-- +goose Up" : null, !hasDown ? "-- +goose Down" : null]
        .filter((x): x is string => x !== null)
        .join(" and ");
      issues.push({
        id: "task-goose-annotations-missing",
        severity: "error",
        gating: true,
        message: `${file} sits in a goose migrations directory (its siblings use goose annotations) but is missing ${missing}. goose cannot parse an unannotated migration, so the service crash-loops on the next boot. Wrap the SQL in \`-- +goose Up\` / \`-- +goose Down\` sections.`,
        files: [file],
      });
    }
    return issues;
  },
};

async function siblingsUseGoose(workspace: string, dir: string, exclude: string): Promise<boolean> {
  const entries = await safeReaddir(join(workspace, dir));
  if (!entries) return false;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.sql$/i.test(entry.name)) continue;
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (rel === exclude) continue;
    const content = await readWorkspaceFile(workspace, rel);
    if (content && /^--\s*\+goose\s+(?:Up|Down)\b/m.test(content)) return true;
  }
  return false;
}

/** Strip a migration filename to its logical slug so up/down halves of one
 *  migration (golang-migrate `NNN_name.up.sql` / `.down.sql`) are NOT treated
 *  as a numeric-prefix collision. */
function migrationSlug(name: string): string {
  return name
    .replace(/^(\d{3,})[_-]/, "")
    .replace(/\.(?:up|down)\.sql$/i, "")
    .replace(/\.sql$/i, "")
    .replace(/\.(?:up|down)$/i, "")
    .toLowerCase();
}

/** A new migration must not reuse a numeric prefix already present in its dir —
 *  duplicate prefixes make ordering ambiguous and a tool may skip or misapply
 *  one. (Real incident: two `91044_*.sql` in the same dir.) */
export const migrationCollisionValidator: Validator = {
  id: "task.migrationNumberCollision",
  async run(workspace, manifest) {
    const files = manifest.changedFiles.filter((f) => MIGRATION_SQL.test(f));
    if (files.length === 0) return [];
    const issues: ValidationIssue[] = [];
    for (const file of files) {
      const base = file.slice(file.lastIndexOf("/") + 1);
      const prefixMatch = base.match(/^(\d{3,})[_-]/);
      const prefix = prefixMatch?.[1];
      if (!prefix) continue;
      const slug = migrationSlug(base);
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
      const entries = await safeReaddir(join(workspace, dir));
      if (!entries) continue;
      const colliding = entries
        .filter((e) => (e.isFile() || e.isDirectory()) && e.name !== base)
        .map((e) => e.name)
        .filter((name) => {
          const m = name.match(/^(\d{3,})[_-]/);
          return m?.[1] === prefix && migrationSlug(name) !== slug;
        });
      if (colliding.length > 0) {
        issues.push({
          id: "task-migration-number-collision",
          severity: "error",
          gating: true,
          message: `Migration ${file} reuses numeric prefix ${prefix}, already taken by ${colliding.join(", ")} in the same directory. Duplicate prefixes make migration order ambiguous. Renumber this migration to the next free prefix.`,
          files: [file],
        });
      }
    }
    return issues;
  },
};

const APPLE_STRINGS = /\.lproj\/Localizable\.strings$/i;
const ANDROID_STRINGS = /(?:^|\/)values(?:-[A-Za-z0-9-]+)?\/strings\.xml$/i;
const LOCALIZED_SOURCE = /\.(?:swift|kt|kts|java|m|mm|dart)$/i;

/** Extract localization keys that a source file looks up. These call shapes ARE
 *  localization lookups by construction, so the extracted literal is a key with
 *  no ambiguity. */
function extractLocalizationKeys(content: string): string[] {
  const keys: string[] = [];
  const push = (m: RegExpMatchArray) => {
    const k = m[1];
    if (k) keys.push(k);
  };
  for (const m of content.matchAll(/\bNSLocalizedString\(\s*"((?:[^"\\]|\\.)*)"/g)) push(m);
  // SwiftGen L10n.tr("key") and L10n.format("key", …), plain member access
  // (L10n.someKey is a different, generated-property shape and not matched here).
  for (const m of content.matchAll(/\bL10n\.(?:tr|format)\(\s*"((?:[^"\\]|\\.)*)"/g)) push(m);
  // Swift 5.5+ String(localized: "key") / Text("key", comment:) style lookups.
  for (const m of content.matchAll(/\bString\(\s*localized:\s*"((?:[^"\\]|\\.)*)"/g)) push(m);
  // Android: stringResource(R.string.key) / getString(R.string.key) / R.string.key
  for (const m of content.matchAll(/\bR\.string\.([A-Za-z_][A-Za-z0-9_]*)/g)) push(m);
  return keys;
}

function localeFileHasKey(content: string, key: string, apple: boolean): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return apple
    ? new RegExp(`"${escaped}"\\s*=`, "m").test(content)
    : new RegExp(`name\\s*=\\s*"${escaped}"`, "m").test(content);
}

/** Every new localization key must exist in EVERY sibling locale file. Auto-runs
 *  only when a locale-file set exists. Pure grep — this exact miss shipped twice
 *  (localized strings added to code with zero/one of four locale entries). */
export const localizationParityValidator: Validator = {
  id: "task.localizationParity",
  async run(workspace, manifest) {
    const sources = manifest.changedFiles.filter((f) => LOCALIZED_SOURCE.test(f));
    if (sources.length === 0) return [];
    const keys = new Set<string>();
    for (const file of sources) {
      const content = await readWorkspaceFile(workspace, file);
      if (content) for (const key of extractLocalizationKeys(content)) keys.add(key);
    }
    if (keys.size === 0) return [];

    const appleFiles = await findWorkspaceFiles(workspace, (p) => APPLE_STRINGS.test(p), { limit: 100 });
    const androidFiles = await findWorkspaceFiles(workspace, (p) => ANDROID_STRINGS.test(p), { limit: 100 });
    if (appleFiles.length === 0 && androidFiles.length === 0) return [];

    const locales = new Map<string, { apple: boolean; content: string }>();
    for (const lf of appleFiles) locales.set(lf, { apple: true, content: (await readWorkspaceFile(workspace, lf)) ?? "" });
    for (const lf of androidFiles) locales.set(lf, { apple: false, content: (await readWorkspaceFile(workspace, lf)) ?? "" });

    const issues: ValidationIssue[] = [];
    for (const key of keys) {
      const missing: string[] = [];
      for (const [lf, { apple, content }] of locales) {
        if (!localeFileHasKey(content, key, apple)) missing.push(lf);
      }
      if (missing.length > 0) {
        issues.push({
          id: "task-localization-missing-locale",
          severity: "error",
          gating: true,
          message: `Localization key "${key}" is referenced in code but missing from ${missing.length} locale file(s): ${missing.join(", ")}. Add the key to every sibling locale file.`,
          files: missing,
        });
      }
    }
    return issues;
  },
};

export const staticCheckValidators: Validator[] = [
  gooseMigrationValidator,
  migrationCollisionValidator,
  localizationParityValidator,
];
