import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { afterAll, mock, test } from "bun:test";
import { tuiModule } from "./pi-host.ts";

const tui = await tuiModule("dist/index.js");
const { Editor, KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, setCapabilities } = tui;
const { stripTerminalSequences, visibleWidth } = await tuiModule("dist/utils.js");
// Resolve the UI's peer dependency even when Pi is installed outside the project.
mock.module("@earendil-works/pi-tui", () => tui);
const { AttachmentList, decorateImageTokens, imageTokens } = await import("../lib/ui.ts");
const plain = { images: null, trueColor: true, hyperlinks: false };
const firstLabel = "[Image #1 82a291]";
const secondLabel = "[Image #2 82a291]";
const unstyled = (line: string) => line;
const defaultPadding = () => 1;
afterAll(() => { setCapabilities(plain); process.stdin.pause(); });

function attachment(label: string, dimensions: { widthPx: number; heightPx: number } | null = { widthPx: 901, heightPx: 200 }, sourceUrl?: string) {
  return { label, mimeType: "image/png", dimensions, sourceUrl };
}

test("attachments use one text row per image, including in graphics-capable terminals", () => {
  setCapabilities({ ...plain, images: "kitty" });
  const thirdLabel = "[Image #3 f3b02a]";
  const images = [attachment(firstLabel), attachment(secondLabel, { widthPx: 793, heightPx: 66 }), attachment(thirdLabel, null)];
  const list = new AttachmentList(() => images, unstyled, defaultPadding);
  assert.deepEqual(list.render(100), [" Attached Images: ", ` ${firstLabel} 901x200 `, ` ${secondLabel} 793x66 `, ` ${thirdLabel} PNG `]);
  for (const width of [1, 4, 10, 14, 28]) {
    assert.ok(list.render(width).every((row) => visibleWidth(row) <= width), `overflow at ${width}`);
  }
  images.splice(0, 3);
  assert.deepEqual(list.render(100), []);
});

test("draft rows show source URLs with or without terminal hyperlink support", () => {
  const url = pathToFileURL("/tmp/image with spaces.png").href;
  const screenshot = { ...attachment(secondLabel), path: "/tmp/pi-image-paste-example.png" };
  const list = new AttachmentList(() => [attachment(firstLabel, undefined, url), screenshot], unstyled, defaultPadding);
  const expected = [" Attached Images: ", ` ${firstLabel}(${url}) 901x200 `, ` ${secondLabel} 901x200 `];
  setCapabilities(plain);
  assert.deepEqual(list.render(100), expected);
  setCapabilities({ ...plain, hyperlinks: true });
  const rows = list.render(100);
  assert.deepEqual(rows.map(stripTerminalSequences), expected);
  assert.equal(rows[1], ` \x1b]8;;${url}\x1b\\${firstLabel}\x1b]8;;\x1b\\(${url}) 901x200 `);
  assert.equal(rows[2], expected[2]);
  const narrow = list.render(36)[1];
  assert.ok(visibleWidth(narrow) <= 36);
  assert.match(stripTerminalSequences(narrow), /^ \[Image #1 82a291\]\(file:.*…\) 901x200 $/);
});

test("real Pi editor treats an image label as one grapheme and links it without changing editor text", () => {
  setCapabilities({ ...plain, hyperlinks: true });
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.undo": "alt+z" }));
  const tui = { terminal: { rows: 40 }, requestRender() {} };
  const editor = new Editor(tui, { borderColor: (text) => text, selectList: {} });
  const originalSegment = editor.segment;
  const originalRender = editor.render;
  const url = pathToFileURL("/tmp/original.png").href;
  const restore = decorateImageTokens(editor, (label) => label === firstLabel ? attachment(label, undefined, url) : undefined);
  editor.setText(`prefix ${firstLabel}`);
  assert.equal([...editor.segment(editor.getText(), "grapheme")].at(-1).segment, firstLabel);
  const lines = editor.render(80);
  assert.ok(lines.some((line) => line.includes(`\x1b]8;;${url}`)));
  assert.ok(lines.map(stripTerminalSequences).some((line) => line.includes(`prefix ${firstLabel}`)));
  editor.handleInput("\x7f");
  assert.equal(editor.getText(), "prefix ");
  editor.handleInput("\x1bz");
  assert.equal(editor.getText(), `prefix ${firstLabel}`);
  editor.handleInput("\x1b[D");
  assert.equal(editor.getCursor().col, "prefix ".length);
  editor.handleInput("\x1b[3~");
  assert.equal(editor.getText(), "prefix ");
  restore();
  assert.equal(editor.segment, originalSegment);
  assert.equal(editor.render, originalRender);
});

test("token parser requires a number and six hexadecimal characters", () => {
  const tenthLabel = "[Image #10 45a3b7]";
  const text = `${firstLabel} [Image #1] [Image 82a291] [Image #1 82a291a] [Image #1 82a29] [Image #1 82a29g] ${tenthLabel} ${firstLabel}`;
  assert.deepEqual(imageTokens(text).map((token) => token.label), [firstLabel, tenthLabel, firstLabel]);
});
