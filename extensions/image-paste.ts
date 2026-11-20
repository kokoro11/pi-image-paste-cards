import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getImageDimensions, getKeybindings, isKeyRelease, matchesKey, Text, type Component, type Editor, type TUI } from "@earendil-works/pi-tui";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  clipboardFilePaths,
  clipboardImage,
  clipboardText,
  isImagePath,
  loadImagePath,
  normalizeImage,
  resolveImagePath,
} from "../lib/clipboard.ts";
import { PASTE_START, PASTE_END, type ImageBytes } from "../lib/core.ts";
import { installEnhancedPaste } from "../lib/terminal.ts";
import { t } from "../lib/messages.ts";
import {
  ATTACHED_IMAGES_HEADING,
  AttachmentList,
  IMAGE_LINK,
  decorateImageTokens,
  imageSize,
  imageTokens,
  linkImageLabel,
  replaceImageLabels,
  renderImageLinks,
  type Attachment,
} from "../lib/ui.ts";

const PREVIEW_ENTRY_TYPE = "image-paste-preview";
const PREVIEW_ROW = /^(\[Image #([1-9]\d*)(?: ([0-9a-f]{6}))?\])(?:\((file:\/\/[^\s\p{Cc}()]+)\))? /gmu;
const TEMP_PREFIX = "pi-image-paste-";
const TEMP_IMAGE_NAME = new RegExp(`^${TEMP_PREFIX}[0-9a-f-]{36}\\.(?:png|jpg|webp|gif)$`);
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};

function imageLabel(id: number, bytes: Buffer): string {
  const code = createHash("sha256").update(bytes).digest("hex").slice(0, 6);
  return `[Image #${id} ${code}]`;
}

function imageContent({ bytes, mimeType }: ImageBytes): ImageContent {
  return { type: "image", data: bytes.toString("base64"), mimeType };
}

function previewText(entry: SessionEntry | undefined): string | undefined {
  if (entry?.type !== "custom" || entry.customType !== PREVIEW_ENTRY_TYPE) return;
  const text = (entry.data as { text?: unknown } | undefined)?.text;
  if (typeof text === "string") return text;
}

function userContent(entry: SessionEntry | undefined) {
  if (entry?.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) return [];
  return entry.message.content;
}

export default function imagePaste(pi: ExtensionAPI) {
  type DraftRecord = { id: number; sourceUrl?: string } &
    ({ path: string } | { messageId: string; imageIndex: number; label: string });
  type DraftImage = Attachment & { record: DraftRecord; content: ImageContent };
  type DraftManifest = { version: 2; nextId: number; images: DraftRecord[] };
  type FocusedComponent = Component & Partial<Pick<Editor, "getCursor" | "getLines">>;
  type CapturedTUI = TUI & { getFocusedComponent(): FocusedComponent | null };

  let context: ExtensionContext | undefined;
  let tui: CapturedTUI | undefined;
  let decoratedEditor: object | undefined;
  let cleanupDecoration: (() => void) | undefined;
  let epoch = 0;
  let pending: Promise<void> | undefined;
  let cleanupInput: (() => void) | undefined;
  let cleanupTransport: (() => void) | undefined;
  let nextAttachmentId = 1;
  let manifestSignature = "";
  let manifestWrites = Promise.resolve();
  const submittedDrafts: Array<{ text: string; labels: string[]; draftLabels: string[] }> = [];
  let pendingPreview: string | undefined;
  let treeTargetId: string | undefined;
  const queuedInput: string[] = [];
  const drafts = new Map<string, DraftImage>();
  const createdFiles = new Set<string>();
  const diagnostics = { trigger: t.notTriggered, result: t.notRead, events: 0, trace: false, lastEvent: "" };
  const getOutputPad = () => pi.getSettings().outputPad === 0 ? 0 : 1;

  const activeDrafts = (text = context?.ui.getEditorText() ?? ""): DraftImage[] => {
    const seen = new Set<string>();
    const result: DraftImage[] = [];
    for (const token of imageTokens(text)) {
      const draft = drafts.get(token.label);
      if (draft && !seen.has(token.label)) { seen.add(token.label); result.push(draft); }
    }
    return result;
  };
  const lookup = (label: string) => drafts.get(label);
  const redraw = () => { tui?.requestRender(); };
  const manifestPath = () => context
    ? join(tmpdir(), `${TEMP_PREFIX}draft-${context.sessionManager.getSessionId()}.json`) : undefined;
  const validTempPath = (path: string) => {
    if (typeof path !== "string") return false;
    const name = basename(path);
    return TEMP_IMAGE_NAME.test(name) && path === join(tmpdir(), name);
  };

  const dropFiles = async (paths: Iterable<string>) => {
    for (const path of paths) {
      createdFiles.delete(path);
      await unlink(path).catch(() => {});
    }
  };
  /** Delete leftovers from crashed or killed runs. Only our own file names are touched. */
  const sweepStale = async () => {
    let names: string[];
    try { names = await readdir(tmpdir()); } catch { return; }
    const cutoff = Date.now() - STALE_MS;
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(tmpdir(), name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.mtimeMs >= cutoff) continue;
        await unlink(path);
      } catch { /* already gone */ }
    }
  };

  const saveManifest = async () => {
    const path = manifestPath();
    if (!path) return;
    const images = activeDrafts().map(({ record }) => record);
    const manifest: DraftManifest = { version: 2, nextId: nextAttachmentId, images };
    const signature = JSON.stringify(manifest);
    if (signature === manifestSignature) return manifestWrites;
    manifestSignature = signature;
    manifestWrites = manifestWrites.then(async () => {
      if (!images.length) await unlink(path).catch(() => {});
      else await writeFile(path, signature, { mode: 0o600 });
    }).catch(() => { manifestSignature = ""; });
    return manifestWrites;
  };

  const updateDraftDisplay = () => {
    redraw();
    void saveManifest();
  };

  const addDraft = (record: DraftRecord, content: ImageContent, label: string): DraftImage => {
    const { mimeType, data } = content;
    const draft = { record, label, sourceUrl: record.sourceUrl, mimeType, dimensions: getImageDimensions(data, mimeType), content };
    drafts.set(label, draft);
    if ("path" in record) createdFiles.add(record.path);
    nextAttachmentId = Math.max(nextAttachmentId, record.id + 1);
    return draft;
  };

  const insert = (text: string) => {
    if (!context) return;
    context.ui.pasteToEditor(text);
    redraw();
  };

  const insertLabel = (label: string) => {
    if (!context) return;
    const editor = tui?.getFocusedComponent();
    const cursor = editor?.getCursor?.();
    const editorLine = cursor && editor?.getLines?.()[cursor.line];
    const line = editorLine ?? context.ui.getEditorText().split("\n").at(-1)!;
    const column = editorLine === undefined ? line.length : cursor!.col;
    const before = /\S/.test(line[column - 1] ?? "") ? " " : "";
    const after = /\s/.test(line[column] ?? "") ? "" : " ";
    insert(`${before}${label}${after}`);
  };

  const stage = async (image: ImageBytes, token: number, sourceUrl?: string) => {
    if (token !== epoch || !context) return;
    const path = join(tmpdir(), `${TEMP_PREFIX}${randomUUID()}.${IMAGE_EXTENSIONS[image.mimeType]}`);
    await writeFile(path, image.bytes, { mode: 0o600, flag: "wx" });
    if (token !== epoch || !context) { await unlink(path).catch(() => {}); return; }
    const id = nextAttachmentId;
    const draft = addDraft({ id, path, sourceUrl }, imageContent(image), imageLabel(id, image.bytes));
    insertLabel(draft.label);
    await saveManifest();
    diagnostics.result = `${image.mimeType}, ${image.bytes.length} bytes`;
  };

  const stagePath = async (text: string, ctx: ExtensionContext, token: number) => {
    const path = await resolveImagePath(text, ctx.cwd);
    const sourceUrl = pathToFileURL(path).href.replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("&", "%26");
    let image: ImageBytes;
    try {
      image = await loadImagePath(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      if (token !== epoch) return;
      const name = basename(path).replace(/\p{Cc}/gu, "\uFFFD").replace(/[[\]\\]/g, "\\$&");
      insertLabel(`[${name}](${sourceUrl})`);
      diagnostics.result = `${t.linkOnly} (${code})`;
      ctx.ui.notify(diagnostics.result, "warning");
      return;
    }
    await stage(image, token, validTempPath(path) ? undefined : sourceUrl);
  };

  const paste = (trigger: string, path?: string, supplied?: ImageBytes): Promise<void> => {
    if (pending) return pending;
    if (!context) return Promise.resolve();
    const ctx = context;
    const token = epoch;
    diagnostics.trigger = trigger;
    diagnostics.events++;
    ctx.ui.setStatus("image-paste", t.reading);
    const stageClipboardFiles = async () => {
      const paths = (await clipboardFilePaths()).filter(isImagePath);
      for (const path of paths) {
        if (token !== epoch) break;
        await stagePath(path, ctx, token);
      }
      return paths.length > 0;
    };
    pending = (async () => {
      try {
        if (path) {
          await stagePath(path, ctx, token);
          return;
        }
        const bytes = supplied?.bytes ?? await clipboardImage();
        if (token !== epoch) return;
        if (bytes) {
          // Local file copies can also offer image bytes. Preserve their source paths.
          if (!supplied && await stageClipboardFiles()) return;
          if (token === epoch) await stage(await normalizeImage(bytes), token);
          return;
        }
        const text = await clipboardText();
        if (token !== epoch) return;
        if (text) {
          if (isImagePath(text)) {
            try {
              await stagePath(text, ctx, token);
              return;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          if (token !== epoch) return;
          insert(text);
          diagnostics.result = t.pastedText;
          return;
        }
        if (!await stageClipboardFiles() && token === epoch) {
          diagnostics.result = t.nothingToPaste;
          ctx.ui.notify(`${diagnostics.result}; ${t.runStatus}`, "warning");
        }
      } catch (error) {
        if (token === epoch) {
          diagnostics.result = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`${t.pasteFailed}: ${diagnostics.result}`, "error");
        }
      } finally {
        if (token === epoch) {
          pending = undefined;
          ctx.ui.setStatus("image-paste", undefined);
          for (const data of queuedInput.splice(0)) tui?.getFocusedComponent()?.handleInput?.(data);
          tui?.requestRender();
        }
      }
    })();
    return pending;
  };

  pi.registerEntryRenderer<{ text: string }>(PREVIEW_ENTRY_TYPE, (entry, _options, theme) => {
    const text = entry.data?.text;
    if (typeof text !== "string" || !text) return;
    const styledText = renderImageLinks(text).split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
    return new Text(styledText, getOutputPad(), 0);
  });

  const appendPreview = () => {
    if (pendingPreview === undefined) return;
    pi.appendEntry(PREVIEW_ENTRY_TYPE, { text: pendingPreview });
    pendingPreview = undefined;
  };
  // Pi persists message_end after extension handlers return. Flush before the
  // next message in a batch or before the request, whichever comes first.
  pi.on("message_start", appendPreview);
  pi.on("context", (event) => {
    appendPreview();
    // Pi gives context hooks a copy. Keep file URLs in the transcript while
    // sending the image labels and image content in the model request.
    for (const message of event.messages) {
      if (message.role !== "user" || !Array.isArray(message.content) || !message.content.some((part) => part.type === "image")) continue;
      for (const part of message.content) {
        if (part.type === "text") part.text = part.text.replace(IMAGE_LINK, "$1");
      }
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "user" || !Array.isArray(event.message.content)) return;
    const images = event.message.content.filter((part): part is ImageContent => part.type === "image");
    const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    // Pi can append a size note and replace the image bytes during resizing.
    const submittedIndex = submittedDrafts.findIndex(({ text: prompt }) =>
      text === prompt || text.startsWith(`${prompt}\n\n[Image`));
    const submitted = submittedIndex < 0 ? undefined : submittedDrafts.splice(submittedIndex, 1)[0];
    if (images.length) {
      const links = new Map(Array.from(text.matchAll(IMAGE_LINK), ([, label, url]) => [label, url]));
      const labels = submitted?.labels.length === images.length ? submitted.labels : [];
      const rows = images.map(({ data, mimeType }, index) => {
        const label = labels[index] ?? imageLabel(nextAttachmentId++, Buffer.from(data, "base64"));
        return `${linkImageLabel(label, links.get(label))} ${imageSize(mimeType, getImageDimensions(data, mimeType))}`;
      });
      pendingPreview = `${ATTACHED_IMAGES_HEADING}\n${rows.join("\n")}`;
    }
    if (submitted) {
      const active = new Set(activeDrafts().map((draft) => draft.label));
      const released: string[] = [];
      for (const label of submitted.draftLabels) {
        if (active.has(label)) continue;
        const draft = drafts.get(label);
        if (draft && "path" in draft.record) released.push(draft.record.path);
        drafts.delete(label);
      }
      // The sent message now owns the image bytes, so the draft copy is no longer needed.
      void dropFiles(released);
    }
    if (images.length || submitted) updateDraftDisplay();
  });

  pi.on("session_before_tree", ({ preparation }) => {
    treeTargetId = preparation.targetId;
  });
  pi.on("session_tree", async (_event, ctx) => {
    const messageId = treeTargetId;
    treeTargetId = undefined;
    // Pi moves the leaf to the parent and prefills the editor only if it is empty.
    if (ctx.mode !== "tui" || !messageId || ctx.ui.getEditorText().trim()) return;
    const parts = userContent(ctx.sessionManager.getEntry(messageId));
    const images = parts.filter((part) => part.type === "image");
    if (!images.length) return;

    const preview = ctx.sessionManager.getEntries().find((entry) =>
      entry.parentId === messageId && entry.type === "custom" && entry.customType === PREVIEW_ENTRY_TYPE);
    const rows = Array.from((previewText(preview) ?? "").matchAll(PREVIEW_ROW));
    let text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    const missingLabels: string[] = [];
    for (const [imageIndex, image] of images.entries()) {
      const [, savedLabel, number, code, sourceUrl] = rows.length === images.length ? rows[imageIndex]! : [];
      const savedId = Number(number);
      const id = Number.isSafeInteger(savedId + 1) ? savedId : nextAttachmentId;
      const label = code && savedId === id ? savedLabel! : imageLabel(id, Buffer.from(image.data, "base64"));
      addDraft({ id, messageId, imageIndex, label, sourceUrl }, image, label);
      if (savedLabel) text = text.replaceAll(linkImageLabel(savedLabel, sourceUrl), label);
      if (!text.includes(label)) missingLabels.push(label);
    }
    ctx.ui.setEditorText([text, ...missingLabels].filter(Boolean).join(" "));
    redraw();
    await saveManifest();
  });

  pi.registerCommand("paste-image", {
    description: t.commandPaste,
    handler: async (path, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify(t.tuiOnly, "warning"); return; }
      await paste("/paste-image", path.trim() || undefined);
    },
  });
  pi.registerCommand("paste-image-status", {
    description: t.commandStatus,
    handler: async (arg, ctx) => {
      const command = arg.trim();
      if (command === "trace") diagnostics.trace = true;
      else if (command === "off") diagnostics.trace = false;
      ctx.ui.notify([
        t.statusLoaded,
        `${t.statusEvents}: ${diagnostics.events}`,
        `${t.statusTrigger}: ${diagnostics.trigger}`,
        `${t.statusResult}: ${diagnostics.result}`,
        `${t.statusKey}: ${diagnostics.lastEvent || t.unrecorded}`,
        `${t.statusTrace}: ${diagnostics.trace ? t.on : t.off}`,
      ].join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Use all session branches so switching branches cannot reuse a sent number.
    for (const entry of ctx.sessionManager.getEntries()) {
      const text = previewText(entry);
      if (!text) continue;
      for (const [, , number] of text.matchAll(PREVIEW_ROW)) {
        const next = Number(number) + 1;
        if (Number.isSafeInteger(next)) nextAttachmentId = Math.max(nextAttachmentId, next);
      }
    }
    if (ctx.mode !== "tui") return;
    context = ctx;
    epoch++;
    void sweepStale();
    ctx.ui.setWidget("image-paste-cards", (ui, theme) => {
      tui = ui as CapturedTUI;
      return new AttachmentList(
        activeDrafts,
        (line) => theme.fg("toolOutput", line),
        getOutputPad,
      );
    });
    const getMessageEditor = () => {
      const focused = tui?.getFocusedComponent();
      return focused && "getExpandedText" in focused ? focused : undefined;
    };
    const isEditorFocused = () => !tui?.hasOverlay() && getMessageEditor() !== undefined;
    const ensureDecorated = () => {
      const focused = getMessageEditor();
      if (!focused || focused === decoratedEditor) return;
      cleanupDecoration?.();
      cleanupDecoration = decorateImageTokens(focused, lookup);
      decoratedEditor = focused;
      redraw();
    };
    ensureDecorated();

    // Reload keeps the draft text. Resolve backing files and message references
    // from the manifest for this session before the editor can submit it again.
    const path = manifestPath();
    if (path) {
      try {
        const info = await lstat(path);
        // Windows uses the temp directory's inherited ACLs for newly created files.
        if (!info.isFile() || info.size > 64 * 1024 ||
          (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("unsafe manifest");
        const parsed = JSON.parse(await readFile(path, "utf8")) as DraftManifest;
        if (parsed.version !== 2 || !Array.isArray(parsed.images) || parsed.images.length > 16) throw new Error("invalid manifest");
        for (const item of parsed.images) {
          if (!Number.isSafeInteger(item.id) || item.id < 1 || item.id === Number.MAX_SAFE_INTEGER) continue;
          const sourceUrl = typeof item.sourceUrl === "string" && /^file:\/\/[^\s\p{Cc}()]+$/u.test(item.sourceUrl)
            ? item.sourceUrl : undefined;
          if ("path" in item) {
            if (!validTempPath(item.path)) continue;
            const image = await loadImagePath(item.path);
            addDraft({ id: item.id, path: item.path, sourceUrl }, imageContent(image), imageLabel(item.id, image.bytes));
          } else {
            if (typeof item.messageId !== "string" || !Number.isSafeInteger(item.imageIndex) || item.imageIndex < 0) continue;
            const images = userContent(ctx.sessionManager.getEntry(item.messageId)).filter((part) => part.type === "image");
            const image = images[item.imageIndex];
            if (!image || typeof item.label !== "string" || !item.label.startsWith(`[Image #${item.id} `) ||
              imageTokens(item.label)[0]?.label !== item.label) continue;
            addDraft({ id: item.id, messageId: item.messageId, imageIndex: item.imageIndex, label: item.label, sourceUrl }, image, item.label);
          }
        }
        if (Number.isSafeInteger(parsed.nextId)) nextAttachmentId = Math.max(nextAttachmentId, parsed.nextId);
        ensureDecorated();
        redraw();
      } catch { await unlink(path).catch(() => {}); }
    }

    cleanupInput = ctx.ui.onTerminalInput((data) => {
      ensureDecorated();
      if (diagnostics.trace && !data.startsWith(PASTE_START)) {
        // Do not log typed prompts or clipboard payloads. Only describe controls.
        if (data.startsWith("\x1b") || /[\x00-\x1f]/.test(data)) {
          diagnostics.lastEvent = JSON.stringify(data.slice(0, 40));
          ctx.ui.setStatus("image-paste-event", `${t.traceLabel}: ${diagnostics.lastEvent}`);
        }
      }
      // Terminal input listeners run before Pi filters Kitty key releases.
      if (isKeyRelease(data) || !isEditorFocused()) return;
      const key = matchesKey(data, "ctrl+v") || matchesKey(data, "alt+v") ||
        getKeybindings().matches(data, "app.clipboard.pasteImage");
      if (key) { void paste(matchesKey(data, "alt+v") ? "Alt+V" : "Ctrl+V"); return { consume: true }; }
      if (pending) {
        // OMP also defers keys, particularly Enter, until attachment loading completes.
        if (queuedInput.length < 4096) queuedInput.push(data);
        return { consume: true };
      }
      const before = ctx.ui.getEditorText();
      queueMicrotask(() => {
        const after = context?.ui.getEditorText();
        if (after !== undefined && after !== before) updateDraftDisplay();
      });
      if (!data.startsWith(PASTE_START) || !data.endsWith(PASTE_END)) return;
      const text = data.slice(PASTE_START.length, -PASTE_END.length);
      if (text && !isImagePath(text)) return;
      void paste(text ? t.pathPaste : t.emptyPaste, text || undefined);
      return { consume: true };
    });

    cleanupTransport = installEnhancedPaste(tui!, {
      write: (data) => tui?.terminal.write(data),
      image: (image) => {
        if (isEditorFocused()) void paste("OSC 5522", undefined, image);
        else ctx.ui.notify(t.dialogNoImages, "warning");
      },
      text: (text) => {
        tui?.getFocusedComponent()?.handleInput?.(`${PASTE_START}${text}${PASTE_END}`);
        tui?.requestRender();
      },
      error: (message) => { ctx.ui.notify(message, "warning"); },
    });
  });

  // Compact chips identify attachments, not a path the model should open.
  // Continue supporting old native Pi clipboard paths for existing drafts.
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };
    const prefix = join(tmpdir(), "pi-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const paths = [...new Set(event.text.match(new RegExp(`${prefix}(?:image-paste|clipboard)-[0-9a-f-]{36}\\.(?:png|jpg|webp|gif)`, "g")) ?? [])];
    const selected = activeDrafts(event.text);
    if (!selected.length && !paths.length) return { action: "continue" };
    if (ctx.model && !ctx.model.input.includes("image")) {
      ctx.ui.setEditorText(event.text);
      redraw();
      ctx.ui.notify(t.modelNoVision, "warning");
      return { action: "handled" };
    }
    const images: ImageContent[] = [...(event.images ?? [])];
    let text = event.text;
    try {
      const labels = images.map(({ data }) => imageLabel(nextAttachmentId++, Buffer.from(data, "base64")));
      const draftLabels = selected.map((draft) => draft.label);
      const linkedLabels = new Map<string, string>();
      for (const draft of selected) {
        images.push(draft.content);
        labels.push(draft.label);
        linkedLabels.set(draft.label, linkImageLabel(draft.label, draft.sourceUrl));
      }
      text = replaceImageLabels(text, (label) => linkedLabels.get(label) ?? label);
      for (const path of paths) {
        const image = await loadImagePath(path);
        const label = imageLabel(nextAttachmentId++, image.bytes);
        labels.push(label);
        images.push(imageContent(image));
        text = text.split(path).join(label);
      }
      text = text.trim();
      submittedDrafts.push({ text, labels, draftLabels });
      return { action: "transform", text, images };
    } catch (error) {
      ctx.ui.setEditorText(event.text);
      redraw();
      ctx.ui.notify(`${t.attachmentFailed}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { action: "handled" };
    }
  });

  pi.on("session_shutdown", async (event) => {
    epoch++;
    cleanupInput?.();
    cleanupTransport?.();
    cleanupDecoration?.();
    cleanupInput = cleanupTransport = cleanupDecoration = undefined;
    pending = undefined;
    queuedInput.length = 0;
    await saveManifest();
    const manifest = manifestPath();
    context = undefined;
    tui = undefined;
    decoratedEditor = undefined;
    // Keep hidden backing files and their mapping across /reload.
    if (event.reason !== "reload") {
      await dropFiles([...createdFiles]);
      if (manifest) await unlink(manifest).catch(() => {});
      createdFiles.clear();
    }
    drafts.clear();
    submittedDrafts.length = 0;
    pendingPreview = undefined;
    treeTargetId = undefined;
    nextAttachmentId = 1;
    manifestSignature = "";
  });
}
