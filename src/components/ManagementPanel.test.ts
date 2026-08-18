import { describe, expect, it } from "vitest";

import { managementSection, managementSectionIds } from "./ManagementPanel";

describe("settings navigation", () => {
  it("exposes About as a first-class settings section", () => {
    expect(managementSectionIds).toContain("about");
    expect(managementSection("about")).toBe("about");
  });

  it("keeps host navigation outside the settings section list", () => {
    expect(managementSection("hosts")).toBe("settings");
  });
});
