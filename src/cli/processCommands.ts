import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrateLegacyDotDir } from "../init/migrateDotDir";
import { initTanyaProject } from "../init/projectInit";
import { runGoldenSuiteCommand } from "../golden/suite";
import { formatRunLogLine, readRunLogs } from "../memory/runLogs";
import { cleanTanyaDir, formatBytes } from "../maintenance/clean";
import { parseDurationMs } from "./sessionsCommand";
import { suggestPermissionsFromRuns } from "../safety/permissions/migrate";
import { serveTanyaMcpServer } from "../mcp/server";
import { runTestAppCommand } from "./testAppCommand";
import { runSessionsCommand } from "./sessionsCommand";
import { doctor } from "./doctorCommand";
import { listProviders, testProvider } from "./providersCommand";
import { runEvalCommand } from "./evalCommand";
import { runVideoCommand } from "./videoCommand";
import { flagNumber, flagString, hasFlag, type ParsedArgs } from "./args";

// The process-CLI command registry, mirroring src/commands/ (the slash-command
// registry): each self-contained subcommand is a {name, run} entry and main()
// dispatches by lookup instead of an if-chain. Commands that need the loaded
// provider config (serve, chat, run, ask, review, debug-prompt) stay in
// cli.ts's tail — they share its provider/sink setup.

export interface ProcessCommand {
  name: string;
  aliases?: string[];
  run(args: ParsedArgs): Promise<void>;
}

function commandCwd(args: ParsedArgs): string {
  const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
  migrateLegacyDotDir(cwd);
  return cwd;
}

export const PROCESS_COMMANDS: ProcessCommand[] = [
  { name: "doctor", run: (args) => doctor(args) },
  {
    name: "patterns",
    run: async (args) => {
      const cwd = commandCwd(args);
      const metricsPath = join(cwd, ".tanya", "memory", "forbidden-patterns-metrics.json");
      if (!existsSync(metricsPath)) {
        console.log(`No metrics file at ${metricsPath}. Run a tanya task in this workspace first.`);
        return;
      }
      try {
        const parsed = JSON.parse(readFileSync(metricsPath, "utf8")) as {
          totals?: Record<string, number>;
          lastFiredAt?: Record<string, string>;
          totalScans?: number;
        };
        const totals = parsed.totals ?? {};
        const lastFiredAt = parsed.lastFiredAt ?? {};
        const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
        console.log(`Forbidden-pattern fire metrics — ${cwd}`);
        console.log(`Total scans: ${parsed.totalScans ?? 0}`);
        console.log("");
        if (entries.length === 0) {
          console.log("No patterns have fired in this workspace yet.");
          return;
        }
        console.log(`${"PATTERN".padEnd(48)} ${"FIRES".padStart(7)}  LAST FIRED`);
        for (const [id, count] of entries) {
          const last = lastFiredAt[id]?.slice(0, 16) ?? "—";
          console.log(`${id.padEnd(48)} ${String(count).padStart(7)}  ${last}`);
        }
      } catch (err) {
        console.error(`Could not read metrics: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    },
  },
  {
    name: "test-app",
    run: async (args) => {
      // Deterministic harness — runs without provider config (no loadConfig()).
      const cwd = commandCwd(args);
      const platform = flagString(args, "platform") ?? args.positional[0];
      const warmupMs = flagNumber(args, "warmup");
      const exitCode = await runTestAppCommand({
        cwd,
        ...(platform !== undefined ? { platform } : {}),
        ...(warmupMs !== undefined ? { warmupMs } : {}),
        json: hasFlag(args, "json"),
        keepAlive: hasFlag(args, "keep-alive"),
        record: hasFlag(args, "record"),
        tier1: hasFlag(args, "tier1"),
      });
      if (exitCode !== 0) process.exitCode = exitCode;
    },
  },
  {
    name: "sessions",
    run: async (args) => {
      const cwd = commandCwd(args);
      await runSessionsCommand({
        action: args.positional[0] ?? "list",
        args: args.positional.slice(1),
        cwd,
        global: hasFlag(args, "global"),
        all: hasFlag(args, "all"),
        limit: flagNumber(args, "limit"),
        olderThan: flagString(args, "older-than"),
        json: hasFlag(args, "json"),
      });
    },
  },
  {
    name: "providers",
    run: async (args) => {
      const action = args.positional[0];
      if (action === "list") {
        await listProviders(hasFlag(args, "json"));
        return;
      }
      if (action !== "test") {
        console.log("Usage: tanya providers list [--json] | tanya providers test --provider <name>");
        return;
      }
      await testProvider(args);
    },
  },
  {
    name: "permissions",
    run: async (args) => {
      if (args.positional[0] !== "migrate") {
        console.log("Usage: tanya permissions migrate [--cwd path] [--limit 100]");
        return;
      }
      const cwd = commandCwd(args);
      const limit = flagNumber(args, "limit") ?? 100;
      console.log(JSON.stringify(suggestPermissionsFromRuns(cwd, limit), null, 2));
    },
  },
  {
    name: "mcp",
    run: async (args) => {
      if (args.positional[0] !== "serve") {
        console.log("Usage: tanya mcp serve");
        return;
      }
      await serveTanyaMcpServer({ defaultCwd: resolve(flagString(args, "cwd") ?? process.cwd()) });
    },
  },
  { name: "eval", run: (args) => runEvalCommand(args) },
  {
    name: "init",
    run: async (args) => {
      const cwd = commandCwd(args);
      const path = await initTanyaProject(cwd);
      console.log(path);
    },
  },
  { name: "video", run: (args) => runVideoCommand(args) },
  {
    name: "golden",
    aliases: ["benchmark"],
    run: async (args) => {
      const cwd = commandCwd(args);
      const action = args.positional[0] ?? "summary";
      if (!["summary", "list", "profiles", "run", "validate"].includes(action)) {
        console.log(`Usage: tanya ${args.command} summary|list|profiles|run|validate [--cwd path] [--json] [--profile id] [--all]`);
        return;
      }
      const profile = flagString(args, "profile");
      const exitCode = await runGoldenSuiteCommand(cwd, action, hasFlag(args, "json"), {
        ...(profile ? { profile } : {}),
        all: hasFlag(args, "all"),
      });
      process.exitCode = exitCode;
    },
  },
  {
    name: "restore",
    run: async (args) => {
      const { listSnapshots, restoreSnapshot, undoToPreviousSnapshot } = await import("../snapshots/turnSnapshots");
      const cwd = commandCwd(args);
      if (hasFlag(args, "list")) {
        const snapshots = listSnapshots(cwd);
        if (snapshots.length === 0) {
          console.log("No snapshots for this directory yet. They are taken before a turn's first file mutation.");
          return;
        }
        for (const snapshot of snapshots) {
          console.log(`${snapshot.id.padEnd(40)} ${new Date(snapshot.epochMs).toISOString()}  ${snapshot.label}`);
        }
        return;
      }
      const to = flagString(args, "to");
      if (to) {
        if (restoreSnapshot(cwd, to)) console.log(`Restored ${cwd} to snapshot ${to}.`);
        else {
          console.error(`Could not restore to ${to} — check \`tanya restore --list\`.`);
          process.exitCode = 1;
        }
        return;
      }
      const undone = undoToPreviousSnapshot(cwd);
      if (undone) console.log(`Restored ${cwd} to snapshot ${undone.id} (${undone.label}).`);
      else console.log("Nothing to undo: no snapshot differs from the current tree.");
    },
  },
  {
    name: "runs",
    run: async (args) => {
      const cwd = commandCwd(args);
      const logs = readRunLogs(cwd, 10);
      if (logs.length === 0) {
        process.stdout.write("No run logs found. Run tanya run first.\n");
        return;
      }
      for (const log of logs) process.stdout.write(`${formatRunLogLine(log)}\n`);
    },
  },
  {
    name: "clean",
    run: async (args) => {
      const cwd = commandCwd(args);
      const olderThanRaw = flagString(args, "older-than") ?? "30d";
      const dryRun = hasFlag(args, "dry-run");
      const report = cleanTanyaDir(cwd, { olderThanMs: parseDurationMs(olderThanRaw), dryRun });
      const verb = dryRun ? "Would delete" : "Deleted";
      process.stdout.write(`${verb} (older than ${olderThanRaw}, newest 3 runtime dirs always kept):\n`);
      process.stdout.write(`  runtime evidence: ${report.runtime.length} dir(s)\n`);
      process.stdout.write(`  run logs:         ${report.runs.length} entr(y/ies)\n`);
      process.stdout.write(`  chat sessions:    ${report.sessions.length} file(s)\n`);
      process.stdout.write(`${dryRun ? "Would reclaim" : "Reclaimed"}: ${formatBytes(report.freedBytes)}\n`);
    },
  },
];

/** Dispatch a self-contained process command. Returns false when the command
 *  is not in the registry (config-dependent commands handled by cli.ts). */
export async function runProcessCommand(args: ParsedArgs): Promise<boolean> {
  const command = PROCESS_COMMANDS.find(
    (entry) => entry.name === args.command || entry.aliases?.includes(args.command),
  );
  if (!command) return false;
  await command.run(args);
  return true;
}
