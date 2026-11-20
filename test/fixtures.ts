export const fixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYvQAAAAASUVORK5CYII=", "base64");
export const encoded = (text: string) => Buffer.from(text).toString("base64");
export const packet = (header: string, data = "", st = "\x07") => `\x1b]5522;type=read:${header};${data}${st}`;
