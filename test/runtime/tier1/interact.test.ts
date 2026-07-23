import { describe, expect, it } from "vitest";
import {
  makeAndroidInteractDriver,
  makeIosInteractDriver,
  parseUiautomatorTree,
} from "../../../src/runtime/tier1/interact";
import { makeFakeExec, type RunCall } from "../fakeExec";

const IOS_DESCRIBE_ALL = JSON.stringify([
  { AXLabel: "Calculator", type: "Application", frame: { x: 0, y: 0, width: 402, height: 874 } },
  { AXLabel: "8", type: "StaticText", frame: { x: 322, y: 252, width: 44, height: 86 } },
  { AXLabel: "AC", type: "Button", frame: { x: 16, y: 362, width: 84, height: 80 } },
]);

describe("makeIosInteractDriver", () => {
  const respond =
    (hasIdb: boolean) =>
    (call: RunCall): { exit?: number; stdout?: string } | undefined => {
      if (call.command === "which") return { exit: hasIdb ? 0 : 1 };
      if (call.command === "idb" && call.args[1] === "describe-all") return { exit: 0, stdout: IOS_DESCRIBE_ALL };
      return undefined;
    };

  it("describeUi renders points-space centers from accessibility frames", async () => {
    const exec = makeFakeExec({ respond: respond(true) });
    const driver = await makeIosInteractDriver(exec, "/ws", "UDID-1");
    const tree = await driver.describeUi();
    expect(tree).toContain("Screen: 402x874");
    expect(tree).toContain('Button "AC" center=(58,402) size=84x80');
    expect(tree).toContain('StaticText "8" center=(344,295)');
  });

  it("tap passes tree coordinates (points) straight to idb", async () => {
    const exec = makeFakeExec({ respond: respond(true) });
    const driver = await makeIosInteractDriver(exec, "/ws", "UDID-1");
    await driver.tap(58, 402);
    const tap = exec.calls.find((c) => c.command === "idb" && c.args[1] === "tap");
    expect(tap?.args).toEqual(["ui", "tap", "--udid", "UDID-1", "58", "402"]);
  });

  it("types via `idb ui text` (the real idb subcommand)", async () => {
    const exec = makeFakeExec({ respond: respond(true) });
    const driver = await makeIosInteractDriver(exec, "/ws", "UDID-1");
    await driver.typeText("hello");
    const type = exec.calls.find((c) => c.command === "idb" && c.args[1] === "text");
    expect(type?.args).toEqual(["ui", "text", "--udid", "UDID-1", "hello"]);
  });

  it("without idb: canTap=false, describeUi=null, tap/type are no-ops", async () => {
    const exec = makeFakeExec({ respond: respond(false) });
    const driver = await makeIosInteractDriver(exec, "/ws", "UDID-1");
    expect(driver.canTap).toBe(false);
    expect(await driver.describeUi()).toBeNull();
    await driver.tap(10, 10);
    await driver.typeText("x");
    expect(exec.calls.filter((c) => c.command === "idb")).toHaveLength(0);
  });
});

const ANDROID_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="8" content-desc="" clickable="false" bounds="[800,500][1000,700]" />
    <node class="android.widget.Button" text="AC" content-desc="" clickable="true" bounds="[40,900][290,1100]" />
    <node class="android.view.View" text="" content-desc="Add note" clickable="true" bounds="[900,2100][1040,2240]" />
    <node class="android.widget.LinearLayout" text="" content-desc="" clickable="false" bounds="[0,0][1080,100]" />
  </node>
</hierarchy>`;

describe("parseUiautomatorTree", () => {
  it("keeps labeled and clickable nodes with pixel centers, drops silent containers", () => {
    const tree = parseUiautomatorTree(ANDROID_DUMP);
    expect(tree).toContain("Screen: 1080x2400");
    expect(tree).toContain('TextView "8" center=(900,600)');
    expect(tree).toContain('Button "AC" center=(165,1000) size=250x200 [clickable]');
    expect(tree).toContain('View "Add note" center=(970,2170)');
    expect(tree).not.toContain("LinearLayout");
  });

  it("returns null for non-hierarchy output", () => {
    expect(parseUiautomatorTree("ERROR: could not get idle state.")).toBeNull();
  });
});

describe("makeAndroidInteractDriver", () => {
  it("describeUi = uiautomator dump + cat + rm", async () => {
    const exec = makeFakeExec({
      respond: (call) =>
        call.command === "adb" && call.args.includes("cat") ? { exit: 0, stdout: ANDROID_DUMP } : undefined,
    });
    const driver = makeAndroidInteractDriver(exec, "/ws", "emulator-5554");
    const tree = await driver.describeUi();
    expect(tree).toContain('Button "AC"');
    const commands = exec.calls.map((c) => c.args.filter((a) => a !== "-s" && a !== "emulator-5554").join(" "));
    expect(commands[0]).toBe("shell uiautomator dump /sdcard/tanya-ui.xml");
    expect(commands[1]).toBe("shell cat /sdcard/tanya-ui.xml");
    expect(commands[2]).toBe("shell rm -f /sdcard/tanya-ui.xml");
  });

  it("taps in raw pixels with the serial pinned", async () => {
    const exec = makeFakeExec();
    const driver = makeAndroidInteractDriver(exec, "/ws", "emulator-5554");
    expect(driver.canTap).toBe(true);
    await driver.tap(540.4, 1200.6);
    expect(exec.calls[0]?.args).toEqual(["-s", "emulator-5554", "shell", "input", "tap", "540", "1201"]);
  });

  it("escapes spaces and quotes for `input text`", async () => {
    const exec = makeFakeExec();
    const driver = makeAndroidInteractDriver(exec, "/ws", null);
    await driver.typeText("it's a test");
    expect(exec.calls[0]?.args).toEqual(["shell", "input", "text", `'it'\\''s%sa%stest'`]);
  });

  it("screenshot = screencap + pull + cleanup, true only when the file landed", async () => {
    const exec = makeFakeExec({ files: { "/ev/shot.png": "png" } });
    const driver = makeAndroidInteractDriver(exec, "/ws", "emulator-5554");
    expect(await driver.screenshot("/ev/shot.png")).toBe(true);
    const commands = exec.calls.map((c) => c.args.filter((a) => a !== "-s" && a !== "emulator-5554").join(" "));
    expect(commands[0]).toBe("shell screencap -p /sdcard/tanya-tier1.png");
    expect(commands[1]).toBe("pull /sdcard/tanya-tier1.png /ev/shot.png");
    expect(commands[2]).toBe("shell rm -f /sdcard/tanya-tier1.png");
  });

  it("screenshot returns false when the pull produced no file", async () => {
    const exec = makeFakeExec();
    const driver = makeAndroidInteractDriver(exec, "/ws", null);
    expect(await driver.screenshot("/ev/missing.png")).toBe(false);
  });
});
