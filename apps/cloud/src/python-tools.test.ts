import { describe, expect, it } from "vitest";
import { formatPythonExecution } from "./python-output";

describe("Python tool output", () => {
  it("combines stdout and a rich text result", () => {
    expect(formatPythonExecution({
      code: "print('ready')\n6 * 7",
      logs: { stdout: ["ready"], stderr: [] },
      results: [{ text: "42" }],
      executionCount: 2,
    })).toBe("ready\n\n42");
  });

  it("surfaces interpreter errors with their traceback", () => {
    const output = formatPythonExecution({
      code: "1 / 0",
      logs: { stdout: [], stderr: [] },
      results: [],
      error: { name: "ZeroDivisionError", message: "division by zero", traceback: ["Traceback", "ZeroDivisionError"] },
    });
    expect(output).toContain("ZeroDivisionError: division by zero");
    expect(output).toContain("Traceback");
  });
});
