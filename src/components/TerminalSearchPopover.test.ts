import { describe, expect, it } from "vitest";

import { terminalSearchPopoverPosition } from "./TerminalSearchPopover";

describe("Swift-compatible terminal search popover", () => {
  it("centers below the search button when space is available", () => {
    expect(
      terminalSearchPopoverPosition(
        { left: 700, right: 724, top: 12, bottom: 36, width: 24 },
        284,
        92,
        1000,
        800,
      ),
    ).toEqual({
      left: 570,
      top: 48,
      arrowLeft: 142,
      placement: "bottom",
    });
  });

  it("stays inside the window and flips above near the bottom edge", () => {
    expect(
      terminalSearchPopoverPosition(
        { left: 2, right: 26, top: 760, bottom: 784, width: 24 },
        284,
        92,
        1000,
        800,
      ),
    ).toEqual({
      left: 8,
      top: 656,
      arrowLeft: 20,
      placement: "top",
    });
  });
});
