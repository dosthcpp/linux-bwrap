import { describe, expect, it } from "vitest";
import { SANDBOX_HOME, SANDBOX_PATH, sandboxEnvironment } from "./sandbox-environment.js";

describe("sandbox child environment", () => {
  it("replaces host HOME paths with a writable namespace-local home", () => {
    const environment = sandboxEnvironment({
      HOME: "/Users/tony",
      PATH: "/usr/bin:/bin",
      PAPERCLIP_RUN_ID: "run-1",
    });

    expect(environment).toMatchObject({
      HOME: SANDBOX_HOME,
      PATH: SANDBOX_PATH,
      PAPERCLIP_RUN_ID: "run-1",
    });
    expect(environment.HOME).not.toBe("/Users/tony");
    expect(environment.PATH).not.toContain("/Users/tony");
  });

  it("bypasses the egress proxy only for the run-owned Paperclip bridge", () => {
    const environment = sandboxEnvironment({
      PAPERCLIP_API_BRIDGE_MODE: "http2_v1",
      PAPERCLIP_API_URL: "http://127.0.0.1:50025",
      NO_PROXY: "*",
      no_proxy: "*",
    });

    expect(environment.NO_PROXY).toBe("127.0.0.1:50025");
    expect(environment.no_proxy).toBe("127.0.0.1:50025");
  });

  it("keeps the proxy mandatory when no approved Paperclip bridge is present", () => {
    const environment = sandboxEnvironment({
      PAPERCLIP_API_URL: "http://192.168.1.6:8020/v1",
      NO_PROXY: "*",
      no_proxy: "*",
    });

    expect(environment.NO_PROXY).toBe("");
    expect(environment.no_proxy).toBe("");
  });
});
