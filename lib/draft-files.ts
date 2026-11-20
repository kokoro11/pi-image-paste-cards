import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ImageBytes } from "./core.ts";

const TEMP_PREFIX = "pi-image-paste-";
const TEMP_IMAGE_NAME = new RegExp(`^${TEMP_PREFIX}[0-9a-f-]{36}\\.(?:png|jpg|webp|gif)$`);
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};

export type DraftRecord = { id: number; sourceUrl?: string } &
  ({ path: string } | { messageId: string; imageIndex: number; label: string });
type DraftManifest = { version: 2; nextId: number; images: DraftRecord[] };
type DraftSelection = readonly { record: DraftRecord }[];

export class DraftFiles {
  private dir = tmpdir();
  private owned = new Set<string>();
  private writes = Promise.resolve();
  private savedSelection?: DraftSelection;
  private savedNextId = 0;
  // Also recognize paths pasted by Pi's own clipboard handler.
  private nativePaths = new RegExp(
    `${join(this.dir, "pi-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:image-paste|clipboard)-[0-9a-f-]{36}\\.(?:png|jpg|webp|gif)`,
    "g",
  );

  findInPrompt(text: string): string[] | null {
    return text.match(this.nativePaths);
  }

  manifestPath(sessionId: string): string {
    return join(this.dir, `${TEMP_PREFIX}draft-${sessionId}.json`);
  }

  isTempImage(path: unknown): path is string {
    if (typeof path !== "string") return false;
    const name = basename(path);
    return TEMP_IMAGE_NAME.test(name) && path === join(this.dir, name);
  }

  async writeImage(image: ImageBytes): Promise<string> {
    const path = join(this.dir, `${TEMP_PREFIX}${randomUUID()}.${IMAGE_EXTENSIONS[image.mimeType]}`);
    await writeFile(path, image.bytes, { mode: 0o600, flag: "wx" });
    return path;
  }

  track(record: DraftRecord): void {
    if ("path" in record) this.owned.add(record.path);
  }

  async release(paths: Iterable<string>): Promise<void> {
    for (const path of paths) {
      this.owned.delete(path);
      await unlink(path).catch(() => {});
    }
  }

  async readManifest(path: string): Promise<DraftManifest | undefined> {
    try {
      const info = await lstat(path);
      // Windows uses the temp directory's inherited ACLs for new files.
      if (!info.isFile() || info.size > 64 * 1024 ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("unsafe manifest");
      const parsed = JSON.parse(await readFile(path, "utf8")) as DraftManifest;
      if (parsed.version !== 2 || !Array.isArray(parsed.images) || parsed.images.length > 16) throw new Error("invalid manifest");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  saveManifest(path: string, selection: DraftSelection, nextId: number): Promise<void> {
    if (selection === this.savedSelection && nextId === this.savedNextId) return this.writes;
    this.savedSelection = selection;
    this.savedNextId = nextId;
    const data = selection.length
      ? JSON.stringify({ version: 2, nextId, images: selection.map((draft) => draft.record) } satisfies DraftManifest)
      : undefined;
    this.writes = this.writes.then(() => data === undefined
      ? unlink(path).catch(() => {})
      : writeFile(path, data, { mode: 0o600 })
    ).catch(() => { this.savedSelection = undefined; });
    return this.writes;
  }

  async close(manifest: string | undefined, keepDraft: boolean): Promise<void> {
    if (!keepDraft) {
      await this.release(this.owned);
      if (manifest) await unlink(manifest).catch(() => {});
    }
    this.owned.clear();
    this.savedSelection = undefined;
  }

  /** Remove leftovers from crashed or killed runs. */
  async sweepStale(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return; }
    const cutoff = Date.now() - STALE_MS;
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(this.dir, name);
      try {
        const info = await lstat(path);
        if (info.isFile() && info.mtimeMs < cutoff) await unlink(path);
      } catch { /* already gone */ }
    }
  }
}
