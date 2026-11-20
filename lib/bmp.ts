import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { t } from "./messages.ts";

let magick: Promise<typeof import("@imagemagick/magick-wasm")> | undefined;

async function loadMagick() {
  const codec = await import("@imagemagick/magick-wasm");
  const wasmPath = createRequire(import.meta.url).resolve("@imagemagick/magick-wasm/magick.wasm");
  await codec.initializeImageMagick(await readFile(wasmPath));
  // Limit the pixel cache used to decode compressed BMPs.
  codec.ResourceLimits.memory = 256n * 1024n * 1024n;
  codec.ResourceLimits.disk = 0n;
  return codec;
}

export async function bmpToPng(bytes: Buffer, maxBytes: number): Promise<Buffer> {
  try {
    const { ImageMagick, MagickFormat } = await (magick ??= loadMagick());
    return ImageMagick.read(bytes, MagickFormat.Bmp, (image) =>
      image.write(MagickFormat.Png, (png) => {
        if (png.length > maxBytes) throw new Error(t.imageTooLarge);
        // The output view points into WASM memory that is freed after the callback.
        return Buffer.from(png);
      }));
  } catch (cause) {
    throw new Error(t.bmpFailed, { cause });
  }
}
