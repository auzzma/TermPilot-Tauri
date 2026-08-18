import type { Credential, Host } from "./types";

export type PasswordPromptCommandKind = "sudo" | "su";
export type PasswordPromptPresentation = "hint" | "picker";

export interface PasswordPromptCandidate {
  id: string;
  label: string;
  username?: string;
  password: string;
  isHostCredential: boolean;
}

export interface PasswordPromptRequest {
  items: Array<{
    id: string;
    label: string;
    username?: string;
  }>;
  selectedIndex: number;
  presentation: PasswordPromptPresentation;
}

const ARM_DURATION_MS = 10_000;
const CONTROL_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_SEQUENCE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CONCEALED_TEXT = /\x1b\[(?:[0-9]+;)*8(?:;[0-9]+)*m/;
const AUTHENTICATION_FAILURE =
  /(?:sorry,\s*try\s*again|incorrect\s+password|authentication\s+failure|auth(?:entication)?\s+fail|密码(?:错误|不正确)|认证失败|鉴权失败|口令错误)/i;

export class PasswordPromptDetector {
  armedKind?: PasswordPromptCommandKind;
  private armedUntil = 0;
  private outputTail = "";
  private waitsForAuthenticationRetry = false;
  private dismissedWhileArmed = false;

  arm(command: string, now = Date.now()) {
    this.abort();
    const kind = passwordPromptCommandKind(command);
    if (!kind) return;
    this.armedKind = kind;
    this.armedUntil = now + ARM_DURATION_MS;
  }

  observe(
    output: string,
    now = Date.now(),
  ): PasswordPromptCommandKind | undefined {
    this.outputTail = (this.outputTail + output).slice(-1_024);
    const rawLine = lastLine(this.outputTail);
    const plainLine = stripControlSequences(rawLine);
    const armed = this.armedKind != null && now <= this.armedUntil;

    let match: PasswordPromptCommandKind | undefined;
    if (isExplicitSudoPrompt(rawLine)) {
      match = "sudo";
    } else if (
      armed &&
      this.armedKind === "su" &&
      isSuPasswordPrompt(rawLine)
    ) {
      match = "su";
    } else if (
      armed &&
      this.armedKind === "sudo" &&
      isSudoScopedPasswordPrompt(rawLine)
    ) {
      match = "sudo";
    }

    if (!match) {
      if (!armed) {
        this.armedKind = undefined;
        this.waitsForAuthenticationRetry = false;
      }
      return undefined;
    }

    if (this.waitsForAuthenticationRetry) {
      const retry =
        isExplicitSudoPrompt(rawLine) ||
        AUTHENTICATION_FAILURE.test(stripControlSequences(this.outputTail));
      if (!retry) {
        this.abort();
        return undefined;
      }
      this.waitsForAuthenticationRetry = false;
    }

    if (this.dismissedWhileArmed) {
      const newPromptCycle =
        /[\r\n]/.test(output) ||
        AUTHENTICATION_FAILURE.test(stripControlSequences(this.outputTail));
      if (!newPromptCycle) return undefined;
      this.dismissedWhileArmed = false;
    }

    return plainLine ? match : undefined;
  }

  markFilled(now = Date.now()) {
    this.waitsForAuthenticationRetry = true;
    this.dismissedWhileArmed = false;
    this.armedUntil = now + ARM_DURATION_MS;
    this.outputTail = "";
  }

  dismiss(now = Date.now()) {
    this.dismissedWhileArmed =
      this.armedKind != null && now <= this.armedUntil;
    if (!this.dismissedWhileArmed) this.abort();
  }

  reshowDismissedPrompt(
    now = Date.now(),
  ): PasswordPromptCommandKind | undefined {
    if (
      !this.dismissedWhileArmed ||
      !this.armedKind ||
      now > this.armedUntil
    ) {
      return undefined;
    }
    const rawLine = lastLine(this.outputTail);
    let match: PasswordPromptCommandKind | undefined;
    if (isExplicitSudoPrompt(rawLine)) {
      match = "sudo";
    } else if (
      this.armedKind === "su" &&
      isSuPasswordPrompt(rawLine)
    ) {
      match = "su";
    } else if (
      this.armedKind === "sudo" &&
      isSudoScopedPasswordPrompt(rawLine)
    ) {
      match = "sudo";
    }
    if (match) this.dismissedWhileArmed = false;
    return match;
  }

  hasActiveArm(kind: PasswordPromptCommandKind, now = Date.now()) {
    return this.armedKind === kind && now <= this.armedUntil;
  }

  abort() {
    this.armedKind = undefined;
    this.armedUntil = 0;
    this.outputTail = "";
    this.waitsForAuthenticationRetry = false;
    this.dismissedWhileArmed = false;
  }
}

export function passwordPromptCommandKind(
  command: string,
): PasswordPromptCommandKind | undefined {
  const match = command
    .trim()
    .match(/^(?:(?:builtin|command)\s+)?(sudo|su)(?:\s|$)/);
  return match?.[1] as PasswordPromptCommandKind | undefined;
}

export function assistedPasswordCommand(renderedLine: string) {
  const line = renderedLine.trim();
  if (!line) return undefined;
  if (passwordPromptCommandKind(line)) return line;
  for (let index = 0; index < line.length; index += 1) {
    if (!"$#%>❯➜".includes(line[index]!)) continue;
    const candidate = line.slice(index + 1).trim();
    if (passwordPromptCommandKind(candidate)) return candidate;
  }
  return undefined;
}

export function isExplicitSudoPrompt(value: string) {
  if (CONCEALED_TEXT.test(value)) return false;
  const line = stripControlSequences(value);
  return /\[sudo[^\]]*\]/i.test(line) && containsPasswordLabel(line);
}

export function isSuPasswordPrompt(value: string) {
  if (CONCEALED_TEXT.test(value)) return false;
  const line = stripControlSequences(value).replace(/\s+/g, " ").trim();
  if (
    line.includes("@") ||
    line.length > 24 ||
    /(?:enter\s+password|password\s+for\s+user)/i.test(line)
  ) {
    return false;
  }
  return /^(?:password|passwd|密\s*码|口\s*令)\s*[:：]?\s*$/i.test(line);
}

export function isSudoScopedPasswordPrompt(value: string) {
  if (CONCEALED_TEXT.test(value)) return false;
  const line = stripControlSequences(value);
  if (
    !containsPasswordLabel(line) ||
    /(?:enter\s+password|password\s+for\s+user)/i.test(line)
  ) {
    return false;
  }
  return /(?:password\s+for\b|的密码|输入密码|input\s+password)/i.test(
    line,
  );
}

export function passwordPromptCandidates(
  host: Host | undefined,
  credentials: Credential[],
): PasswordPromptCandidate[] {
  const values: PasswordPromptCandidate[] = [];
  const hostPassword = passwordPromptQuickFill(host);
  if (host && hostPassword) {
    values.push({
      id: "host",
      label: host.label,
      username: host.username,
      password: hostPassword,
      isHostCredential: true,
    });
  }
  for (const credential of credentials) {
    if (credential.kind !== "password" || !credential.password) continue;
    values.push({
      id: `credential:${credential.id}`,
      label: credential.label,
      username: credential.username,
      password: credential.password,
      isHostCredential: false,
    });
  }
  return values.filter(
    (item, index) =>
      values.findIndex((candidate) => candidate.password === item.password) ===
      index,
  );
}

export function passwordPromptQuickFill(host: Host | undefined) {
  if (!host) return undefined;
  if (host.elevationPassword) return host.elevationPassword;
  return host.authentication === "password" ? host.password : undefined;
}

export function makePasswordPromptRequest(
  detector: PasswordPromptDetector,
  mode: "off" | "hint" | "picker",
  kind: PasswordPromptCommandKind,
  candidates: PasswordPromptCandidate[],
  selectedIndex: number,
): PasswordPromptRequest | undefined {
  if (mode === "off") return undefined;
  const picker = mode === "picker" && detector.hasActiveArm(kind);
  const available = picker
    ? candidates
    : candidates.filter((item) => item.isHostCredential);
  if (available.length === 0) return undefined;
  return {
    items: available.map(({ id, label, username }) => ({
      id,
      label,
      username,
    })),
    selectedIndex: Math.min(selectedIndex, available.length - 1),
    presentation: picker ? "picker" : "hint",
  };
}

function containsPasswordLabel(value: string) {
  return /(?:\bpassword\b|密\s*码|口\s*令)/i.test(value);
}

function stripControlSequences(value: string) {
  return value.replace(OSC_SEQUENCE, "").replace(CONTROL_SEQUENCE, "");
}

function lastLine(value: string) {
  return value.slice(
    Math.max(value.lastIndexOf("\r"), value.lastIndexOf("\n")) + 1,
  );
}
