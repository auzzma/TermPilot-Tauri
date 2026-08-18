import { describe, expect, it } from "vitest";

import {
  initialSidebarWidth,
  swiftSidebarIdealWidth,
} from "./App";

describe("Swift-compatible left sidebar sizing", () => {
  it("uses the Swift ideal width for fresh installs and the old default", () => {
    expect(initialSidebarWidth(null)).toBe(swiftSidebarIdealWidth);
    expect(initialSidebarWidth("")).toBe(swiftSidebarIdealWidth);
    expect(initialSidebarWidth("238")).toBe(swiftSidebarIdealWidth);
  });

  it("preserves custom widths inside the Swift-supported range", () => {
    expect(initialSidebarWidth("320")).toBe(320);
    expect(initialSidebarWidth("100")).toBe(230);
    expect(initialSidebarWidth("500")).toBe(380);
  });
});
