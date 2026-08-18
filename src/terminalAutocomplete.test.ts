import { describe, expect, it } from "vitest";

import {
  commandFromTerminalPrompt,
  historyAutocompleteSuggestions,
  isTerminalPrompt,
  mergeAutocompleteSuggestions,
  parseAutocompleteCommandLine,
  replaceAutocompleteWord,
} from "./terminalAutocomplete";

describe("Swift-compatible autocomplete command parsing", () => {
  it("preserves quoted words and strips executable extensions", () => {
    const context = parseAutocompleteCommandLine(
      'C:\\Tools\\GIT.EXE commit -m "hello world" --a',
    );
    expect(context.commandName).toBe("git");
    expect(context.currentWord).toBe("--a");
    expect(context.wordIndex).toBe(4);
    expect(replaceAutocompleteWord(context, "--amend")).toBe(
      'C:\\Tools\\GIT.EXE commit -m "hello world" --amend',
    );
  });

  it("detects shell prompts but rejects REPL and password prompts", () => {
    expect(isTerminalPrompt("alice@example:~$ ")).toBe(true);
    expect(isTerminalPrompt("~/project ❯ git")).toBe(true);
    expect(isTerminalPrompt("mysql> ")).toBe(false);
    expect(isTerminalPrompt("Password: ")).toBe(false);
    expect(commandFromTerminalPrompt("alice@example:~$ git status")).toBe(
      "git status",
    );
  });
});

describe("Swift-compatible autocomplete ranking", () => {
  it("ranks history before specs and removes duplicate commands", () => {
    const history = historyAutocompleteSuggestions(
      "git",
      ["git status", "git status", "git stash"],
    );
    const merged = mergeAutocompleteSuggestions([
      history,
      [
        {
          text: "git status",
          displayText: "status",
          source: "subcommand",
          score: 800,
        },
        {
          text: "git switch",
          displayText: "switch",
          source: "subcommand",
          score: 800,
        },
      ],
    ]);
    expect(merged.map((suggestion) => suggestion.text)).toEqual([
      "git status",
      "git stash",
      "git switch",
    ]);
    expect(merged[0]?.frequency).toBe(2);
  });

  it("keeps up to 24 path suggestions like Swift", () => {
    const paths = Array.from({ length: 20 }, (_, index) => ({
      text: `cat file-${index}`,
      displayText: `file-${index}`,
      source: "path" as const,
      score: 750,
    }));
    expect(mergeAutocompleteSuggestions([paths], 8)).toHaveLength(20);
  });
});
