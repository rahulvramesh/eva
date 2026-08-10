import { describe, expect, it } from "vitest";
import { nextOccurrence } from "./reminders";

describe("reminder recurrence", () => {
  it("keeps the same wall-clock time across daylight saving changes", () => {
    expect(nextOccurrence("2026-03-07T14:00:00.000Z", "America/New_York", "daily"))
      .toBe("2026-03-08T13:00:00.000Z");
  });

  it("advances weekly reminders in their configured timezone", () => {
    expect(nextOccurrence("2026-08-10T02:00:00.000Z", "Asia/Jakarta", "weekly"))
      .toBe("2026-08-17T02:00:00.000Z");
  });

  it("clamps monthly reminders to the final day of a shorter month", () => {
    expect(nextOccurrence("2026-01-31T02:00:00.000Z", "Asia/Jakarta", "monthly"))
      .toBe("2026-02-28T02:00:00.000Z");
  });

  it("completes one-time reminders", () => {
    expect(nextOccurrence("2026-08-10T02:00:00.000Z", "UTC", "none")).toBeNull();
  });
});
