# Contributing

## Run the extension locally

Install Bun and Pi, then run the following commands.

```bash
git clone https://github.com/kokoro11/pi-image-paste-cards
cd pi-image-paste-cards
bun install
bun run test
pi -e ./extensions/image-paste.ts
```

The Bun tests use Pi’s real extension loader and terminal editor. They find Pi in the project’s dependencies or Bun’s global install. For another installation, set `PI_PACKAGE_DIR` to the installed `@earendil-works/pi-coding-agent` directory.

## Test coverage

The suite covers image and text paste, Kitty key release events, BMP conversion, draft restore, editor deletion and undo, preview ordering on session replay, and stale file cleanup. The Windows Explorer tests simulate file clipboard responses, and the OSC 5522 tests exercise protocol parsing and fragmented terminal input.

Earlier upstream manual testing used Pi 1.3.0 on WSL2 with WSLg and Windows Terminal 1.24. It covered both paste shortcuts, the Wayland clipboard, and the optional BMP bridge. Reports from X11, macOS, and OSC 5522 terminals are welcome.

## Pi integration

- Attachment labels combine the draft number and the first six hexadecimal digits of the SHA-256 hash of the normalized image. Identical images share a checksum and get different numbers. The label stays stable if Pi resizes the attachment on send.
- The draft stores temporary image files and a session-specific manifest. It uses owner-only file modes on Unix and inherited temporary-directory permissions on Windows. Once the message owns the bytes, the extension removes its draft copy. Normal shutdown or a session change clears remaining drafts, and startup sweeps matching leftovers older than seven days.
- The extension decorates the current editor’s `segment` and `render` methods for label editing and styling. It also wraps the terminal instance’s input handler to assemble OSC 5522 packets before Pi’s stdin parser. Reload and shutdown restore the original methods. Check these hooks against Pi when upgrading the host.

See the clipboard guide for platform setup and the diagnostics to include in paste reports. [Clipboard setup and diagnostics](docs/clipboard.md)
