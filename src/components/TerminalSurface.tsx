import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import {
  Clipboard,
  ClipboardPaste,
  Copy,
  KeyRound,
  RefreshCw,
  Search,
  TextCursorInput,
  UserRoundKey,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";

import { useTranslation } from "../i18n";
import {
  assistedPasswordCommand,
  makePasswordPromptRequest,
  PasswordPromptDetector,
  passwordPromptCandidates,
  passwordPromptCommandKind,
  type PasswordPromptCandidate,
  type PasswordPromptRequest,
} from "../passwordPromptAssist";
import { useAppStore } from "../store";
import {
  historyAutocompleteSuggestions,
  isTerminalPrompt,
  mergeAutocompleteSuggestions,
  parseAutocompleteCommandLine,
  sourceBadge,
  type AutocompleteSpecResult,
  type AutocompleteSuggestion,
} from "../terminalAutocomplete";
import type {
  Host,
  SessionDescriptor,
  TerminalExitEvent,
  TerminalOutputEvent,
} from "../types";
import { TerminalSearchPopover } from "./TerminalSearchPopover";

interface TerminalSurfaceProps {
  session: SessionDescriptor;
  active: boolean;
}

interface TerminalErrorEvent {
  sessionId: string;
  message: string;
}

interface TerminalLaunch {
  sessionId: string;
  program: string;
  arguments: string[];
  workingDirectory?: string;
  columns: number;
  rows: number;
  environment: Record<string, string>;
}

interface CachedTerminalSurface {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
}

interface TerminalContextMenuState {
  x: number;
  y: number;
  selection: string;
}

interface AutocompleteSubdirectoryPanel {
  suggestions: AutocompleteSuggestion[];
  selectedIndex: number;
}

const terminalSurfaceCache = new Map<string, CachedTerminalSurface>();

export function disposeTerminalSurface(sessionId: string) {
  const cached = terminalSurfaceCache.get(sessionId);
  if (!cached) return;
  cached.terminal.dispose();
  terminalSurfaceCache.delete(sessionId);
}

export function focusTerminalSurface(sessionId: string) {
  const cached = terminalSurfaceCache.get(sessionId);
  if (!cached?.terminal.element?.isConnected) return false;
  cached.terminal.focus();
  return true;
}

export function shouldStartTerminal(cacheHit: boolean) {
  return !cacheHit;
}

export interface SSHDisplayFilterState {
  pending: string;
  filteringControlRecord: boolean;
}

const SSH2_CONTROL_START = "\u001e[ssh2:";
const SSH2_CONTROL_END = "\u001f";

function TerminalSurfaceView({ session, active }: TerminalSurfaceProps) {
  const t = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const terminalRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const searchRef = useRef<SearchAddon>();
  const inputRef = useRef("");
  const suggestionsRef = useRef<AutocompleteSuggestion[]>([]);
  const suggestionGenerationRef = useRef(0);
  const suggestionTimerRef = useRef<number>();
  const suggestionIndexRef = useRef(-1);
  const previewBaselineRef = useRef("");
  const subdirectoryGenerationRef = useRef(0);
  const subdirectoryPanelsRef = useRef<AutocompleteSubdirectoryPanel[]>([]);
  const subdirectoryFocusLevelRef = useRef(-1);
  const promptConfirmedRef = useRef(false);
  const currentDirectoryRef = useRef(session.workingDirectory);
  const decoderRef = useRef(new TextDecoder());
  const controlTailRef = useRef("");
  const sshDisplayFilterRef = useRef<SSHDisplayFilterState>({
    pending: "",
    filteringControlRecord: false,
  });
  const passwordDetectorRef = useRef(new PasswordPromptDetector());
  const passwordInputActiveRef = useRef(false);
  const passwordSelectedIndexRef = useRef(0);
  const passwordPromptRef = useRef<PasswordPromptRequest>();
  const passwordCandidatesRef = useRef<PasswordPromptCandidate[]>([]);
  const automaticPasswordRef = useRef<{
    secret: string;
    kind: "sudo" | "su";
    expiresAt: number;
  }>();
  const automaticPasswordTimerRef = useRef<number>();
  const [isBelling, setIsBelling] = useState(false);
  const bellTimeoutRef = useRef<number>();

  const [error, setError] = useState<string>();
  const [suggestions, setSuggestions] = useState<
    AutocompleteSuggestion[]
  >([]);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [hoveredSuggestionIndex, setHoveredSuggestionIndex] = useState(-1);
  const [subdirectoryPanels, setSubdirectoryPanels] = useState<
    AutocompleteSubdirectoryPanel[]
  >([]);
  const [subdirectoryFocusLevel, setSubdirectoryFocusLevel] = useState(-1);
  const [passwordPrompt, setPasswordPrompt] =
    useState<PasswordPromptRequest>();
  const [exited, setExited] = useState(false);
  const [restartToken, setRestartToken] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchSummary, setSearchSummary] = useState("");
  const [contextMenu, setContextMenu] =
    useState<TerminalContextMenuState>();
  const platform = useAppStore((state) => state.platform);
  const hosts = useAppStore((state) => state.hosts);
  const sessionHost = useAppStore(
    (state) => state.sessionHosts[session.id],
  );
  const credentials = useAppStore((state) => state.credentials);
  const proxies = useAppStore((state) => state.proxies);
  const preferences = useAppStore((state) => state.preferences);
  const snippets = useAppStore((state) => state.snippets);
  const scripts = useAppStore((state) => state.scripts);
  const commandHistory = useAppStore((state) => state.commandHistory);
  const setLifecycle = useAppStore((state) => state.setSessionLifecycle);
  const recordCommand = useAppStore((state) => state.recordCommand);
  const updateMetadata = useAppStore(
    (state) => state.updateSessionMetadata,
  );
  const appendConnectionLog = useAppStore(
    (state) => state.appendConnectionLog,
  );
  const setSessionFontSize = useAppStore(
    (state) => state.setSessionFontSize,
  );
  const setSessionLatency = useAppStore(
    (state) => state.setSessionLatency,
  );
  const consumeStartupCommand = useAppStore(
    (state) => state.consumeSessionStartupCommand,
  );
  const beginConnectionHistory = useAppStore(
    (state) => state.beginConnectionHistory,
  );
  const markConnectionConnected = useAppStore(
    (state) => state.markConnectionConnected,
  );
  const finishConnectionHistory = useAppStore(
    (state) => state.finishConnectionHistory,
  );
  const autocompleteSettingsRef = useRef({
    enabled: preferences.autocompleteEnabled,
    popup: preferences.autocompletePopup,
    ghostText: preferences.autocompleteGhostText,
    passwordPromptAssist: preferences.passwordPromptAssist,
  });
  autocompleteSettingsRef.current = {
    enabled: preferences.autocompleteEnabled,
    popup: preferences.autocompletePopup,
    ghostText: preferences.autocompleteGhostText,
    passwordPromptAssist: preferences.passwordPromptAssist,
  };
  const autocompleteCandidatesRef = useRef<string[]>([]);
  autocompleteCandidatesRef.current = [
    ...commonCommands,
    ...commandHistory
      .filter((item) => item.sessionId === session.id)
      .map((item) => item.command),
    ...snippets.map((item) => item.body),
    ...scripts.map((item) => item.title),
  ];
  const host = useMemo(
    () => {
      const source =
        sessionHost ?? hosts.find((item) => item.id === session.hostId);
      if (!source) return undefined;
      const credential = credentials.find(
        (item) => item.id === source.credentialId,
      );
      const proxy = proxies.find((item) => item.id === source.proxyProfileId);
      return {
        ...source,
        username: credential?.username || source.username,
        authentication:
          credential?.kind === "identityKey"
            ? ("identityFile" as const)
            : credential?.kind === "password"
              ? ("password" as const)
              : source.authentication,
        password: credential?.password ?? source.password,
        identityKey: credential?.privateKey ?? source.identityKey,
        publicKey: credential?.publicKey ?? source.publicKey,
        certificate: credential?.certificate ?? source.certificate,
        passphrase: credential?.passphrase ?? source.passphrase,
        elevationPassword:
          source.elevationPassword ?? credential?.elevationPassword,
        proxyConfiguration: proxy?.configuration ?? source.proxyConfiguration,
      };
    },
    [credentials, hosts, proxies, session.hostId, sessionHost],
  );
  const availablePasswordCandidates = useMemo(
    () => passwordPromptCandidates(host, credentials),
    [credentials, host],
  );
  passwordCandidatesRef.current = availablePasswordCandidates;

  useEffect(() => {
    if (
      preferences.passwordPromptAssist === "off" ||
      availablePasswordCandidates.length === 0
    ) {
      passwordPromptRef.current = undefined;
      setPasswordPrompt(undefined);
      passwordInputActiveRef.current = false;
      passwordDetectorRef.current.abort();
      if (automaticPasswordTimerRef.current != null) {
        window.clearTimeout(automaticPasswordTimerRef.current);
        automaticPasswordTimerRef.current = undefined;
      }
      automaticPasswordRef.current = undefined;
      return;
    }
    if (passwordPromptRef.current) {
      const request = makePasswordPromptRequest(
        passwordDetectorRef.current,
        preferences.passwordPromptAssist,
        passwordDetectorRef.current.armedKind ?? "sudo",
        availablePasswordCandidates,
        passwordSelectedIndexRef.current,
      );
      passwordPromptRef.current = request;
      setPasswordPrompt(request);
    }
  }, [
    availablePasswordCandidates,
    preferences.passwordPromptAssist,
  ]);

  useEffect(() => {
    currentDirectoryRef.current = session.workingDirectory;
  }, [session.workingDirectory]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (suggestions.length === 0) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".terminal-autocomplete-layout")
      ) {
        return;
      }
      if (inputRef.current !== previewBaselineRef.current) {
        inputRef.current = previewBaselineRef.current;
        void invoke("terminal_write", {
          sessionId: session.id,
          data: encodeUtf8(`\u0015${previewBaselineRef.current}`),
        });
      }
      suggestionGenerationRef.current += 1;
      suggestionsRef.current = [];
      setSuggestions([]);
      suggestionIndexRef.current = -1;
      setSuggestionIndex(-1);
      setHoveredSuggestionIndex(-1);
      subdirectoryGenerationRef.current += 1;
      subdirectoryPanelsRef.current = [];
      setSubdirectoryPanels([]);
      subdirectoryFocusLevelRef.current = -1;
      setSubdirectoryFocusLevel(-1);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [session.id, suggestions.length]);

  useEffect(() => {
    if (
      preferences.autocompleteEnabled &&
      (preferences.autocompletePopup ||
        preferences.autocompleteGhostText)
    ) {
      return;
    }
    suggestionsRef.current = [];
    setSuggestions([]);
    suggestionIndexRef.current = -1;
    setSuggestionIndex(-1);
  }, [
    preferences.autocompleteEnabled,
    preferences.autocompleteGhostText,
    preferences.autocompletePopup,
  ]);


  useEffect(() => {
    const cached = terminalSurfaceCache.get(session.id);
    if (!cached) return;
    const isLight = document.documentElement.getAttribute("data-theme") === "light" || (document.documentElement.getAttribute("data-theme") !== "dark" && window.matchMedia("(prefers-color-scheme: light)").matches);
    const theme = isLight ? {
      background: "#f6f8fa",
      foreground: "#24292f",
      cursor: "#0969da",
      cursorAccent: "#f6f8fa",
      selectionBackground: "#b2d1ff",
      selectionForeground: "#24292f",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#218bff",
      brightMagenta: "#a371f7",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    } : {
      background: "#0d1117",
      foreground: "#d4d7dc",
      cursor: "#58a6ff",
      cursorAccent: "#0d1117",
      selectionBackground: "#264f78",
      selectionForeground: "#ffffff",
      black: "#0d1117",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    };
    cached.terminal.options.theme = theme;
  }, [preferences.theme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cached = terminalSurfaceCache.get(session.id);
    const cacheHit = Boolean(cached);
    if (!cached) {
      const isLight = document.documentElement.getAttribute("data-theme") === "light" || (document.documentElement.getAttribute("data-theme") !== "dark" && window.matchMedia("(prefers-color-scheme: light)").matches);
      const terminal = createTerminal(
        preferences.terminalFontName,
        session.fontSize,
        isLight
      );
      const fit = new FitAddon();
      const search = new SearchAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(search);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(container);
      cached = { terminal, fit, search };
      terminalSurfaceCache.set(session.id, cached);
    } else if (cached.terminal.element) {
      container.appendChild(cached.terminal.element);
    }
    const { terminal, fit, search } = cached;
    terminal.options.fontFamily = terminalFont(
      preferences.terminalFontName,
    );
    terminal.options.fontSize = session.fontSize;
    fit.fit();
    setExited(session.lifecycle === "exited");
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;
    decoderRef.current = new TextDecoder();
    controlTailRef.current = "";
    sshDisplayFilterRef.current = {
      pending: "",
      filteringControlRecord: false,
    };

    const clearAutocomplete = (restorePreview = false) => {
      if (
        restorePreview &&
        inputRef.current !== previewBaselineRef.current
      ) {
        inputRef.current = previewBaselineRef.current;
        void invoke("terminal_write", {
          sessionId: session.id,
          data: encodeUtf8(`\u0015${previewBaselineRef.current}`),
        });
      }
      suggestionGenerationRef.current += 1;
      suggestionsRef.current = [];
      setSuggestions([]);
      suggestionIndexRef.current = -1;
      setSuggestionIndex(-1);
      setHoveredSuggestionIndex(-1);
      subdirectoryGenerationRef.current += 1;
      subdirectoryPanelsRef.current = [];
      setSubdirectoryPanels([]);
      subdirectoryFocusLevelRef.current = -1;
      setSubdirectoryFocusLevel(-1);
    };
    const updatePasswordPrompt = (
      request: PasswordPromptRequest | undefined,
    ) => {
      passwordPromptRef.current = request;
      setPasswordPrompt(request);
    };
    const clearAutomaticPassword = () => {
      if (automaticPasswordTimerRef.current != null) {
        window.clearTimeout(automaticPasswordTimerRef.current);
        automaticPasswordTimerRef.current = undefined;
      }
      automaticPasswordRef.current = undefined;
    };
    const armAutomaticPassword = (
      secret: string,
      kind: "sudo" | "su",
    ) => {
      clearAutomaticPassword();
      const armed = {
        secret,
        kind,
        expiresAt: Date.now() + 10_000,
      };
      automaticPasswordRef.current = armed;
      automaticPasswordTimerRef.current = window.setTimeout(() => {
        if (automaticPasswordRef.current === armed) {
          automaticPasswordRef.current = undefined;
        }
        automaticPasswordTimerRef.current = undefined;
      }, 10_000);
    };
    const selectPassword = (id?: string) => {
      const request = passwordPromptRef.current;
      const selectedId =
        id ??
        (request &&
        request.items[request.selectedIndex]
          ? request.items[request.selectedIndex]!.id
          : undefined);
      const candidate = passwordCandidatesRef.current.find(
        (item) => item.id === selectedId,
      );
      if (!candidate) {
        updatePasswordPrompt(undefined);
        passwordDetectorRef.current.dismiss();
        return;
      }
      updatePasswordPrompt(undefined);
      passwordInputActiveRef.current = false;
      passwordDetectorRef.current.markFilled();
      void invoke("terminal_write", {
        sessionId: session.id,
        data: encodeUtf8(`${candidate.password}\r`),
      });
      terminal.focus();
    };
    const renderedLine = () =>
      terminal.buffer.active
        .getLine(terminal.buffer.active.cursorY)
        ?.translateToString(true);
    const updateSubdirectoryPanels = (
      panels: AutocompleteSubdirectoryPanel[],
      focusLevel = subdirectoryFocusLevelRef.current,
    ) => {
      subdirectoryPanelsRef.current = panels;
      setSubdirectoryPanels(panels);
      subdirectoryFocusLevelRef.current = focusLevel;
      setSubdirectoryFocusLevel(focusLevel);
    };
    const previewSuggestion = (suggestion: AutocompleteSuggestion) => {
      inputRef.current = suggestion.text;
      void invoke("terminal_write", {
        sessionId: session.id,
        data: encodeUtf8(`\u0015${suggestion.text}`),
      });
    };
    const loadSubdirectory = async (
      suggestion: AutocompleteSuggestion | undefined,
      level: number,
      movesFocus: boolean,
    ) => {
      const generation = ++subdirectoryGenerationRef.current;
      if (!suggestion?.isDirectory) {
        updateSubdirectoryPanels(
          subdirectoryPanelsRef.current.slice(0, level),
          Math.min(subdirectoryFocusLevelRef.current, level - 1),
        );
        return;
      }
      const entries = await pathSuggestions(
        suggestion.text,
        currentDirectoryRef.current,
        host,
        session.id,
      );
      if (generation !== subdirectoryGenerationRef.current) return;
      const panels = subdirectoryPanelsRef.current.slice(0, level);
      if (entries.length > 0) {
        panels.push({
          suggestions: entries,
          selectedIndex: movesFocus ? 0 : -1,
        });
      }
      const focusLevel =
        movesFocus && entries.length > 0
          ? level
          : Math.min(subdirectoryFocusLevelRef.current, level - 1);
      updateSubdirectoryPanels(panels, focusLevel);
      if (movesFocus && entries[0]) previewSuggestion(entries[0]);
    };

    const input = terminal.onData((data) => {
      const generation = ++suggestionGenerationRef.current;
      if (data === "\u0003") {
        passwordDetectorRef.current.abort();
        passwordInputActiveRef.current = false;
        clearAutomaticPassword();
        updatePasswordPrompt(undefined);
        clearAutocomplete();
      }
      if (passwordInputActiveRef.current) {
        clearAutocomplete();
        void invoke("terminal_write", {
          sessionId: session.id,
          data: encodeUtf8(data),
        });
        return;
      }

      const line = renderedLine();
      if ((data === "\r" || data === "\n") && inputRef.current.trim()) {
        recordCommand(session.id, inputRef.current);
        passwordSelectedIndexRef.current = 0;
        passwordDetectorRef.current.arm(inputRef.current);
      } else if (data === "\r" || data === "\n") {
        const recalled = line && assistedPasswordCommand(line);
        if (recalled) {
          passwordSelectedIndexRef.current = 0;
          passwordDetectorRef.current.arm(recalled);
        }
      }
      if (!promptConfirmedRef.current) {
        promptConfirmedRef.current = isTerminalPrompt(line);
      }
      updateInputBuffer(
        data,
        inputRef,
        suggestionsRef,
        setSuggestions,
        autocompleteSettingsRef.current.enabled &&
          promptConfirmedRef.current,
        autocompleteCandidatesRef.current,
      );
      if (data === "\r" || data === "\n" || data === "\u0003") {
        promptConfirmedRef.current = false;
      }
      suggestionIndexRef.current = -1;
      setSuggestionIndex(-1);
      setHoveredSuggestionIndex(-1);
      subdirectoryGenerationRef.current += 1;
      subdirectoryPanelsRef.current = [];
      setSubdirectoryPanels([]);
      subdirectoryFocusLevelRef.current = -1;
      setSubdirectoryFocusLevel(-1);
      previewBaselineRef.current = inputRef.current;
      if (suggestionTimerRef.current != null) {
        window.clearTimeout(suggestionTimerRef.current);
        suggestionTimerRef.current = undefined;
      }
      if (
        autocompleteSettingsRef.current.enabled &&
        promptConfirmedRef.current &&
        inputRef.current.trim().length > 0
      ) {
        const autocompleteInput = inputRef.current;
        suggestionTimerRef.current = window.setTimeout(() => {
          const localSuggestions = historyAutocompleteSuggestions(
            autocompleteInput,
            autocompleteCandidatesRef.current,
          );
          void invoke<AutocompleteSpecResult>("autocomplete_suggestions", {
              input: autocompleteInput,
              maximum: 15,
            })
            .then(async (specResult) => {
              const paths = await pathSuggestions(
                autocompleteInput,
                currentDirectoryRef.current,
                host,
                session.id,
                specResult.pathRequirement,
              );
              if (generation !== suggestionGenerationRef.current) return;
              const merged = mergeAutocompleteSuggestions(
                [
                  localSuggestions,
                  specResult.suggestions,
                  paths,
                ],
                8,
              );
              suggestionsRef.current = merged;
              setSuggestions(merged);
              suggestionIndexRef.current = -1;
              setSuggestionIndex(-1);
              setHoveredSuggestionIndex(-1);
              previewBaselineRef.current = autocompleteInput;
            })
            .catch(() => undefined);
        }, 100);
      }
      void invoke("terminal_write", {
        sessionId: session.id,
        data: encodeUtf8(data),
      });
    });
    const key = terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && passwordInputActiveRef.current) {
        const request = passwordPromptRef.current;
        if (request) {
          if (event.key === "Enter") {
            selectPassword();
            return false;
          }
          if (event.key === "Escape" || event.key === "Backspace") {
            updatePasswordPrompt(undefined);
            passwordDetectorRef.current.dismiss();
            return false;
          }
          if (
            request.presentation === "picker" &&
            (event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            const delta = event.key === "ArrowUp" ? -1 : 1;
            const selectedIndex =
              (request.selectedIndex + delta + request.items.length) %
              request.items.length;
            passwordSelectedIndexRef.current = selectedIndex;
            updatePasswordPrompt({ ...request, selectedIndex });
            return false;
          }
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
            updatePasswordPrompt(undefined);
            passwordDetectorRef.current.dismiss();
          }
        } else if (
          event.key === "Escape" ||
          event.key === "ArrowUp" ||
          event.key === "ArrowDown"
        ) {
          const kind =
            passwordDetectorRef.current.reshowDismissedPrompt();
          if (kind) {
            const reopened = makePasswordPromptRequest(
              passwordDetectorRef.current,
              autocompleteSettingsRef.current.passwordPromptAssist,
              kind,
              passwordCandidatesRef.current,
              passwordSelectedIndexRef.current,
            );
            updatePasswordPrompt(reopened);
            if (
              reopened?.presentation === "picker" &&
              (event.key === "ArrowUp" || event.key === "ArrowDown")
            ) {
              const delta = event.key === "ArrowUp" ? -1 : 1;
              const selectedIndex =
                (reopened.selectedIndex + delta + reopened.items.length) %
                reopened.items.length;
              passwordSelectedIndexRef.current = selectedIndex;
              updatePasswordPrompt({ ...reopened, selectedIndex });
            }
            return false;
          }
        }
        if (event.key === "Enter") {
          passwordInputActiveRef.current = false;
          updatePasswordPrompt(undefined);
          passwordDetectorRef.current.abort();
        }
        return true;
      }
      if (
        event.type === "keydown" &&
        autocompleteSettingsRef.current.popup &&
        subdirectoryFocusLevelRef.current >= 0
      ) {
        const level = subdirectoryFocusLevelRef.current;
        const panel = subdirectoryPanelsRef.current[level];
        if (!panel) {
          updateSubdirectoryPanels(
            subdirectoryPanelsRef.current,
            -1,
          );
          return true;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const count = panel.suggestions.length;
          if (count === 0) return false;
          const delta = event.key === "ArrowUp" ? -1 : 1;
          const selectedIndex =
            panel.selectedIndex < 0
              ? 0
              : (panel.selectedIndex + delta + count) % count;
          const panels = subdirectoryPanelsRef.current
            .slice(0, level + 1)
            .map((item, index) =>
              index === level ? { ...item, selectedIndex } : item,
            );
          updateSubdirectoryPanels(panels, level);
          const selected = panels[level]?.suggestions[selectedIndex];
          if (selected) {
            previewSuggestion(selected);
            void loadSubdirectory(selected, level + 1, false);
          }
          return false;
        }
        if (event.key === "ArrowLeft" || event.key === "Escape") {
          const nextFocus = level - 1;
          updateSubdirectoryPanels(
            subdirectoryPanelsRef.current.slice(0, level + 1),
            nextFocus,
          );
          return false;
        }
        const selected = panel.suggestions[panel.selectedIndex];
        if (event.key === "ArrowRight" && selected?.isDirectory) {
          void loadSubdirectory(selected, level + 1, true);
          return false;
        }
        if (
          (event.key === "Enter" || event.key === "Tab") &&
          selected
        ) {
          const payload = selected.text.startsWith(inputRef.current)
            ? selected.text.slice(inputRef.current.length)
            : `\u0015${selected.text}`;
          inputRef.current = selected.text;
          clearAutocomplete();
          void invoke("terminal_write", {
            sessionId: session.id,
            data: encodeUtf8(payload),
          });
          return false;
        }
      }
      if (
        event.type === "keydown" &&
        autocompleteSettingsRef.current.popup &&
        suggestionsRef.current.length > 0
      ) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const count = suggestionsRef.current.length;
          const current = suggestionIndexRef.current;
          const next =
            event.key === "ArrowUp"
              ? current <= -1
                ? count - 1
                : current - 1
              : current >= count - 1
                ? -1
                : current + 1;
          suggestionIndexRef.current = next;
          setSuggestionIndex(next);
          const value =
            next >= 0
              ? suggestionsRef.current[next]!.text
              : previewBaselineRef.current;
          inputRef.current = value;
          void invoke("terminal_write", {
            sessionId: session.id,
            data: encodeUtf8(`\u0015${value}`),
          });
          void loadSubdirectory(
            next >= 0 ? suggestionsRef.current[next] : undefined,
            0,
            false,
          );
          return false;
        }
        if (event.key === "ArrowRight") {
          const selected =
            suggestionsRef.current[suggestionIndexRef.current];
          if (
            selected?.isDirectory &&
            subdirectoryPanelsRef.current[0]?.suggestions.length
          ) {
            const first = subdirectoryPanelsRef.current[0]!.suggestions[0];
            updateSubdirectoryPanels(
              [
                {
                  ...subdirectoryPanelsRef.current[0]!,
                  selectedIndex: 0,
                },
              ],
              0,
            );
            if (first) {
              previewSuggestion(first);
              void loadSubdirectory(first, 1, false);
            }
            return false;
          }
        }
        if (event.key === "Escape") {
          clearAutocomplete(true);
          return false;
        }
        if (event.key === "Tab" || event.key === "Enter") {
          clearAutocomplete();
          return true;
        }
      }
      if (
        event.type === "keydown" &&
        event.key === "ArrowRight" &&
        !autocompleteSettingsRef.current.popup &&
        autocompleteSettingsRef.current.ghostText
      ) {
        const completion = suggestionsRef.current.find((candidate) =>
          candidate.text.startsWith(inputRef.current),
        );
        if (completion && completion.text !== inputRef.current) {
          const suffix = completion.text.slice(inputRef.current.length);
          const accepted =
            event.altKey || event.ctrlKey || event.metaKey
              ? nextAutocompleteWord(suffix)
              : suffix;
          inputRef.current += accepted;
          if (inputRef.current === completion.text) {
            suggestionsRef.current = [];
            setSuggestions([]);
          } else {
            setSuggestions([...suggestionsRef.current]);
          }
          void invoke("terminal_write", {
            sessionId: session.id,
            data: encodeUtf8(accepted),
          });
          return false;
        }
      }
      if (
        event.type === "keydown" &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f"
      ) {
        setSearchSummary("");
        setSearchOpen(true);
        return false;
      }
      return true;
    });
    void key;

    const resizeObserver = new ResizeObserver((entries) => {
      const observedRect = entries[0]?.contentRect;
      if (!observedRect || observedRect.width <= 0 || observedRect.height <= 0) {
        return;
      }
      fit.fit();
      void invoke("terminal_resize", {
        sessionId: session.id,
        columns: terminal.cols,
        rows: terminal.rows,
      });
    });
    resizeObserver.observe(container);

    const cleanupPromises = [
      listen<TerminalOutputEvent>("terminal-output", ({ payload }) => {
        if (payload.sessionId === session.id) {
          const bytes = decodeBase64(payload.data);
          const text = decoderRef.current.decode(bytes, { stream: true });
          const controlText = controlTailRef.current + text;
          controlTailRef.current = incompleteControlTail(controlText);
          const metadata = parseTerminalMetadata(controlText);
          if (metadata.title || metadata.workingDirectory) {
            updateMetadata(session.id, metadata);
          }
          const connectionEntries = parseConnectionLogs(controlText);
          for (const entry of connectionEntries) {
            if (entry.status === "latency") {
              setSessionLatency(session.id, Number(entry.message));
              continue;
            }
            if (entry.status === "latency-unavailable") {
              setSessionLatency(session.id);
              continue;
            }
            appendConnectionLog(session.id, entry);
            if (
              session.kind === "ssh" &&
              entry.status === "connected"
            ) {
              setLifecycle(session.id, "connected");
              markConnectionConnected(session.id);
              const startupCommand = consumeStartupCommand(session.id);
              if (startupCommand) {
                const kind = passwordPromptCommandKind(
                  startupCommand.command,
                );
                if (
                  kind &&
                  startupCommand.automaticPassword
                ) {
                  armAutomaticPassword(
                    startupCommand.automaticPassword,
                    kind,
                  );
                }
                passwordDetectorRef.current.arm(startupCommand.command);
                void invoke("terminal_write", {
                  sessionId: session.id,
                  data: encodeUtf8(startupCommand.command),
                });
              }
            }
          }
          const visible =
            session.kind === "ssh"
              ? filterSshBridgeDisplay(
                  text,
                  sshDisplayFilterRef.current,
                )
              : text;
          if (visible) terminal.write(visible);
          const match = passwordDetectorRef.current.observe(visible);
          if (match) {
            clearAutocomplete();
            inputRef.current = "";
            previewBaselineRef.current = "";
            promptConfirmedRef.current = false;
            const automatic = automaticPasswordRef.current;
            if (
              automatic?.kind === match &&
              Date.now() <= automatic.expiresAt
            ) {
              clearAutomaticPassword();
              passwordInputActiveRef.current = false;
              updatePasswordPrompt(undefined);
              passwordDetectorRef.current.markFilled();
              void invoke("terminal_write", {
                sessionId: session.id,
                data: encodeUtf8(`${automatic.secret}\r`),
              });
              return;
            }
            if (automatic && Date.now() > automatic.expiresAt) {
              clearAutomaticPassword();
            }
            passwordInputActiveRef.current = true;
            if (!passwordPromptRef.current) {
              updatePasswordPrompt(
                makePasswordPromptRequest(
                  passwordDetectorRef.current,
                  autocompleteSettingsRef.current.passwordPromptAssist,
                  match,
                  passwordCandidatesRef.current,
                  passwordSelectedIndexRef.current,
                ),
              );
            }
          } else if (
            passwordInputActiveRef.current &&
            /[\r\n]/.test(visible)
          ) {
            passwordInputActiveRef.current = false;
            clearAutomaticPassword();
            updatePasswordPrompt(undefined);
            passwordDetectorRef.current.abort();
          }
        }
      }),
      listen<TerminalExitEvent>("terminal-exit", ({ payload }) => {
        if (payload.sessionId === session.id) {
          passwordDetectorRef.current.abort();
          passwordInputActiveRef.current = false;
          clearAutomaticPassword();
          updatePasswordPrompt(undefined);
          clearAutocomplete();
          if (session.kind === "ssh") {
            finishConnectionHistory(
              session.id,
              payload.exitCode == null
                ? "connection-ended"
                : `exit-${payload.exitCode}`,
            );
          }
          setLifecycle(session.id, "exited");
          setExited(true);
          terminal.write(
            `\r\n\x1b[90m[process exited${
              payload.exitCode == null ? "" : ` with code ${payload.exitCode}`
            }]\x1b[0m\r\n`,
          );
        }
      }),
      listen<TerminalErrorEvent>("terminal-error", ({ payload }) => {
        if (payload.sessionId === session.id) {
          passwordDetectorRef.current.abort();
          passwordInputActiveRef.current = false;
          clearAutomaticPassword();
          updatePasswordPrompt(undefined);
          clearAutocomplete();
          if (session.kind === "ssh") {
            finishConnectionHistory(session.id, payload.message);
          }
          setError(payload.message);
          setLifecycle(session.id, "failed");
        }
      }),
    ];

    if (shouldStartTerminal(cacheHit)) {
      if (session.kind === "ssh") {
        appendConnectionLog(session.id, {
          status: "surface",
          message: "Terminal surface created.",
        });
        beginConnectionHistory(session.id, session.hostId);
      }
      void Promise.all(cleanupPromises)
        .then(() => {
          if (session.kind === "ssh" && host) {
            appendConnectionLog(session.id, {
              status: "launch",
              message: "Launching ssh2 bridge.",
            });
            return invoke("ssh_terminal_start", {
              sessionId: session.id,
              host,
              columns: terminal.cols,
              rows: terminal.rows,
              autoAcceptHostKeys:
                preferences.autoAcceptSshHostKeys,
            });
          }
          return invoke("terminal_start", {
            launch: makeLaunch(
              session,
              platform,
              terminal.cols,
              terminal.rows,
            ),
          });
        })
        .then(async () => {
          if (session.kind === "local") {
            setLifecycle(session.id, "connected");
            const startupCommand = consumeStartupCommand(session.id);
            if (startupCommand) {
              await invoke("terminal_write", {
                sessionId: session.id,
                data: encodeUtf8(startupCommand.command),
              });
            }
          }
        })
        .catch((reason: unknown) => {
          const failure =
            reason instanceof Error ? reason.message : String(reason);
          if (session.kind === "ssh") {
            finishConnectionHistory(session.id, failure);
          }
          setError(failure);
          setLifecycle(session.id, "failed");
        });
    }

    return () => {
      input.dispose();
      resizeObserver.disconnect();
      clearAutomaticPassword();
      if (suggestionTimerRef.current != null) {
        window.clearTimeout(suggestionTimerRef.current);
        suggestionTimerRef.current = undefined;
      }
      void Promise.all(cleanupPromises).then((unlisteners) => {
        unlisteners.forEach((unlisten) => unlisten());
      });
      terminalRef.current = undefined;
      fitRef.current = undefined;
      searchRef.current = undefined;
    };
  }, [
    host,
    platform,
    recordCommand,
    restartToken,
    preferences.autoAcceptSshHostKeys,
    session.id,
    session.kind,
    session.shell,
    setLifecycle,
    setSessionLatency,
    updateMetadata,
    appendConnectionLog,
    beginConnectionHistory,
    consumeStartupCommand,
    finishConnectionHistory,
    markConnectionConnected,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = terminalFont(
      preferences.terminalFontName,
    );
    terminal.options.fontSize = session.fontSize;
    fitRef.current?.fit();
  }, [
    preferences.terminalFontName,
    session.fontSize,
  ]);

  useLayoutEffect(() => {
    if (active) {
      focusTerminalSurface(session.id);
    }
  }, [active, session.id]);

  useEffect(() => {
    const showSearch = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== session.id) return;
      setSearchSummary("");
      setSearchOpen(true);
    };
    window.addEventListener("termpilot:search-terminal", showSearch);
    return () =>
      window.removeEventListener(
        "termpilot:search-terminal",
        showSearch,
      );
  }, [session.id]);

  useEffect(() => {
    if (active) return;
    searchRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchSummary("");
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const listener = getCurrentWindow().onDragDropEvent((event) => {
      if (document.documentElement.dataset.fileDropTarget === "sftp") {
        return;
      }
      if (event.payload.type !== "drop" || event.payload.paths.length === 0) {
        return;
      }
      const value = event.payload.paths
        .map((path) => quoteDroppedPath(path, platform))
        .join(" ");
      void invoke("terminal_write", {
        sessionId: session.id,
        data: encodeUtf8(value),
      });
      terminalRef.current?.focus();
    });
    return () => {
      void listener.then((unlisten) => unlisten());
    };
  }, [active, platform, session.id]);

  function changeFontSize(delta: number) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const fontSize = Math.min(
      36,
      Math.max(8, (terminal.options.fontSize ?? session.fontSize) + delta),
    );
    terminal.options.fontSize = fontSize;
    fitRef.current?.fit();
    setSessionFontSize(session.id, fontSize);
  }

  function reconnect() {
    passwordDetectorRef.current.abort();
    passwordInputActiveRef.current = false;
    if (automaticPasswordTimerRef.current != null) {
      window.clearTimeout(automaticPasswordTimerRef.current);
      automaticPasswordTimerRef.current = undefined;
    }
    automaticPasswordRef.current = undefined;
    passwordPromptRef.current = undefined;
    setPasswordPrompt(undefined);
    if (session.kind === "ssh") {
      finishConnectionHistory(session.id, "reconnect");
    }
    void invoke("terminal_terminate", {
      sessionId: session.id,
    }).then(() => {
      disposeTerminalSurface(session.id);
      setLifecycle(session.id, "connecting");
      setRestartToken((value) => value + 1);
    });
  }

  function writeTerminalText(value: string) {
    if (!value) return;
    const data = terminalPastePayload(
      value,
      terminalRef.current?.modes.bracketedPasteMode ?? false,
    );
    void invoke("terminal_write", {
      sessionId: session.id,
      data: encodeUtf8(data),
    }).finally(() => terminalRef.current?.focus());
  }

  function pasteClipboardText() {
    void navigator.clipboard
      .readText()
      .then(writeTerminalText)
      .catch((reason: unknown) => setError(String(reason)));
  }

  function acceptSuggestion(suggestion: AutocompleteSuggestion) {
    const payload = suggestion.text.startsWith(inputRef.current)
      ? suggestion.text.slice(inputRef.current.length)
      : `\u0015${suggestion.text}`;
    inputRef.current = suggestion.text;
    suggestionsRef.current = [];
    setSuggestions([]);
    suggestionIndexRef.current = -1;
    setSuggestionIndex(-1);
    setHoveredSuggestionIndex(-1);
    void invoke("terminal_write", {
      sessionId: session.id,
      data: encodeUtf8(payload),
    });
    terminalRef.current?.focus();
  }

  const ghostSuggestion =
    preferences.autocompleteEnabled &&
    preferences.autocompleteGhostText &&
    !preferences.autocompletePopup
      ? suggestions.find(
          (candidate) =>
            candidate.text.startsWith(inputRef.current) &&
            candidate.text !== inputRef.current,
        )
      : undefined;
  const ghostText = ghostSuggestion?.text.slice(inputRef.current.length);
  const ghostPosition = ghostText
    ? terminalCursorPosition(
        terminalRef.current,
        containerRef.current,
      )
    : undefined;
  const popupPosition =
    preferences.autocompletePopup && suggestions.length > 0
      ? terminalCursorPosition(
          terminalRef.current,
          containerRef.current,
        )
      : undefined;
  const detailSuggestion =
    suggestions[
      hoveredSuggestionIndex >= 0
        ? hoveredSuggestionIndex
        : suggestionIndex
    ];
  const popupLayoutPosition =
    popupPosition && containerRef.current
      ? terminalAutocompletePopupPosition(
          popupPosition,
          containerRef.current.clientWidth,
          containerRef.current.clientHeight,
          subdirectoryPanels.length,
          Boolean(
            detailSuggestion?.detail &&
              detailSuggestion.source !== "path",
          ),
        )
      : undefined;
  const submitPasswordCandidate = (id: string) => {
    const candidate = passwordCandidatesRef.current.find(
      (item) => item.id === id,
    );
    if (!candidate) return;
    passwordPromptRef.current = undefined;
    setPasswordPrompt(undefined);
    passwordInputActiveRef.current = false;
    passwordDetectorRef.current.markFilled();
    void invoke("terminal_write", {
      sessionId: session.id,
      data: encodeUtf8(`${candidate.password}\r`),
    });
    terminalRef.current?.focus();
  };
  const dismissPasswordPrompt = () => {
    passwordPromptRef.current = undefined;
    setPasswordPrompt(undefined);
    passwordDetectorRef.current.dismiss();
    terminalRef.current?.focus();
  };
  const closeSearch = useCallback(() => {
    searchRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchSummary("");
    focusTerminalSurface(session.id);
  }, [session.id]);
  const findNext = () => {
    if (!searchTerm) return;
    const found = searchRef.current?.findNext(searchTerm) ?? false;
    setSearchSummary(found ? "Match selected" : "No matches");
  };
  const findPrevious = () => {
    if (!searchTerm) return;
    const found = searchRef.current?.findPrevious(searchTerm) ?? false;
    setSearchSummary(found ? "Match selected" : "No matches");
  };

  return (
    <div
      className={`terminal-surface ${active ? "is-active" : ""} ${
        searchOpen ? "has-search-popover" : ""
      }`}
      onContextMenu={(event) => {
        if (!active) return;
        event.preventDefault();
        terminalRef.current?.focus();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          selection: terminalRef.current?.getSelection() ?? "",
        });
      }}
    >
      <div ref={containerRef} className="terminal-mount" />
      {active ? (
        <div className="terminal-quick-actions">
          <button
            type="button"
            title={t("Copy")}
            onClick={() => {
              const selection = terminalRef.current?.getSelection();
              if (selection) void navigator.clipboard.writeText(selection);
            }}
          >
            <Clipboard size={12} />
          </button>
          <button
            type="button"
            title={t("Paste")}
            onClick={pasteClipboardText}
          >
            <ClipboardPaste size={12} />
          </button>
          <button
            ref={searchButtonRef}
            type="button"
            title={t("Search")}
            aria-expanded={searchOpen}
            onClick={() => {
              if (searchOpen) {
                closeSearch();
              } else {
                setSearchSummary("");
                setSearchOpen(true);
              }
            }}
          >
            <Search size={12} />
          </button>
          <button
            type="button"
            title={t("Decrease font")}
            onClick={() => changeFontSize(-1)}
          >
            <ZoomOut size={12} />
          </button>
          <button
            type="button"
            title={t("Increase font")}
            onClick={() => changeFontSize(1)}
          >
            <ZoomIn size={12} />
          </button>
          <button
            type="button"
            title={t("Reconnect")}
            onClick={reconnect}
          >
            <RefreshCw size={12} />
          </button>
        </div>
      ) : null}
      {contextMenu
        ? createPortal(
            <div
              className="terminal-context-menu"
              role="menu"
              style={terminalContextMenuPosition(
                contextMenu.x,
                contextMenu.y,
                190,
                116,
                window.innerWidth,
                window.innerHeight,
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                disabled={!contextMenu.selection}
                onClick={() => {
                  void navigator.clipboard.writeText(contextMenu.selection);
                  setContextMenu(undefined);
                  terminalRef.current?.focus();
                }}
              >
                <Copy size={17} />
                <span>{t("Copy")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(undefined);
                  pasteClipboardText();
                }}
              >
                <ClipboardPaste size={17} />
                <span>{t("Paste")}</span>
              </button>
              <button
                type="button"
                disabled={!contextMenu.selection}
                onClick={() => {
                  const selection = contextMenu.selection;
                  setContextMenu(undefined);
                  writeTerminalText(selection);
                }}
              >
                <TextCursorInput size={17} />
                <span>{t("Paste Selected Text")}</span>
              </button>
            </div>,
            document.body,
          )
        : null}
      {error ? (
        <div className="terminal-error">
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)}>
            {t("Dismiss")}
          </button>
        </div>
      ) : null}
      {ghostText && ghostPosition && active ? (
        <span
          className="terminal-ghost-text"
          style={{
            left: ghostPosition.left,
            top: ghostPosition.top,
          }}
        >
          {ghostText}
        </span>
      ) : null}
      {preferences.autocompletePopup &&
      suggestions.length > 0 &&
      active ? (
        <div
          className="terminal-autocomplete-layout"
          style={popupLayoutPosition}
        >
          <div className="terminal-autocomplete">
            {suggestions.slice(0, 8).map((suggestion, index) => (
              <button
                className={
                  index === suggestionIndex ? "is-selected" : ""
                }
                key={`${suggestion.source}:${suggestion.text}`}
                type="button"
                onMouseEnter={() => setHoveredSuggestionIndex(index)}
                onMouseLeave={() => setHoveredSuggestionIndex(-1)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptSuggestion(suggestion);
                }}
              >
                <span
                  className={`terminal-autocomplete-source is-${suggestion.source}`}
                >
                  {sourceBadge(suggestion.source)}
                </span>
                <span className="terminal-autocomplete-command">
                  {suggestion.displayText}
                </span>
                {suggestion.detail ? (
                  <small>{suggestion.detail}</small>
                ) : null}
                {suggestion.frequency && suggestion.frequency > 1 ? (
                  <span className="terminal-autocomplete-frequency">
                    x{suggestion.frequency}
                  </span>
                ) : null}
                {index === suggestionIndex ? <kbd>return</kbd> : null}
              </button>
            ))}
          </div>
          {subdirectoryPanels.map((panel, level) => (
            <div
              className="terminal-autocomplete terminal-autocomplete-subdirectory"
              key={`path-panel-${level}`}
            >
              {panel.suggestions.slice(0, 8).map((suggestion, index) => (
                <button
                  className={
                    level === subdirectoryFocusLevel &&
                    index === panel.selectedIndex
                      ? "is-selected"
                      : ""
                  }
                  key={`${suggestion.pathKind}:${suggestion.text}`}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptSuggestion(suggestion);
                  }}
                >
                  <span className="terminal-autocomplete-source is-path">
                    {suggestion.pathKind === "directory"
                      ? "d"
                      : suggestion.pathKind === "symlink"
                        ? "l"
                        : "f"}
                  </span>
                  <span className="terminal-autocomplete-command">
                    {suggestion.displayText}
                  </span>
                  <span />
                  <span />
                  {suggestion.isDirectory ? <kbd>→</kbd> : null}
                </button>
              ))}
            </div>
          ))}
          {detailSuggestion?.detail &&
          detailSuggestion.source !== "path" ? (
            <aside className="terminal-autocomplete-detail">
              <header>
                <strong>{detailSuggestion.displayText}</strong>
                <span
                  className={`is-${detailSuggestion.source}`}
                >
                  {detailSuggestion.source}
                </span>
              </header>
              <p>{detailSuggestion.detail}</p>
            </aside>
          ) : null}
        </div>
      ) : null}
      {passwordPrompt && active ? (
        <div className="password-assist">
          <header>
            <KeyRound size={14} />
            <strong>{t("Saved Passwords")}</strong>
            <button
              type="button"
              title={t("Close")}
              onClick={dismissPasswordPrompt}
            >
              <X size={13} />
            </button>
          </header>
          <div className="password-options">
            {passwordPrompt.items.map((item, index) => (
              <button
                className={
                  index === passwordPrompt.selectedIndex
                    ? "is-selected"
                    : ""
                }
                key={item.id}
                type="button"
                onClick={() => submitPasswordCandidate(item.id)}
              >
                <UserRoundKey size={14} />
                <span>
                  <strong>{item.label}</strong>
                  {item.username ? <small>{item.username}</small> : null}
                </span>
                <code>••••••••</code>
              </button>
            ))}
          </div>
          <footer>
            {t(
              passwordPrompt.presentation === "picker"
                ? "Use arrow keys to select, then press Enter."
                : "Press Enter to paste the saved password.",
            )}
          </footer>
        </div>
      ) : null}
      {exited && active ? (
        <div className="terminal-exit-overlay">
          <span>{t("Session exited")}</span>
          <button
            type="button"
            onClick={() => {
              reconnect();
            }}
          >
            {t("Reconnect")}
          </button>
        </div>
      ) : null}
      {searchOpen && active ? (
        <TerminalSearchPopover
          anchor={searchButtonRef.current}
          value={searchTerm}
          summary={searchSummary}
          onChange={(value) => {
            setSearchTerm(value);
            setSearchSummary("");
            if (!value) searchRef.current?.clearDecorations();
          }}
          onFindNext={findNext}
          onFindPrevious={findPrevious}
          onClose={closeSearch}
        />
      ) : null}
    </div>
  );
}

export const TerminalSurface = memo(TerminalSurfaceView);

function makeLaunch(
  session: SessionDescriptor,
  platform: "windows" | "macos",
  columns: number,
  rows: number,
): TerminalLaunch {
  const program =
    session.shell ??
    (platform === "windows" ? "powershell.exe" : "/bin/zsh");
  return {
    sessionId: session.id,
    program,
    arguments:
      platform === "windows"
        ? ["-NoLogo"]
        : ["-l"],
    workingDirectory: session.workingDirectory,
    columns,
    rows,
    environment: {},
  };
}

function createTerminal(fontName: string, fontSize: number, isLight: boolean) {
  return new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    fontFamily: terminalFont(fontName),
    fontSize,
    fontWeight: "400",
    fontWeightBold: "600",
    lineHeight: 1.12,
    scrollback: 10_000,
    theme: isLight ? {
      background: "#f6f8fa",
      foreground: "#24292f",
      cursor: "#0969da",
      cursorAccent: "#f6f8fa",
      selectionBackground: "#b2d1ff",
      selectionForeground: "#24292f",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#218bff",
      brightMagenta: "#a371f7",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    } : {
      background: "#0d1117",
      foreground: "#d4d7dc",
      cursor: "#58a6ff",
      cursorAccent: "#0d1117",
      selectionBackground: "#264f78",
      selectionForeground: "#ffffff",
      black: "#0d1117",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
  });
}

export function terminalFont(name: string): string {
  if (!name || name === "auto") {
    return [
      '"MesloLGS NF"',
      '"MesloLGS Nerd Font Mono"',
      '"JetBrainsMono Nerd Font"',
      '"JetBrainsMono Nerd Font Mono"',
      '"Hack Nerd Font"',
      '"Hack Nerd Font Mono"',
      '"FiraCode Nerd Font"',
      '"FiraCode Nerd Font Mono"',
      '"CaskaydiaCove Nerd Font"',
      '"CaskaydiaCove Nerd Font Mono"',
      '"Symbols Nerd Font Mono"',
      "Menlo",
      "Monaco",
      '"SFMono-Regular"',
      '"Cascadia Mono"',
      '"Cascadia Code"',
      "Consolas",
      "monospace",
    ].join(", ");
  }
  return `"${name.replaceAll('"', "")}", monospace`;
}

export function terminalPastePayload(
  value: string,
  bracketedPasteMode: boolean,
) {
  return bracketedPasteMode
    ? `\u001b[200~${value}\u001b[201~`
    : value;
}

export function terminalContextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const inset = 8;
  return {
    left: Math.max(inset, Math.min(x, viewportWidth - width - inset)),
    top: Math.max(inset, Math.min(y, viewportHeight - height - inset)),
  };
}

function encodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function terminalCursorPosition(
  terminal: Terminal | undefined,
  container: HTMLDivElement | null,
) {
  if (!terminal || !container || terminal.cols <= 0 || terminal.rows <= 0) {
    return undefined;
  }
  const cellWidth = container.clientWidth / terminal.cols;
  const lineHeight = container.clientHeight / terminal.rows;
  return {
    left: Math.min(
      Math.max(8, terminal.buffer.active.cursorX * cellWidth + 10),
      Math.max(8, container.clientWidth - 240),
    ),
    top: Math.min(
      Math.max(4, terminal.buffer.active.cursorY * lineHeight),
      Math.max(4, container.clientHeight - lineHeight),
    ),
    lineHeight,
  };
}

export function terminalAutocompletePopupPosition(
  cursor: { left: number; top: number; lineHeight: number },
  containerWidth: number,
  containerHeight: number,
  subdirectoryPanelCount: number,
  showsDetail: boolean,
) {
  const preferredWidth =
    440 + subdirectoryPanelCount * 218 + (showsDetail ? 284 : 0);
  const width = Math.min(preferredWidth, Math.max(180, containerWidth - 16));
  const left = Math.max(
    8,
    Math.min(cursor.left, Math.max(8, containerWidth - width - 8)),
  );
  const below = cursor.top + cursor.lineHeight + 6;
  const top =
    below + 248 <= containerHeight - 8
      ? below
      : Math.max(8, cursor.top - 254);
  return { left, top };
}

export function nextAutocompleteWord(suffix: string) {
  let accepted = "";
  let foundNonWhitespace = false;
  for (const character of suffix) {
    accepted += character;
    if (/\s/.test(character)) {
      if (foundNonWhitespace) break;
    } else {
      foundNonWhitespace = true;
    }
  }
  return accepted;
}

export function updateInputBuffer(
  data: string,
  input: React.MutableRefObject<string>,
  suggestions: React.MutableRefObject<AutocompleteSuggestion[]>,
  setSuggestions: (value: AutocompleteSuggestion[]) => void,
  enabled: boolean,
  candidates: string[],
) {
  if (
    data === "\r" ||
    data === "\n" ||
    data === "\u0003" ||
    data === "\u0015"
  ) {
    input.current = "";
    suggestions.current = [];
    setSuggestions([]);
    return;
  }
  if (data === "\u007f" || data === "\b") {
    input.current = input.current.slice(0, -1);
  } else if (data === "\u0017") {
    input.current = input.current.replace(/\s*\S+\s*$/, "");
  } else if (data.startsWith("\u001b[200~")) {
    const content = data
      .replace(/^\u001b\[200~/, "")
      .replace(/\u001b\[201~$/, "");
    input.current = content.split(/\r?\n/).at(-1) ?? "";
  } else if (data.startsWith("\u001b")) {
    input.current = "";
    suggestions.current = [];
    setSuggestions([]);
    return;
  } else if (!/[\u0000-\u001f\u007f]/.test(data)) {
    input.current += data;
  } else {
    return;
  }
  if (!enabled || input.current.length === 0) {
    suggestions.current = [];
    setSuggestions([]);
    return;
  }
  const next = historyAutocompleteSuggestions(
    input.current,
    candidates,
    5,
  );
  suggestions.current = next;
  setSuggestions(next);
}

const commonCommands = [
  "cd",
  "ls -la",
  "pwd",
  "clear",
  "cat",
  "grep",
  "find",
  "tail -f",
  "ssh",
  "scp",
  "sudo",
  "systemctl status",
  "journalctl -f",
  "docker ps",
  "docker logs -f",
  "docker compose up -d",
  "git status",
  "git pull",
  "git log --oneline",
  "kubectl get pods",
  "kubectl logs -f",
];

function quoteDroppedPath(path: string, platform: "windows" | "macos") {
  if (platform === "windows") {
    return `'${path.replaceAll("'", "''")}'`;
  }
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

export function parseTerminalMetadata(text: string): {
  title?: string;
  workingDirectory?: string;
} {
  const metadata: { title?: string; workingDirectory?: string } = {};
  const titleMatches = text.matchAll(
    /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g,
  );
  for (const match of titleMatches) {
    const title = match[1]?.trim();
    if (title) metadata.title = title;
  }
  const directoryMatches = text.matchAll(
    /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g,
  );
  for (const match of directoryMatches) {
    try {
      metadata.workingDirectory = decodeURIComponent(match[1]);
    } catch {
      metadata.workingDirectory = match[1];
    }
  }
  const bridgeDirectory = text.match(
    /\x1e\[ssh2:cwd\]\s*([^\x1f]*)\x1f/,
  )?.[1];
  if (bridgeDirectory) {
    metadata.workingDirectory = bridgeDirectory.trim();
  }
  return metadata;
}

export function parseConnectionLogs(text: string) {
  return [...text.matchAll(/\x1e\[ssh2:([^\]]+)\]\s*([^\x1f]*)\x1f/g)].map(
    (match) => {
      const raw = match[2].trim();
      const detailStart = raw.indexOf(" {");
      return {
        status: match[1],
        message:
          detailStart >= 0 ? raw.slice(0, detailStart) : raw,
        detail:
          detailStart >= 0 ? raw.slice(detailStart + 1) : undefined,
      };
    },
  );
}

export function incompleteControlTail(text: string) {
  const candidates: number[] = [];
  const oscStart = text.lastIndexOf("\u001b]");
  if (oscStart >= 0) {
    const bellEnd = text.indexOf("\u0007", oscStart + 2);
    const stringEnd = text.indexOf("\u001b\\", oscStart + 2);
    if (bellEnd < 0 && stringEnd < 0) candidates.push(oscStart);
  }
  const bridgeStart = text.lastIndexOf(SSH2_CONTROL_START);
  if (
    bridgeStart >= 0 &&
    text.indexOf(SSH2_CONTROL_END, bridgeStart + SSH2_CONTROL_START.length) < 0
  ) {
    candidates.push(bridgeStart);
  }
  for (const prefix of ["\u001b]", SSH2_CONTROL_START]) {
    for (
      let length = Math.min(prefix.length - 1, text.length);
      length > 0;
      length -= 1
    ) {
      if (text.endsWith(prefix.slice(0, length))) {
        candidates.push(text.length - length);
        break;
      }
    }
  }
  if (candidates.length === 0) return "";
  return text.slice(Math.min(...candidates));
}

export function filterSshBridgeDisplay(
  text: string,
  state: SSHDisplayFilterState,
) {
  let input = state.pending + text;
  state.pending = "";
  let output = "";
  while (input.length > 0) {
    if (state.filteringControlRecord) {
      const recordEnd = input.indexOf(SSH2_CONTROL_END);
      if (recordEnd < 0) {
        state.pending = input;
        return output;
      }
      input = input.slice(recordEnd + SSH2_CONTROL_END.length);
      state.filteringControlRecord = false;
      continue;
    }
    const prefixStart = input.indexOf(SSH2_CONTROL_START);
    if (prefixStart >= 0) {
      output += input.slice(0, prefixStart);
      input = input.slice(prefixStart + SSH2_CONTROL_START.length);
      state.filteringControlRecord = true;
      continue;
    }
    let pendingCount = 0;
    for (
      let length = Math.min(input.length, SSH2_CONTROL_START.length - 1);
      length > 0;
      length -= 1
    ) {
      if (input.endsWith(SSH2_CONTROL_START.slice(0, length))) {
        pendingCount = length;
        break;
      }
    }
    output += input.slice(0, input.length - pendingCount);
    state.pending = input.slice(input.length - pendingCount);
    return output;
  }
  return output;
}

export async function pathSuggestions(
  input: string,
  currentDirectory: string | undefined,
  host: Host | undefined,
  sessionId: string,
  pathRequirement?: "files" | "folders",
) {
  const context = parseAutocompleteCommandLine(input);
  const rawWord = context.currentWord;
  const quotePrefix =
    rawWord.startsWith('"') || rawWord.startsWith("'")
      ? rawWord[0]!
      : "";
  const quoteSuffix =
    quotePrefix && rawWord.endsWith(quotePrefix) ? quotePrefix : "";
  const word = rawWord
    .slice(
      quotePrefix ? 1 : 0,
      quoteSuffix ? -1 : undefined,
    )
    .replace(/\\(.)/g, "$1");
  const command = context.commandName;
  const pathCommands = new Set([
    "cd",
    "pushd",
    "cat",
    "less",
    "more",
    "tail",
    "head",
    "ls",
    "find",
    "rm",
    "mv",
    "cp",
    "chmod",
    "chown",
    "mkdir",
    "rmdir",
    "touch",
    "ln",
    "stat",
    "file",
    "grep",
    "rg",
    "fd",
    "vim",
    "vi",
    "nvim",
    "nano",
    "tar",
    "zip",
    "unzip",
    "scp",
    "rsync",
  ]);
  if (
    context.wordIndex < 1 ||
    (!word.includes("/") &&
      !word.includes("\\") &&
      !pathCommands.has(command) &&
      !pathRequirement)
  ) {
    return [];
  }
  const foldersOnly =
    pathRequirement === "folders" ||
    new Set(["cd", "pushd", "mkdir", "rmdir"]).has(command);
  const separator = host ? "/" : word.includes("\\") ? "\\" : "/";
  const lastSeparator = Math.max(
    word.lastIndexOf("/"),
    word.lastIndexOf("\\"),
  );
  const typedDirectory =
    lastSeparator >= 0 ? word.slice(0, lastSeparator + 1) : "";
  const prefix =
    lastSeparator >= 0 ? word.slice(lastSeparator + 1) : word;
  const base =
    typedDirectory.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(typedDirectory)
      ? typedDirectory || separator
      : joinPath(
          currentDirectory || (host ? "." : ""),
          typedDirectory || ".",
          separator,
        );
  try {
    const entries = host
      ? (
          await invoke<{ entries: Array<{ name: string; kind: string }> }>(
            "sftp_request",
            {
              host,
              sourceSessionId: sessionId,
              request: { action: "list", path: base },
            },
          )
        ).entries
      : await invoke<Array<{ name: string; kind: string }>>("local_list", {
          path: base,
        });
    const inputPrefix = input.slice(0, input.length - rawWord.length);
    return entries
      .filter((entry) =>
        entry.name.toLowerCase().startsWith(prefix.toLowerCase()),
      )
      .filter((entry) => !foldersOnly || entry.kind === "directory")
      .sort((left, right) => {
        const rank = (kind: string) =>
          kind === "directory" ? 0 : kind === "symlink" ? 1 : 2;
        return (
          rank(left.kind) - rank(right.kind) ||
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          })
        );
      })
      .slice(0, 24)
      .map((entry): AutocompleteSuggestion => {
        const suffix = entry.kind === "directory" ? separator : "";
        const candidate = `${typedDirectory}${entry.name}${suffix}`;
        const replacement = quotePrefix
          ? `${quotePrefix}${candidate}${quoteSuffix}`
          : escapeCompletionPath(
              candidate,
              host == null && separator === "\\",
            );
        return {
          text: `${inputPrefix}${replacement}`,
          displayText: `${entry.name}${suffix}`,
          source: "path",
          score: 750,
          isDirectory: entry.kind === "directory",
          pathKind:
            entry.kind === "directory" || entry.kind === "symlink"
              ? entry.kind
              : "file",
        };
      });
  } catch {
    return [];
  }
}

export function escapeCompletionPath(path: string, powershell: boolean) {
  if (!/[\s'"\\$`!&;()[\]{}*?<>|]/.test(path)) return path;
  if (powershell) {
    return `'${path.replaceAll("'", "''")}'`;
  }
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function joinPath(base: string, child: string, separator: string) {
  if (!base || base === ".") return child;
  return `${base.replace(/[\\/]+$/, "")}${separator}${child.replace(
    /^[\\/]+/,
    "",
  )}`;
}
