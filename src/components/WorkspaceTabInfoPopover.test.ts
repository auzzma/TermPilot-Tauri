import { describe, expect, it } from "vitest";

import { workspaceTabInfoPopoverPosition } from "./WorkspaceTabInfoPopover";

describe("Swift-compatible workspace tab info popover", () => {
  it("centers below the tab and stays inside the viewport", () => {
    expect(
      workspaceTabInfoPopoverPosition(
        { left: 900, right: 1072, top: 4, bottom: 36, width: 172 },
        220,
        50,
        1000,
        800,
      ),
    ).toEqual({ left: 774, top: 42, placement: "bottom" });
  });

  it("flips above the tab near the bottom edge", () => {
    expect(
      workspaceTabInfoPopoverPosition(
        { left: 300, right: 472, top: 740, bottom: 772, width: 172 },
        220,
        50,
        1000,
        780,
      ),
    ).toEqual({ left: 276, top: 684, placement: "top" });
  });
});
