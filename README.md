# pi-image-paste-cards

Paste screenshots and image files into the [Pi](https://pi.dev) terminal editor. Pi sends the image data to your model and shows each attachment’s label and dimensions next to the prompt.

## Usage

Copy a screenshot and press `Ctrl+V` or `Alt+V` in Pi’s prompt editor. To paste from the clipboard without a shortcut, run `/paste-image`. To attach a file, paste or drop its path into the editor, or run the following command with your path.

```text
/paste-image ~/Pictures/screenshot.png
```

The prompt contains a label such as `[Image #1 82a291]`. Pi shows the attachment list above the editor and, after sending, below the message. Rows include the source URL when Pi can read the image from a local path, including files copied in Windows Explorer.

```text
Attached Images:
[Image #1 82a291] 733x120
[Image #2 3cd769](file:///home/me/Pictures/screenshot.png) 901x200
```

To remove an attachment, delete its label in the prompt. Backspace, Delete, and undo treat each label as a single unit. Pasting text inserts text as usual. `Enter` waits for an in-progress paste.

Draft attachments survive `/reload` in the same session. Sent attachment rows and source links also appear when you resume the session. Attachment numbers continue across turns, reloads, and restarts of that session.

## Install

```bash
pi install git:github.com/kokoro11/pi-image-paste-cards
```

Run `/reload` if Pi is already open. To try the fork for one run, use this command.

```bash
pi -e git:github.com/kokoro11/pi-image-paste-cards
```

This fork is distributed through GitHub. The original author publishes the package with the same name on npm. [Upstream project](https://github.com/ImSven/pi-image-paste-cards)

### Requirements

Use interactive Pi with an image-capable model. The package requires Node.js 22.19 or newer. The extension has been tested with Pi 1.5.2.

| Clipboard environment | Requirement |
|---|---|
| Wayland or WSLg | `wl-clipboard` (`wl-paste`) |
| X11 | `xclip` |
| macOS or Windows | Pi’s bundled native clipboard helper |
| Kitty or another OSC 5522 terminal | [Terminal clipboard protocol support](https://sw.kovidgoyal.net/kitty/clipboard/) |

## Limits and troubleshooting

The extension accepts PNG, JPEG, WebP, GIF, and BMP images up to 50 MiB each. It converts BMP to PNG in-process, including WSLg screenshots. If file permissions block a read, the editor inserts a file link and shows a warning. If the selected model accepts text only, Pi keeps the draft so you can switch models.

Run `/paste-image-status` for the most recent paste result. See the clipboard guide for terminal keybindings, clipboard backends, and the optional WSLg bridge. [Clipboard setup and diagnostics](docs/clipboard.md)

## Contributing

See the contributing guide for local development, tests, and the Pi hooks used by the extension. [Contributing guide](CONTRIBUTING.md)

## License

[MIT](LICENSE)
