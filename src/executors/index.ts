import type { ExecutorId, ExternalExecutor } from "./types";
import { claudeExecutor } from "./claude";
import { codexExecutor } from "./codex";
import { cursorExecutor } from "./cursor";

const registry = new Map<ExecutorId, ExternalExecutor>([
  ["claude", claudeExecutor],
  ["codex", codexExecutor],
  ["cursor", cursorExecutor],
]);

export function resolveExecutor(id: ExecutorId): ExternalExecutor | undefined {
  return registry.get(id);
}

export async function listExecutors(): Promise<Array<{ id: ExecutorId; available: boolean }>> {
  const results: Array<{ id: ExecutorId; available: boolean }> = [];
  for (const [id, executor] of registry) {
    let available = false;
    try {
      available = await executor.available();
    } catch {
      available = false;
    }
    results.push({ id, available });
  }
  return results;
}

export type { ExecutorId, ExternalExecutor, ExecutorTask, ExecutorResult } from "./types";
export { executorEnv } from "./executorUtils";
