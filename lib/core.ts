import { StringDecoder } from "node:string_decoder";
import { t } from "./messages.ts";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
const OSC_PREFIX = "\x1b]5522;";
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_PACKET_CHARS = 16 * 1024 * 1024;

export type ImageBytes = { bytes: Buffer; mimeType: string };

/** OMP's two-phase enhanced paste: list MIME types, then read the preferred one. */
export class EnhancedPaste {
  private state?: {
    phase: "listing" | "reading";
    mimes: string[];
    mime?: string;
    chunks: Buffer[];
    bytes: number;
    dot?: boolean;
    password?: string;
    location?: string;
  };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private callbacks: {
    write: (data: string) => void;
    image: (image: ImageBytes) => void;
    text: (text: string) => void;
    error: (message: string) => void;
  }) {}

  handle(packet: string): void {
    if (!packet.startsWith(OSC_PREFIX)) return;
    const end = packet.endsWith("\x07") ? 1 : packet.endsWith("\x1b\\") ? 2 : 0;
    if (!end) return;
    const body = packet.slice(OSC_PREFIX.length, -end);
    const separator = body.indexOf(";");
    const header = separator < 0 ? body : body.slice(0, separator);
    const payload = separator < 0 ? "" : body.slice(separator + 1);
    if (header.length > 1024) return this.fail(t.oscMetadata);
    const metadata = new Map(header.split(":").map((field) => {
      const i = field.indexOf("=");
      return [field.slice(0, i), field.slice(i + 1)] as const;
    }));
    if (metadata.get("type") !== "read") return;

    try {
      const status = metadata.get("status");
      const state = this.state;
      if (status === "OK") {
        if (state?.phase === "reading") return;
        const password = metadata.get("pw");
        if (password && !/^[A-Za-z0-9+/=_-]{1,512}$/.test(password)) {
          return this.fail(t.oscAuth);
        }
        this.state = {
          phase: "listing", mimes: [], chunks: [], bytes: 0,
          password, location: metadata.get("loc") === "primary" ? "primary" : undefined,
        };
      } else if (status === "DATA" && state) {
        const mime = decodeBase64(metadata.get("mime") ?? "").toString("utf8");
        if (state.phase === "listing") {
          if (mime === ".") {
            state.dot = true;
            const list = decodeBase64(payload).toString("utf8").split(/\s+/);
            state.mimes.push(...list.filter((value) => value && value !== "."));
          } else if (mime) {
            state.mimes.push(mime);
          }
          if (state.mimes.length > 64) return this.fail(t.oscMimes);
        } else if (mime === state.mime && payload) {
          const bytes = decodeBase64(payload);
          state.bytes += bytes.length;
          if (state.bytes > MAX_IMAGE_BYTES) return this.fail(t.oscTooLarge);
          state.chunks.push(bytes);
        }
      } else if (status === "DONE" && state) {
        if (state.phase === "listing") {
          const mime = IMAGE_MIMES.find((value) => state.mimes.includes(value)) ??
            (state.mimes.includes("text/plain") ? "text/plain" : undefined);
          if (!mime) return this.fail(t.oscUnsupported);
          state.phase = "reading";
          state.mime = mime;
          const fields = ["type=read"];
          if (state.location) fields.push(`loc=${state.location}`);
          if (state.password) {
            fields.push(`pw=${state.password}`, `name=${Buffer.from("Paste event").toString("base64")}`);
          }
          const encoded = Buffer.from(mime).toString("base64");
          this.callbacks.write(state.dot
            ? `${OSC_PREFIX}${fields.join(":")};${encoded}\x07`
            : `${OSC_PREFIX}${fields.join(":")}:mime=${encoded}\x07`);
        } else {
          this.reset();
          const bytes = state.chunks.length === 1 ? state.chunks[0]! : Buffer.concat(state.chunks, state.bytes);
          if (!bytes.length) return this.callbacks.error(t.oscEmpty);
          if (state.mime === "text/plain") this.callbacks.text(bytes.toString("utf8"));
          else this.callbacks.image({ bytes, mimeType: state.mime! });
          return;
        }
      } else if (status && !["DATA", "DONE"].includes(status)) {
        return this.fail(`${t.oscFailed}: ${status.slice(0, 80)}`);
      }
      if (this.state) this.armTimeout();
    } catch {
      this.fail(t.oscEncoding);
    }
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.state = undefined;
  }

  private armTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(t.oscTimeout), 10_000);
  }

  private fail(message: string): void {
    this.reset();
    this.callbacks.error(message);
  }
}

function decodeBase64(value: string): Buffer {
  if (value.length > MAX_PACKET_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64");
  }
  return Buffer.from(value, "base64");
}

/**
 * Intercept only OSC 5522 before Pi's stock StdinBuffer. It otherwise treats a
 * fragmented 5522 reply as Alt+] and leaks its base64 tail into the editor.
 * Plain keys and bracketed-paste contents still use Pi's original parser.
 */
export class Osc5522Input {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private mode: "input" | "paste" | "packet" | "discard" = "input";
  private packetParts: string[] = [];
  private packetLength = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private callbacks: {
    forward: (data: string) => void;
    packet: (data: string) => void;
    error: (message: string) => void;
  }) {}

  push(data: string | Buffer): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Preserve Pi's legacy high-bit Alt encoding for single-byte input.
    const text = Buffer.isBuffer(data)
      ? data.length === 1 && data[0]! > 127 && (this.mode === "input" || this.mode === "discard")
        ? `\x1b${String.fromCharCode(data[0]! - 128)}`
        : this.decoder.write(data)
      : data;
    this.buffer += text;
    this.drain();
    if (this.buffer || this.mode === "packet") {
      const receivingPacket = this.mode === "packet" || this.mode === "discard";
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const remaining = this.buffer;
        this.buffer = "";
        if (receivingPacket) {
          this.clearPacket();
          this.mode = "discard";
          this.callbacks.error(t.oscIncomplete);
        } else {
          this.callbacks.forward(remaining);
        }
      }, receivingPacket ? 5_000 : 20);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // A forwarded key can restart the terminal before its handler returns.
    // Discard the old buffer so teardown cannot replay that key.
    this.buffer = "";
    this.clearPacket();
    this.mode = "input";
    this.decoder.end();
  }

  private clearPacket(): void {
    this.packetParts.length = 0;
    this.packetLength = 0;
  }

  private readPacket(): boolean {
    const chunk = this.buffer;
    const bel = chunk.indexOf("\x07");
    const st = chunk.indexOf("\x1b\\");
    const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
    if (end < 0) {
      // Hold just enough input to recognize an ST split across reads. Searching
      // the accumulated packet would repeatedly flatten it on every fragment.
      this.buffer = chunk.endsWith("\x1b") ? "\x1b" : "";
      if (this.mode === "packet") {
        if (this.packetLength + chunk.length > MAX_PACKET_CHARS) {
          this.clearPacket();
          this.mode = "discard";
          this.callbacks.error(t.oscPacketTooLarge);
        } else {
          const part = this.buffer ? chunk.slice(0, -1) : chunk;
          if (part) this.packetParts.push(part);
          this.packetLength += part.length;
        }
      }
      return false;
    }

    const length = end + (end === bel ? 1 : 2);
    this.buffer = chunk.slice(length);
    let packet: string | undefined;
    if (this.mode === "packet" && this.packetLength + length <= MAX_PACKET_CHARS) {
      packet = chunk.slice(0, length);
      if (this.packetParts.length) {
        this.packetParts.push(packet);
        packet = this.packetParts.join("");
      }
    }
    this.clearPacket();
    this.mode = "input";
    if (packet !== undefined) this.callbacks.packet(packet);
    return true;
  }

  private drain(): void {
    while (this.buffer) {
      if (this.mode === "packet" || this.mode === "discard") {
        if (!this.readPacket()) return;
        continue;
      }

      if (this.mode === "paste") {
        const end = this.buffer.indexOf(PASTE_END);
        if (end >= 0) {
          this.mode = "input";
          this.forward(end + PASTE_END.length);
          continue;
        }
        let keep = Math.min(PASTE_END.length - 1, this.buffer.length);
        while (keep && !PASTE_END.startsWith(this.buffer.slice(-keep))) keep--;
        this.forward(this.buffer.length - keep);
        return;
      }

      const escape = this.buffer.indexOf("\x1b");
      if (escape < 0) {
        this.forward(this.buffer.length);
        return;
      }
      if (escape > 0) {
        this.forward(escape);
        continue;
      }
      if (this.buffer.startsWith(OSC_PREFIX)) {
        this.mode = "packet";
      } else if (this.buffer.startsWith(PASTE_START)) {
        this.mode = "paste";
        this.forward(PASTE_START.length);
      } else if (OSC_PREFIX.startsWith(this.buffer) || PASTE_START.startsWith(this.buffer)) {
        return;
      } else {
        // Let the original parser assemble CSI/Alt keys without our interpreting them.
        this.forward(1);
      }
    }
  }

  private forward(end: number): void {
    if (!end) return;
    const text = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end);
    this.callbacks.forward(text);
  }
}
