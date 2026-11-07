# Files Transfer

Herdr's Files panel with file transfer and VS Code's file icons. Right-click a file or folder for a small menu: download it to `~/Downloads`, paste files copied in Finder into it (upload), copy its path, reveal it in Finder, create a file or folder, rename it, move it to the Trash (this Mac) or delete it after a confirmation (remote). Markdown opens formatted and images open fitted; paired with Preview Plus, Markdown, images and PDFs open there. It works on this computer and on remote machines the space runs on (over ssh). Files dragged from Finder onto the panel upload too. It replaces the shipped Files panel in the person's layout.

![Files Transfer](preview.png)

## What you see

- **The panel**, wherever the layout's Files block is (in Herdr's `main`: the right-hand panel opened with the tab bar's Files button). `background` fill, 1px `border`, 10px radius.
- **Header**, 42px, 1px `border` under it: "Files" semibold; on the right, 12px `dim`, the shown folder's name. With a file open: a `←` on the left and, on the right, the file's 14px icon and its path.
- **Tree**, 6px padding; rows 28px, 7px radius, the selected row (last clicked or right-clicked) on `selected`, `hover` background on hover, 13px text: 8px + 18px per depth; a 12px chevron (`dim`) for folders, an empty 12px slot for files; the item's **16px full-colour icon** (Material Icon Theme, drawn with `image()`); the name, truncated; the git mark on the right, 11px (`A` in `ansi2`, `M` in `blocked`, `D`/`U` in `ansi1`). Folders first, then files, each alphabetical; `.git` and the mod's own `.herdr-upload.*` / `.herdr-download.*` folders are never listed.
- **Transfer line**, only while something transfers: 30px at the bottom, 1px `border` on top, 12px `muted`: a 12px spinner (`working`, one turn per 900 ms) and "Downloading a.txt…", "Uploading folder…" or "Transferring 3…".
- **Menu** (popup at the pointer, 250px wide, `popover`, 5px padding, 12.8px text): 31px rows, 7px radius, `hover` on the row under the pointer or picked with ↑/↓; a 14px glyph in `muted` and the label in `foreground`. Delete is in `ansi1` (glyph and text) below a 1px `border` divider (4px vertical margin, 7px side margin). Items:
  - file: Download to Downloads, Paste here, Copy path, Reveal in Finder (local only), divider, Delete…
  - folder: Download folder to Downloads, Paste into this folder, Copy path, Reveal in Finder (local only), divider, Delete…
  - empty space in the tree: Paste here, Copy path (for the shown folder).
- **Delete confirmation** (dialog, 420×176, `popover`, 18px padding, 10px gap): "Delete file “a.txt”?" (14px semibold), the path (`machine:path` for a remote one, 12px `muted`), "This can't be undone." or, for a folder, "The folder and everything in it will be deleted. This can't be undone." (12px `dim`); at the bottom right Cancel (`input` border) and Delete (`ansi1` fill, `background` text), 32px high, 8px radius.
- Text is Russian when the system's language is Russian (macOS: first preferred language; Windows: `Get-UICulture`; Linux: `$LANG`), else English. The desktop's names follow the platform: Finder / Explorer / file manager, Trash / Recycle Bin, ⌘V / Ctrl+V.

## How it behaves

| Action | Result |
| --- | --- |
| Click a folder / file | Opens or closes it / shows it read-only in the panel (as the shipped Files panel) |
| Right-click a row or the tree's empty space | The menu for that item / for the shown folder; Esc or a click outside closes it; Enter picks |
| Download | Copies to `~/Downloads` under a free name (`a (1).txt`, `folder (1)`); remote: `scp -r -p` from the machine's ssh address; local: `cp -R -p`. Toast "Downloaded a.txt" with the path, or the scp error |
| Paste | Reads the file paths Finder put on the clipboard; uploads them into the folder (a file's: its parent; the empty space: the shown folder). "Nothing to paste" toast when the clipboard holds no files |
| Click a row, then ⌘V | Paste into the selected folder, beside the selected file; with nothing selected (a press on empty tree space clears it, so does Esc) into the shown folder |
| Drop files from Finder | On a folder: into it; on a file: beside it; on empty space: into the shown folder |
| Upload finishes | Items move into place under free names (never overwriting); toast "Uploaded a.txt" or "Uploaded 3 items"; the tree refreshes |
| Delete… → Delete (or Enter) | `rm -rf` on the item's machine; toast "Deleted a.txt"; the tree refreshes; an open preview of it closes. Cancel or Esc does nothing |
| New file… / New folder… / Rename… | A 440×214 dialog: title, "In <folder>", a Name input (rename preselects the name without its extension), Cancel and Create/Rename; Enter submits, Esc cancels. Names with `/` or control characters, `.` and `..` are refused in the dialog; an existing name gives a toast "“x” already exists" (the scripts exit 17 instead of replacing). The new entry's folders open and it is selected |
| Move to Trash (local) | macOS: `trash <path>` (Put Back works); Windows: `Microsoft.VisualBasic.FileIO.FileSystem` with `SendToRecycleBin` (Restore works); Linux: `gio trash`; no confirmation |
| Click Markdown / an image | Formatted Markdown with a Source/Preview chip in the header / the image fitted to the panel, with size info and Open in Preview (Windows/Linux: Open, in the default app). Remote images are copied here first; HEIC, TIFF, AVIF and ICO are converted with `sips` (macOS), GDI+ via `System.Drawing` (Windows: TIFF and ICO only) or ImageMagick (Linux) |
| Copy path / Reveal in Finder | The absolute path (on its machine) to the clipboard (`pbcopy`, `Set-Clipboard`, `wl-copy`/`xclip`) / Finder selects the local item (`open -R`; Windows `explorer /select,`; Linux `xdg-open` on the parent) |

The panel follows the focused pane's folder (on its machine), refreshes every 10 s and on local folder changes, exactly like the shipped Files panel. No agent statuses are shown.

## Built from

- **One mod**, `mods/files-transfer/`, `mod.json` `{ "place": "none" }`. `main.js` is Herdr's shipped `files` mod with File Icons' changes (`DIR`, `icon(path, dir, open, dark)` from `icons.js`, `image()` icons) plus the menu and transfers. `icons/` (1184 SVGs) and `icons.js` come from Material Icon Theme 5.40.0 via `tools/build-icons.mjs`. Glyphs: `download.svg`, `paste.svg`, `copy.svg`, `trash.svg`, `chevron-*.svg` (Lucide), `finder.svg`, `spinner.svg` (Herdr's workspace-chrome).
- **The same mod draws three things**: the panel; the menu when `props().menu` is set (`openOverlay({ mod: "files-transfer", kind: "popup", width: 250, props: { menu: target } })`); the confirmation when `props().confirm` is set (`kind: "dialog"`). The overlays hand the choice back through shared `files-transfer.request` (`{ id, action, path, name, dir, on, from }`), and only the panel copy whose random `from` id opened the menu acts on it. That's because an overlay's tasks end when it closes, and a transfer outlives it.
- **Layout**: the Files block keeps `"id": "files"` (the tab bar's button selects it by id) and gets `"content": { "mod": "files-transfer" }`. `install.sh` clones a shipped layout first.
- `herdr`: `spaces`, `panes`, `focused`, `exec` (with `on` for the space's machine), `hc(["machine","ls","--json"])` (a machine's ssh `target`), `readTextFile`, `watchFolder`, `theme`, `settings`, `window`, `props`, `openOverlay`, `closeOverlay`, `shared`/`setShared` (`files-transfer.request`, `files-transfer.lang`), `notify`, `appHome`, `home`.
- **Programs**: `scp`, `cp`, `mktemp`, `mv`, `ln`, `rm`, `sh`, `git`; macOS `osascript -l JavaScript` (NSPasteboard file URLs), `pbcopy`, `open -R`, `trash`, `sips`, `defaults read -g AppleLanguages`; Windows `powershell` for every local step (see below); Linux `gio`, `xdg-open`, `wl-clipboard`/`xclip`, ImageMagick.
- **Three platforms, one code path per operation.** `platform()` reads `window().platform`. Helpers (`remove`, `move`, `copy`, `mkdirp`, `fileSize`, `tempDir`, `makeEntry`, `rename`, `place`) take `on`: with a machine, or here on macOS/Linux, they run the sh form; here on Windows, the PowerShell form through `ps(snippet, args)`. `desktop.*` (clipboard, reveal, open, trash, language, image tools) branches on the platform. Remote machines are always sh over ssh.
- **PowerShell snippets never embed a value.** `ps()` wraps a snippet as `& { param($a) … } @('arg', …)` with Herdr's own quoting (single quotes doubled, curly ones too) and sets the console to UTF-8; snippets read `$a[0]`, `$a[1]`… and use `-LiteralPath` or `[IO.*]` so `[` and `]` in names stay literal. Snippets hold no double quotes (the command line is re-parsed on Windows); `[char]34` where one is needed.
- **Transfers run detached** because `exec` stops at 30 s. macOS/Linux: `nohup sh -c … &`. Windows: the worker `transfer.ps1` is written to `<app home>/data/files-transfer/` (through `writeTextFile`, rewritten when the mod's copy changes), the job's parameters to `<id>.job` as JSON, and `Start-Process -WindowStyle Hidden powershell -File …` starts it; scp runs through `Start-Process -Wait` with stderr redirected to the log, so PowerShell 5.1's stderr-as-error behaviour can't fail a working copy. Each worker writes its exit code to `<app home>/data/files-transfer/<id>` (and `.log`, `.dest`); the panel polls those once a second while any transfer runs. Download: into a hidden `.herdr-download.*` folder in Downloads, then claim a free name. Upload: a hidden `.herdr-upload.*` folder in the target folder, scp/cp into it, then a script on the target moves each item into place under a free name and prints the names it used.

- **Pairing with Preview Plus** (optional): the layout's `files` block becomes a stack whose children are `files-plus-tree` (this mod, `props.previewStack: "files"`) and `preview-plus`. A click on `.md`, `.png`, `.jpg`, `.webp`, `.svg` or `.pdf` writes `shared("preview-plus.target")[spaceId] = { file, root, on }` and runs `layout.select { stack, child: "preview-plus" }`; Preview Plus's Back selects `files-plus-tree` (that id is fixed by Preview Plus). Remote media are staged here first and handed over with `on: null`.

## Watch out

- **Free names must be claimed atomically.** Checking `[ -e ]` and then moving lets two transfers that finish together overwrite each other. Claim files with `ln tmp/x dest` (fails if dest exists) and folders with `mkdir dest`, then move the folder's contents in (globs `* .[!.]* ..?*` so dotfiles come too).
- **scp's remote path isn't shell-quoted.** OpenSSH 9+ uses SFTP, so `host:/path with spaces` works as is. Don't add quotes.
- **`exec` with `on` takes an argument array.** Run remote steps (mktemp, place, rm) through it, not through `ssh host "cmd"`, which needs quoting.
- **ssh needs no prompts:** `-o BatchMode=yes -o ConnectTimeout=15`, or a transfer hangs forever.
- **A popup's `cx` tasks die with it**, so never run the action in the menu copy.
- ⌘V needs the keyboard: the panel's root has `track_focus(handle)` and `on_key_down` comparing `event.keystroke` with `PASTE_KEY()` (`"cmd-v"` on a Mac, `"ctrl-v"` elsewhere), and a row click calls `handle.focus()`. A layout block doesn't get the keyboard by itself.
- `on_size_change` reports window points: divide by `settings().zoom` before fitting an image.
- The name `LANG` is already used (the preview's language map); the language key is `LANG_KEY`.
- Refuse to delete the shown folder itself or a path with fewer than two parts (`/etc`, `/home`, `C:\Users`): `depth()` counts components with either separator and ignores a drive letter.
- A Windows root arrives with backslashes while the panel joins with `/`. `parentOf` and `basename` read either; `norm()` turns a path into `/` form for the git-mark lookup (git prints `C:/…`) and the `image()` path inside the app folder.
- On Windows the free-name claim (`Test-Path` then `Move-Item`) isn't atomic as `ln`/`mkdir` are; two transfers finishing in the same instant could collide. Accepted: NTFS has no cheap link-or-fail from PowerShell 5.1.
- Windows PowerShell 5.1 turns a native command's stderr into errors under `$ErrorActionPreference = 'Stop'`: run `scp` with `Start-Process -Wait -RedirectStandardError`, never `& scp … 2>&1`.
- `Get-Clipboard -Format FileDropList` is Windows PowerShell 5.1 (`powershell`), not `pwsh`: call `powershell` by that name.
- Large deletes go through `exec` and can hit its 30 s limit.

## Done when

- `herdr-app check mods/files-transfer` passes, and the Files button shows the tree with coloured icons.
- In a remote space, Download on a file puts it in `~/Downloads`; doing it twice gives `name (1).ext`; Download on a folder brings its dotfiles too.
- Copy a file and a folder in Finder, then Paste into this folder on a remote folder: both appear there; pasting again gives `name (1)` copies; no `.herdr-upload.*` folder is left.
- Dropping a file from Finder onto a folder uploads it into that folder.
- Clicking a remote folder and pressing ⌘V with a file copied in Finder uploads it there; with no files on the clipboard a "Nothing to paste" toast shows.
- Delete… opens the confirmation with the machine and path; Esc leaves the file; Delete removes it and the row disappears.
- With the system in Russian the menu reads «Скачать в Загрузки»; otherwise "Download to Downloads".
- On Windows: the tree lists `C:\Users\…`; Download from a remote space lands in `Downloads` with `name (1).ext` on a repeat; Paste after Ctrl+C in Explorer uploads; Move to Recycle Bin shows in the Recycle Bin with Restore; Show in Explorer selects the file; New file / New folder / Rename work with `[` in the name.
