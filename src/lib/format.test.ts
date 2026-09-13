import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatDate, formatDateTime } from "./format";

describe("US date formatting", () => {
  test("places the month before the day", () => {
    assert.equal(formatDate("2026-09-10T04:29:00Z"), "09/10/2026");
    assert.equal(formatDate("2026-10-09T04:29:00Z"), "10/09/2026");
  });

  test("includes leading zeroes and UTC time", () => {
    assert.equal(formatDateTime("2026-09-03T04:09:00Z"), "09/03/2026 04:09 UTC");
  });

  test("uses a dash when no date is available", () => {
    assert.equal(formatDate(null), "—");
    assert.equal(formatDateTime(null), "—");
  });
});