import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, onTestFinished, spyOn, test } from "bun:test";
import { PASTE_START, PASTE_END } from "../lib/core.ts";
import { encoded, fixture, packet } from "./fixtures.ts";
import { piModule, tuiModule } from "./pi-host.ts";

afterAll(() => process.stdin.pause());
const { stripTerminalSequences } = await tuiModule("dist/utils.js");
const { loadExtensions } = await piModule("dist/core/extensions/loader.js");
const { SessionManager } = await piModule("dist/core/session-manager.js");
const { setCapabilities } = await tuiModule("dist/terminal-image.js");
const { getNativeClipboard } = await tuiModule("dist/native-platform.js");
const { initTheme, theme } = await piModule("dist/modes/interactive/theme/theme.js");
initTheme("dark");
const EXTENSION = fileURLToPath(new URL("../extensions/image-paste.ts", import.meta.url));

const fixtureLabel = "[Image #1 82a291]";
const previewHeading = "Attached Images:";
const plainLines = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const sleep = Bun.sleep;

async function harness({ initialText = "", sessionManager = SessionManager.inMemory(), onNativeInput = (_data: string) => {} } = {}) {
  const loaded = await loadExtensions([EXTENSION], "/tmp");
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const appendedEntries = [];
  loaded.runtime.appendEntry = (customType, data) => {
    appendedEntries.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };
  const settings = { outputPad: 1 };
  loaded.runtime.getSettings = () => settings;
  let text = initialText;
  let listener;
  let widget;
  let pasteFinished: Promise<void> | undefined;
  let completePaste: (() => void) | undefined;
  const notifications = [];
  const received = [];
  const writes = [];
  const focus = { getExpandedText: () => text, render: () => [text], invalidate() {}, handleInput: (data) => {
    received.push(data);
    if (data.startsWith(PASTE_START)) text += data.slice(PASTE_START.length, -PASTE_END.length);
  } };
  const handleNativeInput = (data: string) => { received.push(data); onNativeInput(data); };
  let nativeHandler = handleNativeInput;
  const terminal = {
    stdinDataHandler: nativeHandler,
    setupStdinBuffer() { this.stdinDataHandler = nativeHandler = (data) => handleNativeInput(data); },
    stop() { process.stdin.removeListener("data", this.stdinDataHandler); this.stdinDataHandler = undefined; },
    write(s) { writes.push(s); },
  };
  const originalSetup = terminal.setupStdinBuffer;
  const originalStop = terminal.stop;
  const tui = { terminal, requestRender() {}, getFocusedComponent: () => focus, hasOverlay: () => false };
  const ctx = {
    mode: "tui", cwd: "/tmp", model: { input: ["text", "image"] },
    sessionManager,
    ui: {
      notify(message, type) { notifications.push({ message, type }); },
      setStatus(key: string, status: string | undefined) {
        if (key !== "image-paste") return;
        if (status === undefined) completePaste?.();
        else pasteFinished = new Promise<void>((resolve) => { completePaste = resolve; });
      },
      setWidget(_key, factory) { widget = factory(tui, theme); },
      pasteToEditor(s) { text += s; },
      getEditorText() { return text; },
      setEditorText(s) { text = s; },
      onTerminalInput(handler) { listener = handler; return () => { listener = undefined; }; },
    },
  };
  const emit = async (name, event) => {
    let result;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const listenersBefore = process.stdin.listenerCount("data");
  process.stdin.on("data", terminal.stdinDataHandler);
  await emit("session_start", { reason: "startup" });
  return {
    ctx, extension, notifications, received, writes, terminal, emit, appendedEntries, settings,
    get text() { return text; },
    render(width = 100) { return widget.render(width); },
    renderEditor() { return focus.render(100); },
    async draftFile() {
      const sessionId = sessionManager.getSessionId();
      const manifest = JSON.parse(await readFile(join(tmpdir(), `pi-image-paste-draft-${sessionId}.json`), "utf8"));
      return manifest.images[0].path;
    },
    input(data) { return listener(data); },
    waitForPaste() {
      assert.ok(pasteFinished, "paste did not start");
      return pasteFinished;
    },
    async close(reason = "quit") {
      await emit("session_shutdown", { reason });
      assert.equal(terminal.setupStdinBuffer, originalSetup);
      assert.equal(terminal.stop, originalStop);
      assert.equal(terminal.stdinDataHandler, nativeHandler);
      assert.equal(process.stdin.listenerCount("data"), listenersBefore + 1);
      process.stdin.removeListener("data", nativeHandler);
      assert.equal(process.stdin.listenerCount("data"), listenersBefore);
    },
  };
}

test("command stages readable image and input hook sends real image content", async () => {
  const h = await harness();
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const image = join(dir, "my image.png");
    await writeFile(image, fixture);
    await h.extension.commands.get("paste-image").handler(`"${image}"`, h.ctx);
    assert.equal(h.text.trim(), fixtureLabel);
    assert.ok(!h.text.includes("/tmp/"));
    const path = await h.draftFile();
    assert.deepEqual(await readFile(path), fixture);
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const url = pathToFileURL(image).href;
    assert.deepEqual(plainLines(h.render(240)), [` ${previewHeading}`, ` ${fixtureLabel}(${url}) 1x1`]);
    assert.ok(h.renderEditor()[0].includes(`\x1b]8;;${url}`));
    const event = { source: "interactive", text: `look at ${h.text.trim()}`, images: [{ type: "image", data: fixture.toString("base64"), mimeType: "image/png" }] };
    const result = await h.emit("input", event);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 2);
    assert.equal(result.images[1].data, fixture.toString("base64"));
    assert.equal(result.text, `look at ${fixtureLabel}(${url})`);
    const fromPath = await h.emit("input", { source: "interactive", text: `look at ${path}` });
    assert.equal(fromPath.action, "transform");
    assert.equal(fromPath.text, "look at [Image #3 82a291]");
    assert.equal(fromPath.images[0].data, fixture.toString("base64"));
    assert.deepEqual(await h.emit("input", { source: "extension", text: path }), { action: "continue" });
    assert.deepEqual(await h.emit("input", { source: "interactive", text: "ordinary prompt" }), { action: "continue" });
    h.ctx.model.input = ["text"];
    assert.equal((await h.emit("input", { source: "interactive", text: h.text })).action, "handled");
    assert.ok(h.notifications.some((n) => /does not accept images/.test(n.message)));
    await h.close();
    await assert.rejects(access(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const { key, modifier, mime, contents, expected } of [
  { key: "Ctrl+V", modifier: 5, mime: "image/png", contents: fixture, expected: `${fixtureLabel} ` },
  { key: "Alt+V", modifier: 3, mime: "text/plain", contents: "café ✓\nhello", expected: "café ✓\nhello" },
]) {
  test(`${key} does not paste ${mime} again on Kitty key release`, async () => {
    const waylandDisplay = process.env.WAYLAND_DISPLAY;
    process.env.WAYLAND_DISPLAY = "test-clipboard";
    const spawn = childProcess.spawn;
    const spawnMock = spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
      if (command === "powershell.exe") {
        assert.match(args.at(-1), /Get-Clipboard -Format FileDropList/);
        return spawn(process.execPath, ["-e", ""], options);
      }
      assert.equal(command, "wl-paste");
      const output = args[0] === "--list-types" ? mime : contents;
      return spawn(process.execPath, [
        "-e", "process.stdout.write(Buffer.from(process.argv[1], 'base64'))",
        Buffer.from(output).toString("base64"),
      ], options);
    });
    onTestFinished(() => {
      spawnMock.mockRestore();
      if (waylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = waylandDisplay;
    });

    const h = await harness();
    onTestFinished(() => h.close());

    assert.deepEqual(h.input(`\x1b[118;${modifier}u`), { consume: true });
    await h.waitForPaste();
    assert.equal(h.text, expected);

    // Send the release after the first paste has finished, when it could trigger a new read.
    const release = h.input(`\x1b[118;${modifier}:3u`);
    await h.waitForPaste();
    assert.equal(h.text, expected);
    assert.equal(release, undefined);
  });
}

test("bracketed image path paste defers Enter until attachment is ready", async () => {
  const h = await harness();
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const path = join(dir, "test.png");
    await writeFile(path, fixture);
    assert.equal(h.input(`${PASTE_START}${path}${PASTE_END}`).consume, true);
    assert.equal(h.input("\r").consume, true);
    assert.equal(h.received.includes("\r"), false);
    for (let n = 0; n < 100 && !h.received.includes("\r"); n++) await sleep(5);
    assert.equal(h.text.trim(), fixtureLabel);
    assert.equal(h.received.includes("\r"), true);
    assert.equal(h.input(`${PASTE_START}ordinary\ntext${PASTE_END}`), undefined);
    await h.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "win32")("Explorer file copies keep the original hyperlink even when image bytes are offered", async () => {
  const native = getNativeClipboard();
  assert.ok(native);
  const imageMock = spyOn(native, "getImage").mockResolvedValue(fixture);
  const textMock = spyOn(native, "getText").mockResolvedValue(null);
  const spawn = childProcess.spawn;
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  const original = join(dir, "尺寸 (1).png");
  const spawnMock = spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
    assert.equal(command, "powershell.exe");
    assert.match(args.at(-1), /Get-Clipboard -Format FileDropList/);
    return spawn(process.execPath, ["-e", "console.log(process.argv[1])", original], options);
  });
  try {
    await writeFile(original, fixture);
    const h = await harness();
    try {
      setCapabilities({ images: null, trueColor: true, hyperlinks: true });
      assert.deepEqual(h.input("\x1b[118;5u"), { consume: true });
      await h.waitForPaste();
      assert.equal(h.text.trim(), fixtureLabel);
      const link = pathToFileURL(original).href.replace("(", "%28").replace(")", "%29");
      const linkedLabel = `${fixtureLabel}(${link})`;
      const expectedRow = `${linkedLabel} 1x1`;
      assert.ok(h.renderEditor()[0].includes(`\x1b]8;;${link}`));
      assert.deepEqual(plainLines(h.render(240)), [` ${previewHeading}`, ` ${expectedRow}`]);
      const unpadded = [previewHeading, expectedRow];
      h.settings.outputPad = 0;
      assert.deepEqual(plainLines(h.render(240)), unpadded);
      assert.ok(h.render(240)[0].startsWith(theme.fg("toolOutput", previewHeading)));
      const result = await h.emit("input", { source: "interactive", text: h.text });
      assert.equal(result.text, linkedLabel);
      assert.equal(result.images[0].data, fixture.toString("base64"));
      h.ctx.ui.setEditorText("");
      const message = { role: "user", content: [{ type: "text", text: result.text }, ...result.images] };
      await h.emit("message_end", { message });
      const modelMessage = structuredClone(message);
      await h.emit("context", { messages: [modelMessage] });
      assert.equal(modelMessage.content[0].text, fixtureLabel);
      const preview = h.appendedEntries[0];
      assert.deepEqual(preview.data, { text: unpadded.join("\n") });
      const renderer = h.extension.entryRenderers.get(preview.customType);
      const lines = renderer(preview, { expanded: false }, theme).render(240);
      assert.ok(lines[0].startsWith(theme.fg("toolOutput", previewHeading)));
      assert.ok(lines[1].includes(`\x1b]8;;${link}`));
      assert.deepEqual(plainLines(lines), unpadded);
      setCapabilities({ images: null, trueColor: true, hyperlinks: false });
      assert.deepEqual(plainLines(renderer(preview, { expanded: false }, theme).render(240)), unpadded);
      await access(original);
    } finally { await h.close(); }
  } finally {
    spawnMock.mockRestore();
    textMock.mockRestore();
    imageMock.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reload preserves draft attachment and new runtime reattaches it", async () => {
  const first = await harness();
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const path = join(dir, "test.png");
    await writeFile(path, fixture);
    await first.extension.commands.get("paste-image").handler(path, first.ctx);
    const draft = first.text.trim();
    const backingFile = await first.draftFile();
    await first.close("reload");
    await access(backingFile);
    const second = await harness({ initialText: draft, sessionManager: first.ctx.sessionManager });
    assert.deepEqual(plainLines(second.render(240)), [` ${previewHeading}`, ` ${fixtureLabel}(${pathToFileURL(path).href}) 1x1`]);
    const result = await second.emit("input", { source: "interactive", text: draft });
    assert.equal(result.action, "transform");
    assert.equal(result.text, `${fixtureLabel}(${pathToFileURL(path).href})`);
    assert.equal(result.images[0].mimeType, "image/png");
    await second.close();
    await assert.rejects(access(backingFile));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("image numbers advance across turns, reload, and restart of the same session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-numbering-"));
  const sessionManager = SessionManager.create(dir, dir);
  const sessionFile = sessionManager.getSessionFile();
  const path = join(dir, "image.png");
  const url = pathToFileURL(path).href;
  const label = (id: number) => `[Image #${id} 82a291]`;
  const staged: string[] = [];

  async function sendImages(h: Awaited<ReturnType<typeof harness>>, count: number) {
    for (let i = 0; i < count; i++) await h.extension.commands.get("paste-image").handler(path, h.ctx);
    staged.push(h.text.trim());
    const result = await h.emit("input", { source: "interactive", text: h.text });
    assert.equal(result.images.length, count);
    h.ctx.ui.setEditorText("");
    const message = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: result.text }, ...result.images] };
    await h.emit("message_end", { message });
    h.ctx.sessionManager.appendMessage(message);
    await h.emit("context", { messages: [message] });
  }

  try {
    await writeFile(path, fixture);
    const first = await harness({ sessionManager });
    try {
      await sendImages(first, 3);
      await sendImages(first, 3);
    } finally { await first.close("reload"); }

    const reloaded = await harness({ sessionManager: SessionManager.open(sessionFile) });
    try { await sendImages(reloaded, 1); }
    finally { await reloaded.close(); }

    const restarted = await harness({ sessionManager: SessionManager.open(sessionFile) });
    try { await sendImages(restarted, 1); }
    finally { await restarted.close(); }

    const turns = [[1, 2, 3], [4, 5, 6], [7], [8]];
    assert.deepEqual(staged, turns.map((ids) => ids.map(label).join(" ")));
    const entries = SessionManager.open(sessionFile).getEntries();
    const previews = entries.filter((entry) => entry.type === "custom" && entry.customType === "image-paste-preview");
    assert.deepEqual(previews.map(({ data }) => data.text),
      turns.map((ids) => [previewHeading, ...ids.map((id) => `${label(id)}(${url}) 1x1`)].join("\n")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("tree navigation restores a sent image as a linked draft that can be reloaded and sent again", async () => {
  const sessionManager = SessionManager.inMemory();
  const parentId = sessionManager.appendMessage({ role: "user", timestamp: 1, content: "Earlier prompt" });
  const label = "[Image #17 b9a1d7]";
  const url = pathToFileURL(join(tmpdir(), "original image.png")).href;
  const text = `Look at ${label}(${url})`;
  // Pi can resize the image after the label checksum has been assigned.
  const image = { type: "image", data: fixture.toString("base64"), mimeType: "image/png" };
  const targetId = sessionManager.appendMessage({ role: "user", timestamp: 2, content: [{ type: "text", text }, image] });
  const oldLeafId = sessionManager.appendCustomEntry("image-paste-preview", { text: `${previewHeading}\n${label}(${url}) 1x1` });
  const preparation = { targetId, oldLeafId, commonAncestorId: targetId, entriesToSummarize: [], userWantsSummary: false };
  setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  const h = await harness({ sessionManager });
  let draft = "";
  let restored = false;
  try {
    await h.emit("session_before_tree", { preparation, signal: new AbortController().signal });
    sessionManager.branch(parentId);
    await h.emit("session_tree", { newLeafId: parentId, oldLeafId });
    // Pi falls back to text-only prefill if the extension leaves the editor empty.
    if (!h.text.trim()) h.ctx.ui.setEditorText(text);
    draft = h.text;
    assert.deepEqual(plainLines(h.render(240)), [` ${previewHeading}`, ` ${label}(${url}) 1x1`]);
    assert.equal(draft, `Look at ${label}`);
    assert.ok(h.renderEditor()[0].includes(`\x1b]8;;${url}`));
    restored = true;
  } finally {
    await h.close(restored ? "reload" : "quit");
  }

  const reloaded = await harness({ sessionManager, initialText: draft });
  try {
    assert.deepEqual(plainLines(reloaded.render(240)), [` ${previewHeading}`, ` ${label}(${url}) 1x1`]);
    const result = await reloaded.emit("input", { source: "interactive", text: draft });
    assert.deepEqual(result, { action: "transform", text, images: [image] });
  } finally { await reloaded.close(); }
});

test("restarting the terminal from a key does not replay it and keeps OSC paste enabled", async () => {
  let confirms = 0;
  const h = await harness({
    onNativeInput(data) {
      // Pi's settings handler stops and restarts the terminal on Enter.
      if (data !== "\r" || ++confirms !== 1) return;
      h.terminal.stop();
      h.terminal.setupStdinBuffer();
      process.stdin.on("data", h.terminal.stdinDataHandler);
    },
  });
  try {
    h.terminal.stdinDataHandler("\r");
    assert.equal(confirms, 1);
    assert.equal(h.writes.filter((s) => s === "\x1b[?5522h").length, 2);
    h.terminal.stdinDataHandler(packet("status=OK"));
    h.terminal.stdinDataHandler(packet(`status=DATA:mime=${encoded("text/plain")}`));
    h.terminal.stdinDataHandler(packet("status=DONE"));
    h.terminal.stdinDataHandler(packet(`status=DATA:mime=${encoded("text/plain")}`, encoded("hello ✓")));
    h.terminal.stdinDataHandler(packet("status=DONE"));
    assert.ok(h.received.includes(`${PASTE_START}hello ✓${PASTE_END}`));
  } finally {
    await h.close();
  }
});

test("an unreadable source is pasted as a file link without an attachment", async () => {
  const h = await harness();
  const path = join(tmpdir(), "permission [denied].png");
  const link = `[permission \\[denied\\].png](${pathToFileURL(path).href})`;
  const stat = fs.stat;
  const statMock = spyOn(fs, "stat").mockImplementation(async (candidate, ...args) => {
    if (candidate === path) throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
    return stat(candidate, ...args);
  });
  try {
    await h.extension.commands.get("paste-image").handler(path, h.ctx);
    assert.equal(h.text.trim(), link);
    assert.deepEqual(h.render(), []);
    assert.equal(h.notifications[0]?.type, "warning");
    assert.match(h.notifications[0]?.message, /EPERM/);
    assert.deepEqual(await h.emit("input", { source: "interactive", text: h.text }), { action: "continue" });
    const message = { role: "user", content: [{ type: "text", text: h.text.trim() }] };
    await h.emit("message_end", { message });
    await h.emit("context", { messages: [message] });
    assert.deepEqual(h.appendedEntries, []);
  } finally {
    statMock.mockRestore();
    await h.close();
  }
});

test("identical drafts keep their numbers and checksum when reordered and sent", async () => {
  const h = await harness();
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const path = join(dir, "test-image");
    const secondPath = join(dir, "another-image.png");
    await writeFile(path, fixture);
    await writeFile(secondPath, fixture);
    await h.extension.commands.get("paste-image").handler(path, h.ctx);
    await h.extension.commands.get("paste-image").handler(secondPath, h.ctx);
    const backing = await h.draftFile();
    const url = pathToFileURL(path).href;
    const secondUrl = pathToFileURL(secondPath).href;
    const duplicateLabel = "[Image #2 82a291]";
    const rows = [`${fixtureLabel}(${url}) 1x1`, `${duplicateLabel}(${secondUrl}) 1x1`];
    assert.deepEqual(plainLines(h.render(240)), [` ${previewHeading}`, ` ${rows[0]}`, ` ${rows[1]}`]);
    assert.equal(h.text.trim(), `${fixtureLabel} ${duplicateLabel}`);
    assert.equal(h.input(" "), undefined);
    h.ctx.ui.setEditorText(`${duplicateLabel} ${fixtureLabel} OCR`);
    // The terminal listener persists the new order before shutdown or submission.
    let firstSavedPath = backing;
    for (let n = 0; n < 100 && firstSavedPath === backing; n++) {
      await sleep(5);
      firstSavedPath = await h.draftFile().catch(() => backing);
    }
    assert.notEqual(firstSavedPath, backing);
    assert.deepEqual(plainLines(h.render(240)), [` ${previewHeading}`, ` ${rows[1]}`, ` ${rows[0]}`]);
    const result = await h.emit("input", { source: "interactive", text: h.text });
    assert.equal(result.text, `${duplicateLabel}(${secondUrl}) ${fixtureLabel}(${url}) OCR`);
    assert.equal(result.images.length, 2);
    h.ctx.ui.setEditorText("");
    assert.deepEqual(h.render(), []);
    // Pi replaces resized images and appends a dimension note to the prompt.
    const resized = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
    const finalText = `${result.text}\n\n[Image: original 2x2, displayed at 1x1. Multiply coordinates by 2.00 to map to original image.]`;
    const message = { role: "user", timestamp: 123456, content: [{ type: "text", text: finalText }, resized, result.images[1]] };
    await h.emit("message_end", { message });
    await h.emit("context", { messages: [message] });
    // The message owns the bytes now, so the draft file must be gone immediately.
    for (let n = 0; n < 100 && await access(backing).then(() => true, () => false); n++) await sleep(10);
    await assert.rejects(access(backing));
    await access(path); // the user's own source file is untouched
    assert.deepEqual(h.appendedEntries, [{
      customType: "image-paste-preview",
      data: { text: `${previewHeading}\n${rows[1]}\n${rows[0]}` },
    }]);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi persists preview text after each image message and replays it in order", async () => {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await piModule("dist/index.js");
  const { AuthStorage } = await piModule("dist/core/auth-storage.js");
  const { InteractiveMode } = await piModule("dist/modes/interactive/interactive-mode.js");
  const { UserMessageComponent } = await piModule("dist/modes/interactive/components/user-message.js");
  const { Container } = await tuiModule("dist/tui.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-session-"));
  try {
    const settingsManager = SettingsManager.inMemory();
    const sessionManager = SessionManager.create(dir, dir);
    const modelRuntime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false,
    });
    const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model);
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager, additionalExtensionPaths: [EXTENSION],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({ model, modelRuntime, settingsManager, sessionManager, resourceLoader, agentDir: dir, noTools: "all" });
    try {
      const errors = [];
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
      const image = { type: "image", data: fixture.toString("base64"), mimeType: "image/png" };
      const imageMessage = (text) => ({ role: "user", timestamp: Date.now(), content: [{ type: "text", text }, image] });
      const secondLabel = "[Image #2 82a291]";
      const url = pathToFileURL(join(dir, "original.png")).href;
      const linkedLabel = `${fixtureLabel}(${url})`;
      const deniedUrl = pathToFileURL(join(dir, "permission denied.png")).href;
      const deniedLink = `[permission denied.png](${deniedUrl})`;
      const readEntries = async () => (await readFile(sessionManager.getSessionFile(), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "custom" || (entry.type === "message" && entry.message.role === "user"));
      let persistedBeforeRequest;
      let requestMessages;
      session.agent.streamFunction = async (_model, context) => {
        persistedBeforeRequest = await readEntries();
        requestMessages = context.messages.filter((message) => message.role === "user");
        throw new Error("Offline test");
      };
      await session.agent.prompt([
        imageMessage(`First ${linkedLabel}`),
        imageMessage(`Second ${secondLabel}`),
        { role: "user", timestamp: Date.now(), content: [{ type: "text", text: deniedLink }] },
      ]);
      assert.deepEqual(errors, []);
      const entries = await readEntries();
      assert.deepEqual(entries.map((entry) => entry.type), ["message", "custom", "message", "custom", "message"]);
      assert.deepEqual(persistedBeforeRequest, entries);
      assert.equal(requestMessages[0].content[0].text, `First ${fixtureLabel}`);
      assert.equal(requestMessages[0].content[1].data, image.data);
      assert.equal(entries[0].message.content[0].text, `First ${linkedLabel}`);
      for (const index of [1, 3]) {
        assert.equal(entries[index].parentId, entries[index - 1].id);
        assert.equal(entries[index].customType, "image-paste-preview");
      }
      const linkedPreviewRow = `${linkedLabel} 1x1`;
      assert.deepEqual(entries[1].data, { text: `${previewHeading}\n${linkedPreviewRow}` });
      assert.deepEqual(entries[3].data, { text: `${previewHeading}\n${secondLabel} 1x1` });

      setCapabilities({ images: null, trueColor: true, hyperlinks: true });
      const chatContainer = new Container();
      const chat = { session, chatContainer, toolOutputExpanded: false };
      let reloadedLines;
      await session.reload({
        beforeSessionStart() {
          const replay = SessionManager.open(sessionManager.getSessionFile()).buildContextEntries();
          for (const entry of replay) {
            if (entry.type === "message" && entry.message.role === "user") {
              chatContainer.addChild(new UserMessageComponent(entry.message.content[0].text));
            } else if (entry.type === "custom") {
              InteractiveMode.prototype.addCustomEntryToChat.call(chat, entry);
            }
          }
          reloadedLines = chatContainer.render(240);
        },
      });
      assert.equal(reloadedLines.filter((line) => line.includes(`\x1b]8;;${url}`)).length, 2);
      assert.equal(reloadedLines.filter((line) => line.includes(`\x1b]8;;${deniedUrl}`)).length, 1);
      assert.deepEqual(plainLines(reloadedLines).filter((line) => line.trim() === previewHeading), [` ${previewHeading}`, ` ${previewHeading}`]);
      assert.deepEqual(reloadedLines.map((line) => stripTerminalSequences(line).trim()).filter(Boolean), [
        "First Image #1 82a291", previewHeading, linkedPreviewRow,
        `Second ${secondLabel}`, previewHeading, `${secondLabel} 1x1`,
        "permission denied.png",
      ]);
    } finally {
      session.dispose();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("startup sweeps stale temp files from crashed runs only", async () => {
  const { utimes } = await import("node:fs/promises");
  const old = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const stale = [join(tmpdir(), `pi-image-paste-${randomUUID()}.png`), join(tmpdir(), `pi-image-paste-draft-${randomUUID()}.json`)];
  const fresh = join(tmpdir(), `pi-image-paste-${randomUUID()}.png`);
  const foreign = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  const oldForeign = join(tmpdir(), `other-tool-${randomUUID()}.png`);
  for (const path of [...stale, foreign, oldForeign]) await writeFile(path, "x");
  await writeFile(fresh, "x");
  for (const path of [...stale, oldForeign]) await utimes(path, old(8), old(8));
  try {
    const h = await harness();
    onTestFinished(() => h.close());
    for (const path of stale) {
      for (let n = 0; n < 100 && await access(path).then(() => true, () => false); n++) await sleep(10);
      await assert.rejects(access(path), `${path} should be swept`);
    }
    await access(fresh);
    await access(foreign);
    await access(oldForeign);
  } finally {
    for (const path of [...stale, fresh, foreign, oldForeign]) await rm(path, { force: true });
  }
});

test("BMP file path is converted to PNG without changing system clipboard", async () => {
  const h = await harness();
  onTestFinished(() => h.close());
  const dir = await mkdtemp(join(tmpdir(), "pi-paste-test-"));
  try {
    const path = join(dir, "test.bmp");
    // A 2×2, 24-bit BMP with red, green, blue and white pixels.
    const bmp = Buffer.from("Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAA/wAA////AAAAAP8A/wAAAA==", "base64");
    await writeFile(path, bmp);
    await h.extension.commands.get("paste-image").handler(path, h.ctx);
    const result = await h.emit("input", { source: "interactive", text: h.text });
    assert.equal(result.action, "transform", JSON.stringify(h.notifications));
    const [image] = result.images;
    assert.equal(image.mimeType, "image/png");
    const png = Buffer.from(image.data, "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 2);
    assert.equal(png.readUInt32BE(20), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
