import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ValidationManifest } from "../core";
import {
  gooseMigrationValidator,
  localizationParityValidator,
  migrationCollisionValidator,
} from "../staticChecks";
import { validateCodingTask } from "../index";

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-static-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function manifest(changedFiles: string[]): ValidationManifest {
  return { changedFiles };
}

const GOOSE_UP_DOWN = "-- +goose Up\nCREATE TABLE t (id int);\n-- +goose Down\nDROP TABLE t;\n";

describe("gooseMigrationValidator (F1 — the API-crash-loop miss)", () => {
  it("flags an annotation-less migration whose siblings use goose", async () => {
    const ws = workspace({
      "db/migrations/91044_prev.sql": GOOSE_UP_DOWN,
      "db/migrations/91050_new.sql": "CREATE TABLE hosting (id int);\n", // NO annotations
    });
    const issues = await gooseMigrationValidator.run(ws, manifest(["db/migrations/91050_new.sql"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("task-goose-annotations-missing");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain("+goose Up");
    expect(issues[0]?.files).toEqual(["db/migrations/91050_new.sql"]);
  });

  it("passes a properly annotated migration", async () => {
    const ws = workspace({
      "db/migrations/91044_prev.sql": GOOSE_UP_DOWN,
      "db/migrations/91050_new.sql": GOOSE_UP_DOWN,
    });
    expect(await gooseMigrationValidator.run(ws, manifest(["db/migrations/91050_new.sql"]))).toEqual([]);
  });

  it("does NOT fire in a non-goose migrations dir (no false positives)", async () => {
    const ws = workspace({
      "db/migrations/0001_prev.sql": "CREATE TABLE a (id int);\n", // plain SQL, no goose
      "db/migrations/0002_new.sql": "CREATE TABLE b (id int);\n",
    });
    expect(await gooseMigrationValidator.run(ws, manifest(["db/migrations/0002_new.sql"]))).toEqual([]);
  });

  it("flags a partial annotation (Up but no Down)", async () => {
    const ws = workspace({
      "db/migrations/91044_prev.sql": GOOSE_UP_DOWN,
      "db/migrations/91050_new.sql": "-- +goose Up\nCREATE TABLE t (id int);\n",
    });
    const issues = await gooseMigrationValidator.run(ws, manifest(["db/migrations/91050_new.sql"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("+goose Down");
    expect(issues[0]?.message).not.toContain("+goose Up and");
  });
});

describe("migrationCollisionValidator (renumbering — two 91044_*.sql)", () => {
  it("flags a numeric-prefix collision with a different migration", async () => {
    const ws = workspace({
      "db/migrations/91044_existing.sql": GOOSE_UP_DOWN,
      "db/migrations/91044_hosting.sql": GOOSE_UP_DOWN,
    });
    const issues = await migrationCollisionValidator.run(ws, manifest(["db/migrations/91044_hosting.sql"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("task-migration-number-collision");
    expect(issues[0]?.message).toContain("91044");
    expect(issues[0]?.message).toContain("91044_existing.sql");
  });

  it("does NOT flag a golang-migrate up/down pair sharing a prefix", async () => {
    const ws = workspace({
      "db/migrations/91044_add.up.sql": "CREATE TABLE t (id int);\n",
      "db/migrations/91044_add.down.sql": "DROP TABLE t;\n",
    });
    expect(await migrationCollisionValidator.run(ws, manifest(["db/migrations/91044_add.up.sql"]))).toEqual([]);
  });

  it("passes a unique prefix", async () => {
    const ws = workspace({
      "db/migrations/91044_existing.sql": GOOSE_UP_DOWN,
      "db/migrations/91050_hosting.sql": GOOSE_UP_DOWN,
    });
    expect(await migrationCollisionValidator.run(ws, manifest(["db/migrations/91050_hosting.sql"]))).toEqual([]);
  });
});

describe("localizationParityValidator (F4 recurrence — missing sibling locales)", () => {
  it("lists the locale files missing an added Apple key", async () => {
    const ws = workspace({
      "Sources/GettingStartedView.swift": 'let title = L10n.tr("Get Set Up")\n',
      "Resources/en.lproj/Localizable.strings": '"Get Set Up" = "Get Set Up";\n',
      "Resources/es.lproj/Localizable.strings": '"Other" = "Otro";\n',
      "Resources/fr.lproj/Localizable.strings": '"Other" = "Autre";\n',
      "Resources/de.lproj/Localizable.strings": '"Other" = "Andere";\n',
    });
    const issues = await localizationParityValidator.run(ws, manifest(["Sources/GettingStartedView.swift"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("task-localization-missing-locale");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.files).toHaveLength(3); // es, fr, de — not en
    expect(issues[0]?.files?.some((f) => f.includes("es.lproj"))).toBe(true);
    expect(issues[0]?.files?.some((f) => f.includes("en.lproj"))).toBe(false);
  });

  it("passes when the key exists in every locale", async () => {
    const ws = workspace({
      "Sources/V.swift": 'let t = NSLocalizedString("Save", comment: "")\n',
      "en.lproj/Localizable.strings": '"Save" = "Save";\n',
      "es.lproj/Localizable.strings": '"Save" = "Guardar";\n',
    });
    expect(await localizationParityValidator.run(ws, manifest(["Sources/V.swift"]))).toEqual([]);
  });

  it("flags a missing Android string resource", async () => {
    const ws = workspace({
      "app/MainScreen.kt": 'Text(stringResource(R.string.get_set_up))\n',
      "app/src/main/res/values/strings.xml": '<resources><string name="get_set_up">Get Set Up</string></resources>\n',
      "app/src/main/res/values-es/strings.xml": '<resources><string name="other">Otro</string></resources>\n',
    });
    const issues = await localizationParityValidator.run(ws, manifest(["app/MainScreen.kt"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.files?.some((f) => f.includes("values-es"))).toBe(true);
  });

  it("does NOT run when the project has no locale files", async () => {
    const ws = workspace({ "Sources/V.swift": 'let t = NSLocalizedString("Save", comment: "")\n' });
    expect(await localizationParityValidator.run(ws, manifest(["Sources/V.swift"]))).toEqual([]);
  });

  it("FIX-B: extracts keys from L10n.format(…) and String(localized:…) too", async () => {
    const ws = workspace({
      "Sources/V.swift": 'let a = L10n.format("count_items", n)\nlet b = String(localized: "welcome_title")\n',
      "en.lproj/Localizable.strings": '"count_items" = "%d";\n"welcome_title" = "Welcome";\n',
      "es.lproj/Localizable.strings": '"other" = "x";\n', // missing both
    });
    const issues = await localizationParityValidator.run(ws, manifest(["Sources/V.swift"]));
    const flagged = issues.map((i) => i.message);
    expect(flagged.some((m) => m.includes("count_items"))).toBe(true);
    expect(flagged.some((m) => m.includes("welcome_title"))).toBe(true);
  });
});

describe("integration — registered in validateCodingTask and gates the verdict", () => {
  it("a goose miss flips validation.passed to false", async () => {
    const ws = workspace({
      "db/migrations/91044_prev.sql": GOOSE_UP_DOWN,
      "db/migrations/91050_new.sql": "CREATE TABLE hosting (id int);\n",
    });
    const summary = await validateCodingTask(ws, manifest(["db/migrations/91050_new.sql"]));
    expect(summary.passed).toBe(false);
    expect(summary.issues.some((i) => i.id === "task-goose-annotations-missing")).toBe(true);
    expect(summary.firedValidatorIds).toContain("task.gooseMigration");
  });
});
