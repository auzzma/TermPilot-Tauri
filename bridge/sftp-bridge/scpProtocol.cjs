/**
 * Pure OpenSSH-style SCP wire protocol helpers (no I/O).
 * Used by the SCP-mode remote filesystem backend for single-file transfers.
 *
 * Protocol summary (source = sender of file data, sink = receiver):
 *   - Control: Cmmmm <size> <filename>\n  then <size> bytes then \0
 *   - Directory: Dmmmm 0 <dirname>\n ... entries ... E\n
 *   - ACK from peer: \0 (ok), \x01message\n (error), \x02message\n (fatal)
 */

"use strict";

const SCP_OK = 0x00;
const SCP_ERROR = 0x01;
const SCP_FATAL = 0x02;

class ScpProtocolError extends Error {
  constructor(message, code = "SCP_PROTOCOL_ERROR") {
    super(message);
    this.name = "ScpProtocolError";
    this.code = code;
  }
}

/**
 * Build a file control line: C0664 123 name\n
 * @param {{ mode?: number|string, size: number, name: string }} opts
 */
function buildFileControlLine({ mode = 0o0644, size, name, encoding = "utf-8" }) {
  if (!Number.isFinite(size) || size < 0 || !Number.isInteger(size)) {
    throw new ScpProtocolError(`Invalid SCP file size: ${size}`);
  }
  const baseName = sanitizeScpBasename(name);
  const modeStr = normalizeModeOctal(mode);
  const prefix = Buffer.from(`C${modeStr} ${size} `, "utf8");
  const enc = String(encoding || "utf-8").toLowerCase();
  let nameBuf;
  if (enc === "gb18030" || enc === "gbk" || enc === "gb2312") {
    try {
      // eslint-disable-next-line global-require
      const iconv = require("iconv-lite");
      nameBuf = iconv.encode(baseName, "gb18030");
    } catch {
      nameBuf = Buffer.from(baseName, "utf8");
    }
  } else {
    nameBuf = Buffer.from(baseName, "utf8");
  }
  return Buffer.concat([prefix, nameBuf, Buffer.from("\n", "utf8")]);
}

/**
 * Build a directory control line: D0755 0 name\n
 */
function buildDirectoryControlLine({ mode = 0o0755, name }) {
  const baseName = sanitizeScpBasename(name);
  const modeStr = normalizeModeOctal(mode);
  return Buffer.from(`D${modeStr} 0 ${baseName}\n`, "utf8");
}

/** End-of-directory marker: E\n */
function buildEndDirectoryLine() {
  return Buffer.from("E\n", "utf8");
}

/** ACK byte used by sink/source to signal ready/ok */
function buildAck() {
  return Buffer.from([SCP_OK]);
}

/**
 * Parse a single SCP control line (without trailing newline).
 * @returns {{ kind: 'file'|'directory'|'end', mode?: number, size?: number, name?: string }}
 */
function parseControlLine(line) {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : String(line);
  const trimmed = text.replace(/\r?\n$/, "");
  if (!trimmed) {
    throw new ScpProtocolError("Empty SCP control line");
  }
  if (trimmed === "E") {
    return { kind: "end" };
  }
  const kindChar = trimmed[0];
  if (kindChar !== "C" && kindChar !== "D" && kindChar !== "T") {
    throw new ScpProtocolError(`Unknown SCP control line: ${trimmed.slice(0, 80)}`);
  }
  if (kindChar === "T") {
    // Time header: T mtime 0 atime 0 — ignored by MVP but recognized
    return { kind: "time", raw: trimmed };
  }
  // Cmmmm size name  or Dmmmm 0 name — name may contain spaces
  const match = trimmed.match(/^([CD])([0-7]{3,5})\s+(\d+)\s+(.*)$/);
  if (!match) {
    throw new ScpProtocolError(`Malformed SCP control line: ${trimmed.slice(0, 80)}`);
  }
  const kind = match[1] === "C" ? "file" : "directory";
  const mode = parseInt(match[2], 8);
  const size = Number(match[3]);
  const name = match[4];
  // Only reject path separators used by remote paths (/). Backslash is a valid
  // POSIX filename character and must be allowed for download control lines.
  if (!name || name.includes("/") || name === ".." || name === ".") {
    throw new ScpProtocolError(`Invalid SCP entry name: ${name}`);
  }
  if (kind === "file" && (!Number.isFinite(size) || size < 0)) {
    throw new ScpProtocolError(`Invalid SCP file size in control line: ${match[3]}`);
  }
  return { kind, mode, size, name };
}

/**
 * Consume leading ACK/error bytes from a buffer.
 * Returns { status: 'ok'|'error'|'fatal'|'incomplete', message?, consumed }
 */
function consumeAck(buffer) {
  if (!buffer || buffer.length === 0) {
    return { status: "incomplete", consumed: 0 };
  }
  const code = buffer[0];
  if (code === SCP_OK) {
    return { status: "ok", consumed: 1 };
  }
  if (code === SCP_ERROR || code === SCP_FATAL) {
    let end = 1;
    while (end < buffer.length && buffer[end] !== 0x0a) end += 1;
    if (end >= buffer.length) {
      return { status: "incomplete", consumed: 0 };
    }
    const message = buffer.subarray(1, end).toString("utf8").trim() || "SCP remote error";
    return {
      status: code === SCP_FATAL ? "fatal" : "error",
      message,
      consumed: end + 1,
    };
  }
  // Some remotes send printable noise; treat unexpected non-zero as fatal if we can
  return {
    status: "fatal",
    message: `Unexpected SCP status byte 0x${code.toString(16)}`,
    consumed: 1,
  };
}

/**
 * Read complete lines from a buffer accumulator (for control protocol).
 * Returns { lines: Buffer[], rest: Buffer }
 */
function splitCompleteLines(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      lines.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  return {
    lines,
    rest: start === 0 ? buffer : buffer.subarray(start),
  };
}

function normalizeModeOctal(mode) {
  let n;
  if (typeof mode === "string") {
    n = parseInt(mode, 8);
  } else {
    n = Number(mode);
  }
  if (!Number.isFinite(n) || n < 0) n = 0o0644;
  // SCP control lines use 4-digit octal commonly (0 prefix + 3 digit mode)
  const masked = n & 0o7777;
  return masked.toString(8).padStart(4, "0");
}

/**
 * Basename only — reject path separators and empty names.
 */
function sanitizeScpBasename(name) {
  if (typeof name !== "string" || !name) {
    throw new ScpProtocolError("SCP entry name is required");
  }
  if (name.includes("\0")) {
    throw new ScpProtocolError("SCP entry name must not contain NUL");
  }
  if (name.includes("/") || name === ".." || name === ".") {
    throw new ScpProtocolError(`SCP entry name must be a simple basename: ${name}`);
  }
  // Control line is space-delimited; reject newlines
  if (/[\r\n]/.test(name)) {
    throw new ScpProtocolError("SCP entry name must not contain newlines");
  }
  return name;
}

/**
 * Incremental parser for an SCP source stream (download from remote).
 * Feed buffers; yields control events and file data chunks.
 */
function createSourceStreamParser(options = {}) {
  const encoding = String(options.encoding || "utf-8").toLowerCase();
  let buf = Buffer.alloc(0);
  let phase = "await-control"; // await-control | await-data | done
  let pendingFile = null;
  let remaining = 0;
  let needTrailingNul = false;

  const decodeControlName = (nameBytes) => {
    if (encoding === "gb18030" || encoding === "gbk" || encoding === "gb2312") {
      try {
        // eslint-disable-next-line global-require
        const iconv = require("iconv-lite");
        return iconv.decode(nameBytes, "gb18030");
      } catch {
        return nameBytes.toString("utf8");
      }
    }
    return nameBytes.toString("utf8");
  };

  return {
    get phase() {
      return phase;
    },
    feed(chunk) {
      const events = [];
      if (!chunk || chunk.length === 0) return events;
      buf = Buffer.concat([buf, Buffer.from(chunk)]);

      while (buf.length > 0) {
        if (phase === "await-control") {
          // Control lines are text ending in \n; time/file/dir/end
          const nl = buf.indexOf(0x0a);
          if (nl < 0) break;
          const lineBuf = buf.subarray(0, nl);
          buf = buf.subarray(nl + 1);
          // Decode basename with session encoding when C/D lines carry non-UTF-8 bytes.
          let lineForParse = lineBuf;
          if (lineBuf.length > 0 && (lineBuf[0] === 0x43 || lineBuf[0] === 0x44)) {
            // C/Dmmmm size name — find third space-separated field start
            let spaces = 0;
            let nameStart = -1;
            for (let i = 0; i < lineBuf.length; i += 1) {
              if (lineBuf[i] === 0x20) {
                spaces += 1;
                if (spaces === 2) {
                  nameStart = i + 1;
                  break;
                }
              }
            }
            if (nameStart > 0 && nameStart < lineBuf.length) {
              const head = lineBuf.subarray(0, nameStart).toString("utf8");
              const name = decodeControlName(lineBuf.subarray(nameStart));
              lineForParse = Buffer.from(`${head}${name}`, "utf8");
            }
          }
          const parsed = parseControlLine(lineForParse);
          if (parsed.kind === "time") {
            events.push({ type: "time", raw: parsed.raw });
            continue;
          }
          if (parsed.kind === "end") {
            events.push({ type: "end-directory" });
            continue;
          }
          if (parsed.kind === "directory") {
            events.push({ type: "directory", mode: parsed.mode, name: parsed.name });
            continue;
          }
          // file
          pendingFile = { mode: parsed.mode, size: parsed.size, name: parsed.name };
          remaining = parsed.size;
          needTrailingNul = true;
          phase = remaining === 0 ? "await-nul" : "await-data";
          events.push({ type: "file-start", ...pendingFile });
          if (phase === "await-nul") {
            // fall through to read trailing nul
          } else {
            continue;
          }
        }

        if (phase === "await-data") {
          if (buf.length === 0) break;
          const take = Math.min(remaining, buf.length);
          const data = buf.subarray(0, take);
          buf = buf.subarray(take);
          remaining -= take;
          events.push({ type: "file-data", data: Buffer.from(data) });
          if (remaining === 0) {
            phase = "await-nul";
          } else {
            break;
          }
        }

        if (phase === "await-nul") {
          if (buf.length === 0) break;
          if (buf[0] !== 0x00) {
            throw new ScpProtocolError("Expected trailing NUL after SCP file data");
          }
          buf = buf.subarray(1);
          events.push({
            type: "file-end",
            name: pendingFile?.name,
            size: pendingFile?.size,
            mode: pendingFile?.mode,
          });
          pendingFile = null;
          needTrailingNul = false;
          phase = "await-control";
        }
      }
      return events;
    },
    finish() {
      if (phase === "await-data" || phase === "await-nul" || needTrailingNul) {
        throw new ScpProtocolError("Incomplete SCP source stream");
      }
      if (buf.length > 0) {
        // leftover non-empty buffer is unexpected unless only whitespace
        const leftover = buf.toString("utf8").trim();
        if (leftover) {
          throw new ScpProtocolError(`Trailing garbage in SCP stream: ${leftover.slice(0, 80)}`);
        }
      }
    },
  };
}

module.exports = {
  SCP_OK,
  SCP_ERROR,
  SCP_FATAL,
  ScpProtocolError,
  buildFileControlLine,
  buildDirectoryControlLine,
  buildEndDirectoryLine,
  buildAck,
  parseControlLine,
  consumeAck,
  splitCompleteLines,
  normalizeModeOctal,
  sanitizeScpBasename,
  createSourceStreamParser,
};
