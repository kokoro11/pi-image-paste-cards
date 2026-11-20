import {
  getCapabilities,
  getImageDimensions,
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

export function imageDimensions(data: string, mimeType: string): ImageDimensions | null {
  // Pi decodes the whole base64 argument. PNG, GIF and WebP need at most 30
  // bytes; JPEG may put the size after multiple large metadata segments.
  const jpeg = mimeType === "image/jpeg";
  const limit = jpeg ? 96 * 1024 : 40;
  const dimensions = getImageDimensions(data.slice(0, limit), mimeType);
  return dimensions ?? (jpeg && data.length > limit ? getImageDimensions(data, mimeType) : null);
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
    const rows = [`${margin}${this.styleLine(truncateToWidth(ATTACHED_IMAGES_HEADING, contentWidth, ""))}${margin}`];
    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i]!;
      const size = imageSize(attachment.mimeType, attachment.dimensions);
      const { label, sourceUrl: url } = attachment;
      const urlWidth = contentWidth - label.length - size.length - 3;
      const row = url && urlWidth > 0
        ? `${renderImageLink(label, url, truncateToWidth(url, urlWidth, "…"))} ${size}`
        : truncateToWidth(`${renderImageLabel(label, url)} ${size}`, contentWidth, "");
      rows.push(`${margin}${this.styleLine(row)}${margin}`);
    }
    return rows;
  }
}

// Pi has no atom/chip API. Decorate only this editor instance's segment/render
// methods, preserving its history, undo stack and callbacks.
type DecoratableEditor = Component & {
  segment?: (text: string, mode?: string) => Iterable<Intl.SegmentData>;
};

export function decorateImageTokens(editor: DecoratableEditor, attachments: ReadonlyMap<string, Attachment>): () => void {
  const originalRender = editor.render;
  const originalSegment = editor.segment;
  const render = (width: number) => {
    const lines = originalRender.call(editor, width);
    if (!attachments.size || !getCapabilities().hyperlinks) return lines;
    return lines.map((line) => replaceImageLabels(line, (label) => {
      const url = attachments.get(label)?.sourceUrl;
      return url ? hyperlink(label, url) : label;
    }));
  };
  const segment = originalSegment && ((text: string, mode?: string) => {
    const source = originalSegment.call(editor, text, mode);
    if (!attachments.size || !text.includes("[Image #")) return source;
    const spans = imageTokens(text).filter((token) => attachments.has(token.label));
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
      if (!token || part.index < token.start) {
        result.push(part);
        continue;
      }
      if (emitted) continue;
      result.push({ segment: token.label, index: token.start, input: text });
      emitted = true;
    }
    return result;
  });
  editor.render = render;
  if (segment) editor.segment = segment;
  return () => {
    if (editor.render === render) editor.render = originalRender;
    if (editor.segment === segment) editor.segment = originalSegment;
  };
}
