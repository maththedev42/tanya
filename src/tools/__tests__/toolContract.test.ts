import { describe, expect, it } from "vitest";
import { defaultTools } from "../fsTools";
import { WRITE_CAPABLE_TOOLS } from "../toolGate";
import { mutatingToolNames } from "../../agent/toolResultProcessor";

// Registry-wide invariants: every tool the agent can call must present a
// coherent definition to the provider, and every OTHER place that refers to
// tools by name (the write gate, the mutation detector, the required-tool
// guard) must stay in sync with the registry. Name drift here is silent in
// production — the stale entry just never matches (the shipped example:
// mutatingToolNames said "copy_directory" while the tool is "copy_dir", so
// copy_dir never triggered the pre-turn snapshot).

const tools = defaultTools();
const names = new Set(tools.map((tool) => tool.name));

describe("tool contract — registry invariants", () => {
  it("tool names are unique and well-formed", () => {
    expect(names.size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.name, `malformed tool name: ${tool.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("every tool definition is coherent (name match, description, object schema)", () => {
    for (const tool of tools) {
      expect(tool.definition.type, tool.name).toBe("function");
      expect(tool.definition.function.name, tool.name).toBe(tool.name);
      expect(tool.description.trim().length, `${tool.name} has no description`).toBeGreaterThan(0);
      expect(tool.definition.function.description.trim().length, `${tool.name} definition has no description`).toBeGreaterThan(0);
      expect(tool.definition.function.parameters.type, tool.name).toBe("object");
      expect(typeof tool.definition.function.parameters.properties, tool.name).toBe("object");
    }
  });

  it("every required parameter is declared in properties", () => {
    for (const tool of tools) {
      const declared = Object.keys(tool.definition.function.parameters.properties);
      for (const required of tool.definition.function.parameters.required ?? []) {
        expect(declared, `${tool.name} requires undeclared parameter "${required}"`).toContain(required);
      }
    }
  });

  it("the write gate's tool list names only registered tools", () => {
    for (const name of WRITE_CAPABLE_TOOLS) {
      expect(names.has(name), `WRITE_CAPABLE_TOOLS names unknown tool "${name}"`).toBe(true);
    }
  });

  it("the mutation detector's tool list names only registered tools", () => {
    for (const name of mutatingToolNames) {
      expect(names.has(name), `mutatingToolNames names unknown tool "${name}"`).toBe(true);
    }
  });

  it("tools the runner can require by name exist", () => {
    // requiredHighLevelTool (runner) can demand these for scaffold tasks.
    expect(names.has("create_android_foundation")).toBe(true);
    expect(names.has("create_ios_splash")).toBe(true);
  });
});
