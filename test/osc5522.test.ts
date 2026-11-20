import assert from "node:assert/strict";
import { test } from "bun:test";
import { EnhancedPaste, Osc5522Input, PASTE_START, PASTE_END, type ImageBytes } from "../lib/core.ts";
import { encoded, fixture, packet } from "./fixtures.ts";
import { tuiModule } from "./pi-host.ts";

const { StdinBuffer } = await tuiModule("dist/stdin-buffer.js");

function transport() {
  const forwarded: string[] = [];
  const packets: string[] = [];
  const errors: string[] = [];
  const filter = new Osc5522Input({ forward: (text) => forwarded.push(text), packet: (text) => packets.push(text), error: (text) => errors.push(text) });
  return { filter, forwarded, packets, errors };
}

function controller() {
  const requests: string[] = [];
  const images: ImageBytes[] = [];
  const texts: string[] = [];
  const errors: string[] = [];
  const enhanced = new EnhancedPaste({ write: (s) => requests.push(s), image: (i) => images.push(i), text: (s) => texts.push(s), error: (s) => errors.push(s) });
  return { enhanced, requests, images, texts, errors };
}

test("OSC 5522 lists MIME then assembles independent base64 chunks", () => {
  const t = controller();
  t.enhanced.handle(packet("status=OK:pw=abc123:loc=primary"));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("text/plain")}`));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`));
  t.enhanced.handle(packet("status=DONE"));
  assert.equal(t.requests.length, 1);
  assert.ok(t.requests[0].includes(`mime=${encoded("image/png")}`));
  assert.ok(t.requests[0].includes("pw=abc123"));
  assert.ok(t.requests[0].includes("loc=primary"));
  t.enhanced.handle(packet("status=OK")); // Read acknowledgement must not reset the read.
  const split = 19;
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`, fixture.subarray(0, split).toString("base64")));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`, fixture.subarray(split).toString("base64")));
  t.enhanced.handle(packet("status=DONE"));
  assert.deepEqual(t.images[0].bytes, fixture);
  assert.equal(t.images[0].mimeType, "image/png");
  assert.equal(t.errors.length, 0);
});

test("Kitty dot-MIME form and text clipboard", () => {
  const t = controller();
  t.enhanced.handle(packet("status=OK"));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded(".")}`, encoded("text/plain text/html .")));
  t.enhanced.handle(packet("status=DONE"));
  assert.equal(t.requests[0], `\x1b]5522;type=read;${encoded("text/plain")}\x07`);
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("text/plain")}`, encoded("café ✓\nhello"), "\x1b\\"));
  t.enhanced.handle(packet("status=DONE"));
  assert.deepEqual(t.texts, ["café ✓\nhello"]);
});

test("malformed payload and unsupported MIME are reported without attaching", () => {
  for (const value of ["%invalid", "a"]) {
    const t = controller();
    t.enhanced.handle(packet("status=OK"));
    t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`));
    t.enhanced.handle(packet("status=DONE"));
    t.enhanced.handle(packet(`status=DATA:mime=${encoded("image/png")}`, value));
    assert.equal(t.errors.length, 1);
    assert.equal(t.images.length, 0);
    t.enhanced.reset();
  }
  const t = controller();
  t.enhanced.handle(packet("status=OK"));
  t.enhanced.handle(packet(`status=DATA:mime=${encoded("application/pdf")}`));
  t.enhanced.handle(packet("status=DONE"));
  assert.equal(t.errors.length, 1);
  assert.equal(t.requests.length, 0);
});

test("fragmented OSC packets are intercepted before stock stdin parser; ordinary keys survive", async () => {
  const t = transport();
  const p = packet(`status=DATA:mime=${encoded("image/png")}`, fixture.toString("base64"), "\x1b\\");
  t.filter.push("a\x1b]");
  await Bun.sleep(2);
  t.filter.push("5522;");
  await Bun.sleep(65); // Longer than Pi's stock incomplete escape timeout.
  for (let n = 7; n < p.length; n++) t.filter.push(p[n]);
  t.filter.push("\x1bv\rcafé ✓");
  assert.deepEqual(t.packets, [p]);
  assert.equal(t.forwarded.join(""), "a\x1bv\rcafé ✓");
  assert.equal(t.errors.length, 0);
  t.filter.dispose();
});

test("OSC-looking text within a fragmented bracketed paste stays literal", () => {
  const t = transport();
  const p = `${PASTE_START}${packet("status=OK")}${PASTE_END}\r`;
  for (const char of p) t.filter.push(char);
  assert.equal(t.forwarded.join(""), p);
  assert.equal(t.packets.length, 0);
  t.filter.dispose();
});

test("empty bracketed paste still reaches Pi's paste event", () => {
  const buffer = new StdinBuffer();
  const pastes = [];
  const filter = new Osc5522Input({ forward: (s) => buffer.process(s), packet: () => {}, error: () => {} });
  buffer.on("paste", (s) => pastes.push(s));
  for (const char of `${PASTE_START}${PASTE_END}`) filter.push(char);
  assert.deepEqual(pastes, [""]);
  filter.dispose();
  buffer.destroy();
});

test("split UTF-8 and bare escape do not corrupt ordinary input", async () => {
  const t = transport();
  const bytes = Buffer.from("café ✓");
  t.filter.push(bytes.subarray(0, 2));
  t.filter.push(bytes.subarray(2));
  t.filter.push("\x1b");
  await Bun.sleep(40);
  assert.equal(t.forwarded.join(""), "café ✓\x1b");
  t.filter.dispose();
});
