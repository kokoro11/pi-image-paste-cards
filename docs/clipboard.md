# Clipboard setup and diagnostics

## Shortcuts

The extension handles `Ctrl+V`, `Alt+V`, and shortcuts configured for `app.clipboard.pasteImage`. In Windows Terminal on WSLg, `Ctrl+V` may reach Pi as an empty bracketed paste. The extension treats that event as a request to read the clipboard. If the terminal consumes the shortcut entirely, use `Alt+V` or `/paste-image`.

To bind another key, add it under `app.clipboard.pasteImage` in Pi’s `~/.pi/agent/keybindings.json`. [Pi keybindings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md)

## Diagnostics

| Command | What it shows or changes |
|---|---|
| `/paste-image-status` | Paste count, last trigger, last result, and trace state |
| `/paste-image-status trace` | Enables recording of the last control-key sequence |
| `/paste-image-status off` | Stops recording control-key sequences |

Tracing excludes ordinary typed text and bracketed paste payloads. When reporting a paste problem, include your OS, terminal, Pi version, shortcut, and the result from `/paste-image-status`.

## Clipboard sources

For image data, the extension tries `wl-paste` when `WAYLAND_DISPLAY` is set, then `xclip` when `DISPLAY` is set, then Pi’s native clipboard helper. It falls back when a backend is unavailable. A successful Wayland query with no image ends the image search so that stale X11 image data stays out of the prompt.

For copied files, the extension reads paths from the native clipboard helper when available. On Windows it can use Windows PowerShell’s `Get-Clipboard -Format FileDropList`. A readable file supplies both image bytes and a `file:///` source URL. Pi keeps the URL in the transcript and sends the image bytes and label to the model. Terminals with hyperlink support also make the source label clickable.

Kitty and compatible terminals can send PNG, JPEG, WebP, GIF, and text via OSC 5522. [Kitty clipboard protocol](https://sw.kovidgoyal.net/kitty/clipboard/)

## Share PNG with other WSL apps

Use the optional bridge when another WSL app needs Windows screenshots as `image/png`. It watches the Wayland clipboard and converts `image/bmp` offers with ImageMagick’s `convert`. The Pi extension handles those BMP offers itself.

From a checkout of this fork on a Debian or Ubuntu WSL distribution, run the following commands.

```bash
sudo apt install wl-clipboard imagemagick
install -Dm755 scripts/wslg-clipboard-bridge.sh ~/.local/bin/wslg-clipboard-bridge.sh
install -Dm644 scripts/wslg-clipboard-bridge.service ~/.config/systemd/user/wslg-clipboard-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now wslg-clipboard-bridge.service
```

For WSL distributions without systemd, run `~/.local/bin/wslg-clipboard-bridge.sh &` from your shell profile. [Bridge script](../scripts/wslg-clipboard-bridge.sh)
