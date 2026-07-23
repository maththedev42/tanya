import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Parsed process-CLI arguments and the flag accessors shared by the command
// modules. Parsing itself (commander program setup) stays in cli.ts.

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | string[] | boolean>;
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagStrings(args: ParsedArgs, name: string): string[] {
  const value = args.flags.get(name);
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || typeof value === "string" || Array.isArray(value);
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readPrompt(args: ParsedArgs): string {
  const promptFile = flagString(args, "prompt-file");
  if (promptFile) return readFileSync(resolve(promptFile), "utf8");
  return args.positional.join(" ").trim();
}
