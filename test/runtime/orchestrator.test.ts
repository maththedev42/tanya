import { describe, expect, it } from "vitest";
import { RuntimeUsageError, runBootTest } from "../../src/runtime";
import { makeBootCheck, makeBootVerdict, type BootAdapter, type RuntimeContext } from "../../src/runtime/types";
import { makeFakeExec } from "./fakeExec";

const WS = "/ws";

function passAdapter(platform: BootAdapter["platform"], hooks: { onBoot?: (ctx: RuntimeContext) => void } = {}): BootAdapter {
  return {
    platform,
    capabilityProbe: async () => ({ ok: true }),
    boot: async (ctx) => {
      hooks.onBoot?.(ctx);
      return makeBootVerdict({
        status: "pass",
        platform,
        reason: "booted and stayed alive",
        checks: [makeBootCheck({ id: "runtime-alive", description: "stayed alive", passed: true })],
        evidence: [],
      });
    },
  };
}

describe("runBootTest orchestrator", () => {
  it("turns a capability miss into a SKIPPED verdict and never runs boot", async () => {
    let booted = false;
    const adapter: BootAdapter = {
      platform: "ios",
      capabilityProbe: async () => ({ ok: false, reason: "Xcode not installed on this host" }),
      boot: async () => {
        booted = true;
        throw new Error("must not run");
      },
    };
    const exec = makeFakeExec();
    const verdict = await runBootTest({ workspace: WS, platform: "ios", exec, adapters: [adapter] });
    expect(booted).toBe(false);
    expect(verdict.status).toBe("skipped");
    expect(verdict.status).not.toBe("fail");
    expect(verdict.reason).toContain("Xcode not installed");
    expect(verdict.checks[0]?.skipped).toBe(true);
  });

  it("maps an adapter crash to a FAIL verdict instead of throwing", async () => {
    const adapter: BootAdapter = {
      platform: "backend",
      capabilityProbe: async () => ({ ok: true }),
      boot: async () => {
        throw new Error("harness exploded");
      },
    };
    const verdict = await runBootTest({ workspace: WS, platform: "backend", exec: makeFakeExec(), adapters: [adapter] });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("launch-failed");
    expect(verdict.reason).toContain("harness exploded");
  });

  it("stamps duration + evidence dir and writes verdict.json", async () => {
    const exec = makeFakeExec();
    const adapter = passAdapter("backend", {
      onBoot: () => void exec.sleep(1_234),
    });
    const verdict = await runBootTest({ workspace: WS, platform: "backend", exec, adapters: [adapter], runId: "boot-test" });
    expect(verdict.status).toBe("pass");
    expect(verdict.durationMs).toBe(1_234);
    expect(verdict.evidenceDir).toBe("/ws/.tanya/runtime/boot-test");
    const writtenPaths = Object.keys(exec.written);
    expect(writtenPaths).toContain("/ws/.tanya/runtime/boot-test/verdict.json");
    expect(JSON.parse(exec.written["/ws/.tanya/runtime/boot-test/verdict.json"] ?? "{}").status).toBe("pass");
  });

  it("normalizes landing to the web adapter", async () => {
    const verdict = await runBootTest({
      workspace: WS,
      platform: "landing",
      exec: makeFakeExec(),
      adapters: [passAdapter("web")],
    });
    expect(verdict.platform).toBe("web");
    expect(verdict.status).toBe("pass");
  });

  it("rejects an unknown platform with a usage error", async () => {
    await expect(
      runBootTest({ workspace: WS, platform: "vr-headset", exec: makeFakeExec(), adapters: [] }),
    ).rejects.toBeInstanceOf(RuntimeUsageError);
  });

  it("rejects an undetectable workspace with a usage error", async () => {
    await expect(
      runBootTest({ workspace: WS, exec: makeFakeExec(), adapters: [passAdapter("backend")] }),
    ).rejects.toBeInstanceOf(RuntimeUsageError);
  });

  it("autodetects the platform when none is given", async () => {
    const exec = makeFakeExec({
      files: { "/ws/package.json": JSON.stringify({ dependencies: { express: "4.0.0" } }) },
    });
    const messages: string[] = [];
    const verdict = await runBootTest({
      workspace: WS,
      exec,
      adapters: [passAdapter("backend")],
      emit: (message) => messages.push(message),
    });
    expect(verdict.platform).toBe("backend");
    expect(messages.some((message) => message.includes("detected platform: backend"))).toBe(true);
  });
});
