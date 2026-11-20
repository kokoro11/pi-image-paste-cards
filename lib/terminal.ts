import type { TUI } from "@earendil-works/pi-tui";
import { EnhancedPaste, Osc5522Input } from "./core.ts";

// ProcessTerminal has no public pre-parser input hook. Wrap only its instance
// handler, restoring it on shutdown/reload; never patch installed Pi files.
type ParserTerminal = TUI["terminal"] & {
  setupStdinBuffer?: () => void;
  stdinDataHandler?: (data: Buffer | string) => void;
};

export function installEnhancedPaste(tui: TUI, callbacks: ConstructorParameters<typeof EnhancedPaste>[0]): () => void {
  const terminal = tui.terminal as ParserTerminal;
  if (!terminal.setupStdinBuffer || !terminal.stdinDataHandler) return () => {};
  const enhanced = new EnhancedPaste(callbacks);
  const originalSetup = terminal.setupStdinBuffer;
  const originalStop = terminal.stop;
  let originalHandler = terminal.stdinDataHandler;
  let filter: Osc5522Input;
  let handler!: typeof originalHandler;

  const wrap = () => {
    filter?.dispose();
    originalHandler = terminal.stdinDataHandler!;
    filter = new Osc5522Input({ forward: (data) => originalHandler(data), packet: (data) => enhanced.handle(data), error: callbacks.error });
    handler = (data) => filter.push(data);
    terminal.stdinDataHandler = handler;
    terminal.write("\x1b[?5522h");
  };
  process.stdin.removeListener("data", originalHandler);
  wrap();
  process.stdin.on("data", handler);
  const setup = () => { originalSetup.call(terminal); wrap(); };
  const stop = () => {
    terminal.write("\x1b[?5522l");
    enhanced.reset();
    filter.dispose();
    originalStop.call(terminal);
  };
  terminal.setupStdinBuffer = setup;
  terminal.stop = stop;

  return () => {
    terminal.write("\x1b[?5522l");
    enhanced.reset();
    filter.dispose();
    if (terminal.setupStdinBuffer === setup) terminal.setupStdinBuffer = originalSetup;
    if (terminal.stop === stop) terminal.stop = originalStop;
    if (terminal.stdinDataHandler === handler) {
      const attached = process.stdin.listeners("data").includes(handler);
      process.stdin.removeListener("data", handler);
      terminal.stdinDataHandler = originalHandler;
      if (attached) process.stdin.on("data", originalHandler);
    }
  };
}
