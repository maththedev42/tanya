import { describe, expect, it } from "vitest";
import { detectPlatform } from "../../src/runtime/detect";
import { makeFakeExec } from "./fakeExec";

const WS = "/ws";

function detect(files: Record<string, string>) {
  return detectPlatform(makeFakeExec({ files }), WS);
}

describe("runtime platform detection", () => {
  it("detects ios from project.yml (xcodegen)", () => {
    expect(detect({ "/ws/project.yml": "name: App\ntargets:\n  App:\n    platform: iOS\n" })?.platform).toBe("ios");
  });

  it("detects macos from a macOS-only project.yml", () => {
    expect(detect({ "/ws/project.yml": "name: Tool\ntargets:\n  Tool:\n    platform: macOS\n" })?.platform).toBe("macos");
  });

  it("prefers ios when project.yml declares both platforms", () => {
    expect(
      detect({ "/ws/project.yml": "targets:\n  A:\n    platform: iOS\n  B:\n    platform: macOS\n" })?.platform,
    ).toBe("ios");
  });

  it("detects macos from an xcodeproj with SDKROOT = macosx", () => {
    expect(
      detect({ "/ws/App.xcodeproj/project.pbxproj": "buildSettings = { SDKROOT = macosx; };" })?.platform,
    ).toBe("macos");
  });

  it("detects ios from an xcodeproj with SDKROOT = iphoneos", () => {
    expect(
      detect({ "/ws/App.xcodeproj/project.pbxproj": "buildSettings = { SDKROOT = iphoneos; };" })?.platform,
    ).toBe("ios");
  });

  it("detects android from gradlew + settings.gradle.kts", () => {
    expect(
      detect({ "/ws/gradlew": "#!/bin/sh", "/ws/settings.gradle.kts": "include(\":app\")" })?.platform,
    ).toBe("android");
  });

  it("detects web from frontend dependencies, even with a backend dep present", () => {
    expect(
      detect({
        "/ws/package.json": JSON.stringify({ dependencies: { next: "15.0.0", express: "4.0.0" } }),
      })?.platform,
    ).toBe("web");
  });

  it("detects web from a static index.html without package.json", () => {
    expect(detect({ "/ws/index.html": "<html><body>hi</body></html>" })?.platform).toBe("web");
  });

  it("detects backend from go.mod with a cmd main package", () => {
    const detected = detect({
      "/ws/go.mod": "module example.com/svc\n",
      "/ws/cmd/server/main.go": "package main\nfunc main() {}\n",
    });
    expect(detected?.platform).toBe("backend");
    expect(detected?.evidence).toContain("./cmd/server");
  });

  it("does not claim a go library without a main package", () => {
    expect(detect({ "/ws/go.mod": "module example.com/lib\n", "/ws/lib.go": "package lib\n" })).toBeNull();
  });

  it("prefers a server-like go cmd over alphabetically-earlier batch tools", () => {
    const detected = detect({
      "/ws/go.mod": "module example.com/svc\n",
      "/ws/cmd/build-corpus-rollups/main.go": "package main\nfunc main() {}\n",
      "/ws/cmd/server/main.go": "package main\nfunc main() {}\n",
    });
    expect(detected?.evidence).toContain("./cmd/server");
  });

  it("detects backend from node server dependencies", () => {
    expect(
      detect({ "/ws/package.json": JSON.stringify({ dependencies: { express: "4.0.0" } }) })?.platform,
    ).toBe("backend");
  });

  it("detects script from a package.json bin field", () => {
    expect(
      detect({ "/ws/package.json": JSON.stringify({ name: "tool", bin: { tool: "dist/cli.js" } }) })?.platform,
    ).toBe("script");
  });

  it("falls back to backend for a bare start script", () => {
    expect(
      detect({ "/ws/package.json": JSON.stringify({ scripts: { start: "node server.js" } }) })?.platform,
    ).toBe("backend");
  });

  it("returns null for an empty workspace", () => {
    expect(detect({})).toBeNull();
  });
});
