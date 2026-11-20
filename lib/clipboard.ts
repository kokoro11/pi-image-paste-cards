import { getNativeClipboard } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bmpToPng } from "./bmp.ts";
import { MAX_IMAGE_BYTES, type ImageBytes } from "./core.ts";
import { t } from "./messages.ts";

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function readCommandOutput(command: string, args: string[], timeout = 5000): Promise<Buffer | undefined> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = (result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    const abort = () => {
      child.kill("SIGKILL");
      child.stdout?.destroy();
      finish();
    };
    const timer = setTimeout(abort, timeout);
    child.on("error", () => finish());
    child.on("close", (code) => { if (!settled) finish(code === 0 ? Buffer.concat(chunks, length) : undefined); });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_IMAGE_BYTES) abort();
      else chunks.push(chunk);
    });
  });
}

function detectMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return undefined;
}

export async function normalizeImage(bytes: Buffer): Promise<ImageBytes> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(t.imageTooLarge);
  const mimeType = detectMime(bytes);
  if (mimeType === "image/bmp") {
    return { bytes: await bmpToPng(bytes, MAX_IMAGE_BYTES), mimeType: "image/png" };
  }
  if (!mimeType) throw new Error(t.unsupportedImage);
  return { bytes, mimeType };
}

// undefined = unavailable backend; null = current clipboard has no image.
// A successfully queried empty Wayland clipboard must not use stale X11 data.
async function readBackend(wayland: boolean): Promise<Buffer | null | undefined> {
  if (!(wayland ? process.env.WAYLAND_DISPLAY : process.env.DISPLAY)) return undefined;
  const command = wayland ? "wl-paste" : "xclip";
  const listed = await readCommandOutput(command, wayland
    ? ["--list-types"] : ["-selection", "clipboard", "-t", "TARGETS", "-o"], 2000);
  if (listed === undefined) return undefined;
  const offered = listed.toString("utf8").split(/\r?\n/).map((type) => type.trim());
  for (const mime of IMAGE_MIMES) {
    const selected = offered.find((type) => type.split(";")[0]?.toLowerCase() === mime);
    if (!selected) continue;
    const bytes = await readCommandOutput(command, wayland
      ? ["--type", selected, "--no-newline"] : ["-selection", "clipboard", "-t", selected, "-o"]);
    if (bytes === undefined) return undefined;
    return bytes.length ? bytes : null;
  }
  return null;
}

export async function clipboardImage(): Promise<Buffer | null> {
  let image = await readBackend(true);
  if (image === undefined) image = await readBackend(false);
  if (image === undefined) {
    const bytes = await getNativeClipboard()?.getImage();
    if (bytes?.length) return Buffer.from(bytes);
  }
  return image ?? null;
}

export async function clipboardText(): Promise<string | null> {
  if (process.env.WAYLAND_DISPLAY) {
    const bytes = await readCommandOutput("wl-paste", ["--type", "text", "--no-newline"]);
    if (bytes !== undefined) return bytes.toString("utf8") || null;
  }
  if (process.env.DISPLAY) {
    const bytes = await readCommandOutput("xclip", ["-selection", "clipboard", "-o"]);
    if (bytes !== undefined) return bytes.toString("utf8") || null;
  }
  return (await getNativeClipboard()?.getText()) || null;
}

export const isImagePath = (text: string) => !/[\r\n]/.test(text.trim()) && /\.(?:png|jpe?g|webp|gif|bmp)["']?\s*$/i.test(text);

export async function clipboardFilePaths(): Promise<string[]> {
  const paths = await getNativeClipboard()?.getFilePaths?.();
  if (paths != null) return paths;
  if (process.platform !== "win32") return [];
  const bytes = await readCommandOutput("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }",
  ]);
  return bytes?.toString("utf8").split(/\r?\n/).filter(Boolean) ?? [];
}

export async function resolveImagePath(text: string, cwd: string): Promise<string> {
  let path = text.trim().replace(/^(?:"(.*)"|'(.*)')$/, "$1$2");
  if (path.startsWith("file://")) path = fileURLToPath(path);
  if (/^[A-Za-z]:[\\/]/.test(path) && process.platform === "linux") {
    const converted = await readCommandOutput("wslpath", ["-u", path]);
    if (!converted) throw new Error(t.windowsPath);
    path = converted.toString("utf8").trim();
  }
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return resolve(cwd, path);
}

export async function loadImagePath(path: string): Promise<ImageBytes> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error(t.fileUnreadable);
  return normalizeImage(await readFile(path));
}
