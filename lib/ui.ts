import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  type Component,
  type ImageDimensions,
} from "@earendil-works/pi-tui";

const IMAGE_LABEL = /\[Image #[1-9]\d* [0-9a-f]{6}\]/g;
export const IMAGE_LINK = /(\[Image #\d+(?: [0-9a-f]{6})?\])\((file:\/\/[^\s\p{Cc}()]+)\)/gu;
export const ATTACHED_IMAGES_HEADING = "Attached Images:";

export interface Attachment {
  label: string;
  sourceUrl?: string;
  mimeType: string;
  dimensions: ImageDimensions | null;
}

export function linkImageLabel(label: string, url?: string): string {
  return url ? `${label}(${url})` : label;
}

export function imageSize(mimeType: string, dimensions: ImageDimensions | null): string {
  return dimensions ? `${dimensions.widthPx}x${dimensions.heightPx}` : mimeType.replace("image/", "").toUpperCase();
}

export function imageTokens(text: string): { label: string; start: number; end: number }[] {
  return Array.from(text.matchAll(IMAGE_LABEL), (match) => {
    const label = match[0];
    const start = match.index!;
    return { label, start, end: start + label.length };
  });
}

export function replaceImageLabels(text: string, replace: (label: string) => string): string {
  return text.replace(IMAGE_LABEL, replace);
}

function renderImageLabel(label: string, url?: string): string {
  return url && getCapabilities().hyperlinks ? hyperlink(label, url) : label;
}

function renderImageLink(label: string, url: string, visibleUrl = url): string {
  return `${renderImageLabel(label, url)}(${visibleUrl})`;
}

export function renderImageLinks(text: string): string {
  return text.replace(IMAGE_LINK, (_match, label, url) => renderImageLink(label, url));
}

export class AttachmentList implements Component {
  constructor(
    private items: () => readonly Attachment[],
    private styleLine: (line: string) => string,
    private getOutputPad: () => number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const attachments = this.items();
    if (!attachments.length) return [];
    const padding = Math.min(this.getOutputPad(), Math.floor((width - 1) / 2));
    const margin = " ".repeat(padding);
    const contentWidth = width - 2 * padding;
    const rows = attachments.map((attachment) => {
      const size = imageSize(attachment.mimeType, attachment.dimensions);
      const { label, sourceUrl: url } = attachment;
      const urlWidth = contentWidth - label.length - size.length - 3;
      if (url && urlWidth > 0) {
        return `${renderImageLink(label, url, truncateToWidth(url, urlWidth, "…"))} ${size}`;
      }
      return truncateToWidth(`${renderImageLabel(label, url)} ${size}`, contentWidth, "");
    });
    rows.unshift(truncateToWidth(ATTACHED_IMAGES_HEADING, contentWidth, ""));
    return rows.map((row) => `${margin}${this.styleLine(row)}${margin}`);
  }
}

// Pi has no atom/chip API. Decorate only this editor instance's segment/render
// methods, preserving its history, undo stack and callbacks.
type DecoratableEditor = Component & {
  segment?: (text: string, mode?: string) => Iterable<Intl.SegmentData>;
};

export function decorateImageTokens(editor: DecoratableEditor, lookup: (label: string) => Attachment | undefined): () => void {
  const originalRender = editor.render;
  const originalSegment = editor.segment;
  const render = (width: number) => originalRender.call(editor, width).map((line) =>
    replaceImageLabels(line, (label) => renderImageLabel(label, lookup(label)?.sourceUrl)));
  const segment = (text: string, mode?: string) => {
    const spans = imageTokens(text).filter((token) => lookup(token.label));
    const source = originalSegment!.call(editor, text, mode);
    if (!spans.length) return source;
    const result: Intl.SegmentData[] = [];
    let current = 0;
    let emitted = false;
    for (const part of source) {
      while (current < spans.length && part.index >= spans[current]!.end) {
        current++;
        emitted = false;
      }
      const token = spans[current];
      if (!token || part.index < token.start || part.index >= token.end) {
        result.push(part);
        continue;
      }
      if (emitted) continue;
      result.push({ segment: token.label, index: token.start, input: text });
      emitted = true;
    }
    return result;
  };
  editor.render = render;
  if (originalSegment) editor.segment = segment;
  return () => {
    if (editor.render === render) editor.render = originalRender;
    if (editor.segment === segment) editor.segment = originalSegment;
  };
}
