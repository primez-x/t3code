import { describe, expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";

const decodeWindow = Schema.decodeUnknownSync(ServerProviderUsageWindow);
const sharedWindow = { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 50 };

describe("ServerProviderUsageWindow", () => {
  test("preserves and trims an explicit model family", () => {
    expect(decodeWindow({ ...sharedWindow, modelFamily: " claude-opus " })).toEqual({
      ...sharedWindow,
      modelFamily: "claude-opus",
    });
  });

  test("accepts shared windows without a model family", () => {
    expect(decodeWindow(sharedWindow)).toEqual(sharedWindow);
  });

  test("rejects empty model families", () => {
    expect(() => decodeWindow({ ...sharedWindow, modelFamily: " " })).toThrow();
  });
});
