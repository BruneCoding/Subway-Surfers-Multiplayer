# Music

This folder holds the selectable race themes (Settings -> Music).

| Setting    | File              |
| ---------- | ----------------- |
| Default    | built-in game theme (not in this folder) |
| Orchestral | `themeOrch.ogg`   |
| Trap 1     | `themeTrap.ogg`   |
| Trap 2     | `themeTrap2.ogg`  |

## Use your own music

Replace a file with your own track **keeping the same file name**. The game
checks each setting in this order until a file answers:

1. `assets/music/<name>.ogg`  <- this folder (preferred)
2. `assets/music/<name>.mp3` or `.wav`
3. `<name>.ogg` / `.mp3` / `.wav` next to `index.html`

So any of ogg / mp3 / wav works, in this folder or next to index.html.
Tracks loop while racing; keep them roughly 15-60 s for best results.

If a file is missing, the setting shows a small "missing" tag and the game
falls back to the built-in theme - nothing breaks.

"Custom" tracks are uploaded through Settings and stored per browser.
