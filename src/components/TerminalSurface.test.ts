import { describe, expect, it, vi } from "vitest";

import {
  escapeCompletionPath,
  filterSshBridgeDisplay,
  focusTerminalSurface,
  incompleteControlTail,
  nextAutocompleteWord,
  parseConnectionLogs,
  parseTerminalMetadata,
  shouldStartTerminal,
  terminalAutocompletePopupPosition,
  terminalFont,
  terminalContextMenuPosition,
  terminalPastePayload,
  updateInputBuffer,
  type SSHDisplayFilterState,
} from "./TerminalSurface";
import type { AutocompleteSuggestion } from "../terminalAutocomplete";

function ssh2Control(status: string, message: string) {
  return `\u001e[ssh2:${status}] ${message}\u001f`;
}

describe("terminal focus", () => {
  it("ignores a missing cached terminal without scheduling delayed focus", () => {
    expect(focusTerminalSurface("session")).toBe(false);
  });
});

describe("autocomplete popup placement", () => {
  it("keeps cascading panels inside the terminal and flips above", () => {
    expect(
      terminalAutocompletePopupPosition(
        { left: 760, top: 480, lineHeight: 18 },
        800,
        520,
        1,
        true,
      ),
    ).toEqual({ left: 8, top: 226 });
  });
});

describe("terminal remounting", () => {
  it("starts only new terminal runtimes, not cached remounts", () => {
    expect(shouldStartTerminal(false)).toBe(true);
    expect(shouldStartTerminal(true)).toBe(false);
  });
});

describe("Swift-compatible terminal context menu", () => {
  it("keeps the menu inside the viewport", () => {
    expect(
      terminalContextMenuPosition(990, 790, 190, 116, 1000, 800),
    ).toEqual({ left: 802, top: 676 });
    expect(
      terminalContextMenuPosition(-20, -10, 190, 116, 1000, 800),
    ).toEqual({ left: 8, top: 8 });
  });

  it("wraps pasted text only when bracketed paste is active", () => {
    expect(terminalPastePayload("echo test", false)).toBe("echo test");
    expect(terminalPastePayload("echo test", true)).toBe(
      "\u001b[200~echo test\u001b[201~",
    );
  });
});

describe("terminal metadata", () => {
  it("parses OSC titles, current directories, and encoded paths", () => {
    expect(
      parseTerminalMetadata(
        "\u001b]0;deploy\u0007\u001b]7;file://server/home/user/My%20App\u001b\\",
      ),
    ).toEqual({
      title: "deploy",
      workingDirectory: "/home/user/My App",
    });
  });

  it("retains incomplete OSC and bridge records for the next chunk", () => {
    expect(incompleteControlTail("output\u001b]0;partial")).toBe(
      "\u001b]0;partial",
    );
    expect(incompleteControlTail("output\u001e[ssh2:ready] connected")).toBe(
      "\u001e[ssh2:ready] connected",
    );
    expect(incompleteControlTail("output\u001e[ssh")).toBe("\u001e[ssh");
  });

  it("extracts structured bridge connection logs", () => {
    expect(
      parseConnectionLogs(
        ssh2Control("ready", 'Connected {"server":"OpenSSH"}') +
          ssh2Control(
            "connected",
            "Interactive shell channel established",
          ),
      ),
    ).toEqual([
      {
        status: "ready",
        message: "Connected",
        detail: '{"server":"OpenSSH"}',
      },
      {
        status: "connected",
        message: "Interactive shell channel established",
        detail: undefined,
      },
    ]);
  });

  it("parses latency control records for transient RTT state", () => {
    expect(
      parseConnectionLogs(
        ssh2Control("latency", "386") +
          ssh2Control("latency-unavailable", "unavailable"),
      ),
    ).toEqual([
      { status: "latency", message: "386", detail: undefined },
      {
        status: "latency-unavailable",
        message: "unavailable",
        detail: undefined,
      },
    ]);
  });
});

describe("SSH bridge display filtering", () => {
  it("hides log lines split across output chunks", () => {
    const state: SSHDisplayFilterState = {
      pending: "",
      filteringControlRecord: false,
    };

    expect(filterSshBridgeDisplay("visible\u001e[ssh", state)).toBe(
      "visible",
    );
    expect(
      filterSshBridgeDisplay(
        "2:ready] Connected\u001fprompt$ ",
        state,
      ),
    ).toBe("prompt$ ");
  });

  it("hides control frames without removing adjacent terminal output", () => {
    const state: SSHDisplayFilterState = {
      pending: "",
      filteringControlRecord: false,
    };
    expect(
      filterSshBridgeDisplay(
        ssh2Control("broker", "Starting broker") +
          "shell output\n" +
          ssh2Control("cwd", "/root") +
          "prompt# ",
        state,
      ),
    ).toBe("shell output\nprompt# ");
  });

  it("renders a continuous command's trailing CRLF immediately", () => {
    const state: SSHDisplayFilterState = {
      pending: "",
      filteringControlRecord: false,
    };
    const output = "64 bytes from 1.1.1.1: time=0.5 ms\r\n";

    expect(filterSshBridgeDisplay(output, state)).toBe(output);
    expect(state.pending).toBe("");
    expect(
      filterSshBridgeDisplay(ssh2Control("latency", "386"), state),
    ).toBe("");
  });

});

describe("terminal font selection", () => {
  it("prefers Swift-compatible Nerd Fonts in automatic mode", () => {
    const automatic = terminalFont("auto");
    expect(automatic.indexOf('"MesloLGS NF"')).toBeLessThan(
      automatic.indexOf('"SFMono-Regular"'),
    );
    expect(automatic).toContain("monospace");
  });

  it("uses the selected family before the monospace fallback", () => {
    expect(terminalFont("JetBrains Mono")).toBe(
      '"JetBrains Mono", monospace',
    );
  });
});

describe("terminal input tracking", () => {
  it("tracks Unicode input and shell editing controls", () => {
    const input = { current: "" };
    const suggestions = {
      current: [] as AutocompleteSuggestion[],
    };
    const setSuggestions = vi.fn();

    updateInputBuffer(
      "echo 你好",
      input,
      suggestions,
      setSuggestions,
      true,
      ["echo 你好世界"],
    );
    expect(input.current).toBe("echo 你好");
    expect(suggestions.current.map((item) => item.text)).toEqual([
      "echo 你好世界",
    ]);

    updateInputBuffer(
      "\u0017",
      input,
      suggestions,
      setSuggestions,
      true,
      [],
    );
    expect(input.current).toBe("echo");

    updateInputBuffer(
      "\u0015",
      input,
      suggestions,
      setSuggestions,
      true,
      [],
    );
    expect(input.current).toBe("");
  });

  it("accepts one ghost-text word with modified ArrowRight", () => {
    expect(nextAutocompleteWord(" status --short")).toBe(" status ");
    expect(nextAutocompleteWord("--amend")).toBe("--amend");
  });
});

describe("path completion quoting", () => {
  it("quotes POSIX and PowerShell paths only when needed", () => {
    expect(escapeCompletionPath("src/main.ts", false)).toBe("src/main.ts");
    expect(escapeCompletionPath("My App/config", false)).toBe(
      "'My App/config'",
    );
    expect(escapeCompletionPath("John's App", false)).toBe(
      "'John'\\''s App'",
    );
    expect(escapeCompletionPath("John's App", true)).toBe(
      "'John''s App'",
    );
  });
});
