import { describe, expect, test } from "bun:test";

import { formatDate, formatDateTime } from "./format";

describe("US date formatting", () => {
  test("places the month before the day", () => {
    expect(formatDate("2026-09-10T04:29:00Z")).toBe("09/10/2026");
    expect(formatDate("2026-10-09T04:29:00Z")).toBe("10/09/2026");
  });

  test("includes leading zeroes and UTC time", () => {
    expect(formatDateTime("2026-09-03T04:09:00Z")).toBe("09/03/2026 04:09 UTC");
  });

  test("uses a dash when no date is available", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
  });
});