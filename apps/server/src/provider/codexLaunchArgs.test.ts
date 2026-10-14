import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("Codex managed delegation", () => {
  it("removes native feature enables before appending config denials", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs("--enable multi_agent -c features.multi_agent_v2=true", "t3-managed"),
      [
        "app-server",
        "-c",
        "features.multi_agent_v2=true",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.multi_agent_v2=false",
      ],
    );
  });

  it.each([
    ["--enable multi_agent", []],
    ["--enable=multi_agent_v2", []],
    [
      "--enable multi_agent --enable multi_agent_v2 --enable shell_tool",
      ["--enable", "shell_tool"],
    ],
    [
      "--enable multi_agent,shell_tool,multi_agent_v2",
      ["--enable", "multi_agent,shell_tool,multi_agent_v2"],
    ],
    ["--enable=shell_tool,multi_agent_v2,js_repl", ["--enable=shell_tool,multi_agent_v2,js_repl"]],
    [
      "--disable multi_agent --enable shell_tool",
      ["--disable", "multi_agent", "--enable", "shell_tool"],
    ],
  ])(
    "blocks native agent enables and preserves unrelated feature controls: %s",
    (launchArgs, preserved) => {
      NodeAssert.deepStrictEqual(codexAppServerArgs(launchArgs as string, "t3-managed"), [
        "app-server",
        ...preserved,
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.multi_agent_v2=false",
      ]);
    },
  );

  it("preserves explicit native feature enables in native-preferred mode", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(
        "--enable=multi_agent --enable multi_agent_v2 --enable shell_tool",
        "native-preferred",
      ),
      [
        "app-server",
        "--enable=multi_agent",
        "--enable",
        "multi_agent_v2",
        "--enable",
        "shell_tool",
      ],
    );
  });

  it("preserves caller controls in native-preferred mode", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--disable multi_agent", "native-preferred"), [
      "app-server",
      "--disable",
      "multi_agent",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
