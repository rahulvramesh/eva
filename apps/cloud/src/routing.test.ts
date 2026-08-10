import { describe, expect, it } from "vitest";
import { isPrivateCapableModel, shouldRouteToDevice } from "./routing";

describe("hybrid routing", () => {
  it("keeps ordinary auto turns in cloud and routes file work to an online device", () => {
    expect(shouldRouteToDevice("auto", "Explain quantum tunnelling", true, false)).toBe(false);
    expect(shouldRouteToDevice("auto", "Inspect the files in my repository", true, false)).toBe(true);
    expect(shouldRouteToDevice("auto", "Inspect the files in my repository", false, false)).toBe(false);
  });

  it("honors explicit host choices and a selected Pi device model", () => {
    expect(shouldRouteToDevice("cloud", "Run bash", true, false)).toBe(false);
    expect(shouldRouteToDevice("device", "Hello", true, false)).toBe(true);
    expect(shouldRouteToDevice("auto", "Hello", true, true)).toBe(true);
  });

  it("only calls verified on-device inference private-capable", () => {
    expect(isPrivateCapableModel({ localInference: true })).toBe(true);
    expect(isPrivateCapableModel({ localInference: false })).toBe(false);
    expect(isPrivateCapableModel(undefined)).toBe(false);
  });
});
