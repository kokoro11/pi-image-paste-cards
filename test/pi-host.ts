// Locate the host Pi install so tests use the exact runtime the extension targets.
// Order: PI_PACKAGE_DIR, a local package, then Bun's global install.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const NAME = "@earendil-works/pi-coding-agent";

function findPi() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  try {
    candidates.push(dirname(Bun.resolveSync(`${NAME}/package.json`, import.meta.dir)));
  } catch {}
  const bunInstall = process.env.BUN_INSTALL || join(homedir(), ".bun");
  candidates.push(join(bunInstall, "install", "global", "node_modules", NAME));
  const found = candidates.find((dir) => existsSync(join(dir, "dist/core/extensions/loader.js")));
  if (!found) throw new Error(`Cannot find ${NAME}. Install Pi with Bun or set PI_PACKAGE_DIR to the installed Pi package.`);
  return found;
}

const piDir = findPi();

const tuiDir = dirname(Bun.resolveSync("@earendil-works/pi-tui/package.json", piDir));

export const piModule = (path: string) => import(pathToFileURL(join(piDir, path)).href);
export const tuiModule = (path: string) => import(pathToFileURL(join(tuiDir, path)).href);
