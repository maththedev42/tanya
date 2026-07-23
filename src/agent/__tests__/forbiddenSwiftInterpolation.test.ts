import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanForbiddenPatterns } from "../forbiddenPatterns";

describe("swift-escaped-string-interpolation forbidden pattern", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "tanya-swift-interp-"));
    await mkdir(join(workspace, "Sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function write(rel: string, content: string): Promise<void> {
    await writeFile(join(workspace, rel), content, "utf8");
  }

  it("flags a doubled-backslash interpolation (renders literal \\(n))", async () => {
    // Two real backslashes on disk before (n) — the calculator bug.
    await write("Sources/Keypad.swift", 'Button("\\\\(n)") { tap(n) }');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Keypad.swift"]);
    expect(issues.map((i) => i.id)).toContain("swift-escaped-string-interpolation");
  });

  it("flags the property-access form too (the run-5 \\\\(row…) shape)", async () => {
    // Two real backslashes on disk before (row.title) — B5 field shape.
    await write("Sources/Row.swift", 'Text("\\\\(row.title)")');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Row.swift"]);
    expect(issues.map((i) => i.id)).toContain("swift-escaped-string-interpolation");
  });

  it("does NOT flag correct single-backslash interpolation", async () => {
    await write("Sources/Keypad.swift", 'Button("\\(n)") { tap(n) }');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Keypad.swift"]);
    expect(issues.map((i) => i.id)).not.toContain("swift-escaped-string-interpolation");
  });

  it("does NOT flag unrelated escapes like \\\\d regexes", async () => {
    await write("Sources/Regex.swift", 'let digits = "\\\\d+"');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Regex.swift"]);
    expect(issues.map((i) => i.id)).not.toContain("swift-escaped-string-interpolation");
  });

  it("ignores non-swift files", async () => {
    await write("Sources/notes.txt", 'Button("\\\\(n)")');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/notes.txt"]);
    expect(issues.map((i) => i.id)).not.toContain("swift-escaped-string-interpolation");
  });
});

describe("swiftui-bare-accentcolor-shapestyle forbidden pattern", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "tanya-swift-accent-"));
    await mkdir(join(workspace, "Sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function write(rel: string, content: string): Promise<void> {
    await writeFile(join(workspace, rel), content, "utf8");
  }

  it("flags bare .accentColor in foregroundStyle (the FinanceWorld compile break)", async () => {
    await write("Sources/Row.swift", "Image(systemName: icon).foregroundStyle(.accentColor)");
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Row.swift"]);
    expect(issues.map((i) => i.id)).toContain("swiftui-bare-accentcolor-shapestyle");
  });

  it("flags the ternary form too", async () => {
    await write("Sources/Row.swift", "Text(t).foregroundStyle(isOn ? .accentColor : .secondary)");
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Row.swift"]);
    expect(issues.map((i) => i.id)).toContain("swiftui-bare-accentcolor-shapestyle");
  });

  it("does NOT flag the correct Color.accentColor spelling", async () => {
    await write("Sources/Row.swift", "Text(t).foregroundStyle(Color.accentColor)");
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Row.swift"]);
    expect(issues.map((i) => i.id)).not.toContain("swiftui-bare-accentcolor-shapestyle");
  });

  it("does NOT flag foregroundColor(.accentColor) — Color context resolves fine", async () => {
    await write("Sources/Row.swift", "Text(t).foregroundColor(.accentColor)");
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Row.swift"]);
    expect(issues.map((i) => i.id)).not.toContain("swiftui-bare-accentcolor-shapestyle");
  });

  it("is suppressed when the file itself defines the ShapeStyle extension", async () => {
    await write("Sources/Row.swift", [
      "extension ShapeStyle where Self == Color {",
      "  static var accentColor: Color { .accentColor }",
      "}",
      "struct Row: View { var body: some View { Text(\"x\").foregroundStyle(.accentColor) } }",
    ].join("\n"));
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Row.swift"]);
    expect(issues.map((i) => i.id)).not.toContain("swiftui-bare-accentcolor-shapestyle");
  });
});

describe("swift-escaped-keypath forbidden pattern", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "tanya-swift-keypath-"));
    await mkdir(join(workspace, "Sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function write(rel: string, content: string): Promise<void> {
    await writeFile(join(workspace, rel), content, "utf8");
  }

  it("flags a double-escaped keypath (the BillsView compile break)", async () => {
    // Two real backslashes on disk before .modelContext.
    await write("Sources/Bills.swift", "@Environment(\\\\.modelContext) private var context");
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Bills.swift"]);
    expect(issues.map((i) => i.id)).toContain("swift-escaped-keypath");
  });

  it("does NOT flag a correct single-backslash keypath", async () => {
    await write("Sources/Bills.swift", "@Environment(\\.modelContext) private var context");
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Bills.swift"]);
    expect(issues.map((i) => i.id)).not.toContain("swift-escaped-keypath");
  });

  it("does NOT flag regex string literals with character classes", async () => {
    await write("Sources/Regex.swift", 'let re = try NSRegularExpression(pattern: "(\\\\.[a-z]+)")');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Regex.swift"]);
    expect(issues.map((i) => i.id)).not.toContain("swift-escaped-keypath");
  });
});
