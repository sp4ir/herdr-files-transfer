// Files Transfer: Herdr's Files panel with VS Code's Material Icon Theme icons and file transfer.
// A lazy file browser for the focused pane's folder, with bounded read-only previews, and a
// right-click menu that downloads, uploads (paste from Finder, or drop), copies paths, creates,
// renames, moves to the Trash (here) or deletes (remote),
// on this computer or on the remote machine the space runs on (over ssh).
// This computer may run macOS, Windows or Linux: the desktop pieces (clipboard, file manager,
// Trash, image tools, detached transfers) have a branch for each; remote machines always run sh.
//
// Based on File Icons by amster93 (https://github.com/amster93/herdr-file-icons, Apache-2.0),
// itself modified from Herdr's shipped `files` mod (https://github.com/herdrdev/herdr-app,
// Apache-2.0). Added here: the menu, transfers, create/rename/trash/delete, drop, previews,
// English/Russian text, Windows and Linux support.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, InputState, Input } from "gpui-base";
import { spaces, panes, focused, run, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, props, openOverlay, closeOverlay, shared, setShared, notify, hc, appHome, home } from "herdr";
import ICONS from "./icons.js";

// Right-click menu on a file or folder: download it to ~/Downloads (scp from a remote
// machine, cp here), paste files copied in Finder into it (upload), copy its path, show it
// in Finder, delete it after a confirmation. Files dropped from Finder upload too. The menu
// and the confirmation are this mod opened as a popup / dialog (props().menu, .confirm);
// they hand the choice to the panel that opened them through shared "files.request", since
// an overlay's tasks end when it closes and a transfer can take long.
const REQUEST = "files-transfer.request";
const LANG_KEY = "files-transfer.lang";
const MENU_ROW = 31;
// Our temporary folders, never listed in the tree.
const TEMP = /^\.herdr-(upload|download)\./;
// Runs detached so a download isn't bound by exec's 30 s. It fetches into a hidden
// temporary folder next to the target, then claims a free name atomically ("a (1).txt")
// and writes that path to <status>.dest and the exit code to <status>.
const FETCH = `src=$1 dir=$2 name=$3 st=$4 mode=$5 isdir=$6
mkdir -p "$dir" "\${st%/*}" || exit 1
rm -f "$st" "$st.dest"
tmp=$(mktemp -d "$dir/.herdr-download.XXXXXX") || exit 1
nohup sh -c '
mode=$1 src=$2 tmp=$3 dir=$4 name=$5 isdir=$6 st=$7
if [ "$mode" = scp ]; then scp -r -p -o BatchMode=yes -o ConnectTimeout=15 "$src" "$tmp/$name"; else cp -R -p "$src" "$tmp/$name"; fi >"$st.log" 2>&1
code=$?
if [ $code = 0 ]; then
  base=$name ext=
  if [ "$isdir" != 1 ]; then case "$name" in ?*.*) base=\${name%.*} ext=.\${name##*.};; esac; fi
  dest="$dir/$name" i=0
  if [ "$isdir" = 1 ]; then
    while ! mkdir "$dest" 2>/dev/null; do [ -e "$dest" ] || { code=1; break; }; i=$((i+1)); dest="$dir/$base ($i)$ext"; done
    if [ $code = 0 ]; then (cd "$tmp/$name" && for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then mv "$f" "$dest/" || exit 1; fi; done) || code=1; fi
  else
    while ! ln "$tmp/$name" "$dest" 2>/dev/null; do [ -e "$dest" ] || { code=1; break; }; i=$((i+1)); dest="$dir/$base ($i)$ext"; done
  fi
  [ $code = 0 ] && printf %s "$dest" >"$st.dest"
fi
rm -rf "$tmp"
echo $code >"$st"' fetch "$mode" "$src" "$tmp" "$dir" "$name" "$isdir" "$st" </dev/null >/dev/null 2>&1 &`;

// Upload, detached like FETCH: copies local files into a temporary folder on the target
// (made beforehand with mktemp there) and writes the exit code to <status>.
const SEND = `st=$1 mode=$2 dest=$3; shift 3
mkdir -p "\${st%/*}" || exit 1
rm -f "$st"
nohup sh -c 'st=$1 mode=$2 dest=$3; shift 3
if [ "$mode" = scp ]; then scp -r -p -o BatchMode=yes -o ConnectTimeout=15 "$@" "$dest"; else cp -R -p "$@" "$dest"; fi >"$st.log" 2>&1
echo $? >"$st"' send "$st" "$mode" "$dest" "$@" </dev/null >/dev/null 2>&1 &`;

// Runs on the target machine once an upload is in: moves each uploaded item from the
// temporary folder into place under a free name, prints the names it used, removes the folder.
const PLACE = `tmp=$1 dir=$2
for p in "$tmp"/* "$tmp"/.[!.]* "$tmp"/..?*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  name=\${p##*/} base=\${p##*/} ext= i=0 dest="$dir/\${p##*/}"
  if [ -d "$p" ] && [ ! -L "$p" ]; then
    while ! mkdir "$dest" 2>/dev/null; do [ -e "$dest" ] || exit 1; i=$((i+1)); dest="$dir/$name ($i)"; done
    (cd "$p" && for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then mv "$f" "$dest/" || exit 1; fi; done) || exit 1
  else
    case "$name" in ?*.*) base=\${name%.*} ext=.\${name##*.};; esac
    while ! ln "$p" "$dest" 2>/dev/null; do [ -e "$dest" ] || exit 1; i=$((i+1)); dest="$dir/$base ($i)$ext"; done
  fi
  printf '%s\\n' "\${dest##*/}"
done
rm -rf "$tmp"`;

// Files copied in Finder (⌘C): their paths, from the general pasteboard.
const CLIPBOARD = `ObjC.import("AppKit");
const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL),
  $.NSDictionary.dictionaryWithObjectForKey(true, "NSPasteboardURLReadingFileURLsOnlyKey"));
const out = [];
if (urls) for (let i = 0; i < urls.count; i++) out.push(urls.objectAtIndex(i).path.js);
JSON.stringify(out);`;

// ---- This computer: sh on macOS and Linux, PowerShell on Windows. A remote machine (`on`)
// always runs sh over ssh. Where a helper takes `on`, it acts there when given one.
const platform = () => window()?.platform ?? "macos";
const isWin = () => platform() === "windows";
const isMac = () => platform() === "macos";
// A PowerShell string literal, quoted the way Herdr quotes its own (single quotes doubled,
// the curly ones too). Arguments reach a snippet through $a, never through its text.
const psq = s => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
function ps(script, args = [], options = {}) {
  const cmd = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; & { param($a) ${script} } @(${args.map(psq).join(",")})`;
  return exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], options);
}
// Where transfers keep their status files, and on Windows the worker script and job files.
const WORKERS = "data/files-transfer";

// The Windows transfer worker, run detached (a hidden PowerShell) so a long copy isn't bound
// by exec's 30 s. It reads its job from a JSON file and reports like FETCH/SEND do: the exit
// code to <st>, scp's complaints to <st>.log, a download's final path to <st>.dest.
const TRANSFER_PS = `param([string]$JobFile)
$ErrorActionPreference = 'Stop'
$j = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$st = $j.st; $code = 1; $tmp = $null
function Invoke-Scp($list, $log) {
  $q = [char]34
  $argv = @('-r', '-p', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15') + @($list | ForEach-Object { $q + $_ + $q })
  $p = Start-Process -FilePath scp -ArgumentList $argv -NoNewWindow -Wait -PassThru -RedirectStandardError $log
  return $p.ExitCode
}
try {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $st)) | Out-Null
  Remove-Item -LiteralPath $st, ($st + '.dest') -Force -ErrorAction SilentlyContinue
  if ($j.kind -eq 'fetch') {
    [IO.Directory]::CreateDirectory($j.dir) | Out-Null
    $tmp = Join-Path $j.dir ('.herdr-download.' + [IO.Path]::GetRandomFileName().Replace('.', ''))
    [IO.Directory]::CreateDirectory($tmp) | Out-Null
    $target = Join-Path $tmp $j.name
    if ($j.mode -eq 'scp') { $code = Invoke-Scp @($j.src, $target) ($st + '.log') }
    else { Copy-Item -LiteralPath $j.src -Destination $target -Recurse -Force; $code = 0 }
    if ($code -eq 0) {
      $name = $j.name; $base = $name; $ext = ''
      if ($j.isdir -ne '1' -and $name -match '^(.+)(\\.[^.]+)$') { $base = $Matches[1]; $ext = $Matches[2] }
      $dest = Join-Path $j.dir $name; $i = 0
      while (Test-Path -LiteralPath $dest) { $i++; $dest = Join-Path $j.dir ($base + ' (' + $i + ')' + $ext) }
      Move-Item -LiteralPath $target -Destination $dest
      [IO.File]::WriteAllText($st + '.dest', $dest)
    }
  } else {
    if ($j.mode -eq 'scp') { $code = Invoke-Scp (@($j.files) + @($j.dest)) ($st + '.log') }
    else { foreach ($f in @($j.files)) { Copy-Item -LiteralPath $f -Destination $j.dest -Recurse -Force }; $code = 0 }
  }
} catch {
  $code = 1
  try { [IO.File]::AppendAllText($st + '.log', [string]$_ + [Environment]::NewLine) } catch {}
} finally {
  if ($tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  [IO.File]::WriteAllText($st, [string]$code)
  Remove-Item -LiteralPath $JobFile -Force -ErrorAction SilentlyContinue
}
`;

// PLACE for this computer when it runs Windows.
const PLACE_PS = `$tmp = $a[0]; $dir = $a[1]
foreach ($p in @(Get-ChildItem -LiteralPath $tmp -Force)) {
  $name = $p.Name; $base = $name; $ext = ''
  $isdir = $p.PSIsContainer -and -not ($p.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if (-not $isdir -and $name -match '^(.+)(\\.[^.]+)$') { $base = $Matches[1]; $ext = $Matches[2] }
  $dest = Join-Path $dir $name; $i = 0
  while (Test-Path -LiteralPath $dest) { $i++; if ($isdir) { $dest = Join-Path $dir ($name + ' (' + $i + ')') } else { $dest = Join-Path $dir ($base + ' (' + $i + ')' + $ext) } }
  Move-Item -LiteralPath $p.FullName -Destination $dest
  Write-Output (Split-Path -Leaf $dest)
}
Remove-Item -LiteralPath $tmp -Recurse -Force`;

// The Recycle Bin, through the shell's own move (Explorer's Restore works).
const TRASH_PS = `Add-Type -AssemblyName Microsoft.VisualBasic
$p = $a[0]
if ((Get-Item -LiteralPath $p -Force).PSIsContainer) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }`;

// Starts the Windows worker on a job; the script is written beside the status files once.
async function detach(job) {
  const base = `${appHome()}/${WORKERS}`;
  await mkdirp(base);
  const ps1 = `${base}/transfer.ps1`, current = await readTextFile(ps1).catch(() => null);
  if (current !== TRANSFER_PS) await writeTextFile(ps1, TRANSFER_PS, current);
  const jobFile = `${job.st}.job`;
  await writeTextFile(jobFile, JSON.stringify(job), null);
  const r = await ps("$q = [char]34; Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ($q + $a[0] + $q), ($q + $a[1] + $q))", [ps1, jobFile]);
  if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
}

// File operations here or on a machine. Each PowerShell form treats paths literally.
function remove(path, on) {
  if (on || !isWin()) return exec("rm", ["-rf", "--", path], { on });
  return ps("if (Test-Path -LiteralPath $a[0]) { Remove-Item -LiteralPath $a[0] -Recurse -Force }", [path]);
}
function removeFiles(paths) {
  if (!isWin()) return exec("rm", ["-f", ...paths]);
  return ps("foreach ($p in $a) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }", paths);
}
function mkdirp(dir) {
  return isWin() ? ps("[IO.Directory]::CreateDirectory($a[0]) | Out-Null", [dir]) : exec("mkdir", ["-p", dir]);
}
function move(from, to) {
  return isWin() ? ps("Move-Item -LiteralPath $a[0] -Destination $a[1] -Force", [from, to]) : exec("mv", [from, to]);
}
function copy(from, to) {
  return isWin() ? ps("Copy-Item -LiteralPath $a[0] -Destination $a[1] -Force", [from, to]) : exec("cp", [from, to]);
}
function fileSize(path, on) {
  if (on || !isWin()) return exec("sh", ["-c", 'wc -c < "$1"', "size", path], { on });
  return ps("(Get-Item -LiteralPath $a[0] -Force).Length", [path]);
}
// A fresh hidden folder inside dir for an upload; prints its path.
function tempDir(dir, on) {
  if (on || !isWin()) return exec("mktemp", ["-d", `${dir}/.herdr-upload.XXXXXX`], { on });
  return ps("$d = Join-Path $a[0] ('.herdr-upload.' + [IO.Path]::GetRandomFileName().Replace('.', '')); [IO.Directory]::CreateDirectory($d) | Out-Null; Write-Output $d", [dir]);
}
// A new file or folder; exit 17 when the name is taken.
function makeEntry(kind, target, on) {
  if (on || !isWin()) return exec("sh", ["-c", kind === "file" ? MAKE_FILE : MAKE_FOLDER, "make", target], { on });
  return ps(kind === "file"
    ? "if (Test-Path -LiteralPath $a[0]) { exit 17 }; [IO.File]::Create($a[0]).Dispose()"
    : "if (Test-Path -LiteralPath $a[0]) { exit 17 }; [IO.Directory]::CreateDirectory($a[0]) | Out-Null", [target]);
}
function rename(from, to, on) {
  if (on || !isWin()) return exec("sh", ["-c", MOVE, "move", from, to], { on });
  return ps("if (Test-Path -LiteralPath $a[1]) { exit 17 }; Move-Item -LiteralPath $a[0] -Destination $a[1]", [from, to]);
}
function place(tmp, dir, on) {
  if (on || !isWin()) return exec("sh", ["-c", PLACE, "place", tmp, dir], { on });
  return ps(PLACE_PS, [tmp, dir]);
}

// The desktop here: clipboard, file manager, Trash, image tools, language.
const desktop = {
  // Files copied in Finder / Explorer / the file manager: their paths.
  async clipboardFiles() {
    if (isMac()) {
      const r = await exec("osascript", ["-l", "JavaScript", "-e", CLIPBOARD]);
      return r.code === 0 ? JSON.parse(r.stdout.trim() || "[]") : [];
    }
    if (isWin()) {
      const r = await ps("ConvertTo-Json -Compress -InputObject @(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName })");
      return r.code === 0 ? JSON.parse(r.stdout.trim() || "[]") : [];
    }
    const r = await exec("sh", ["-c", 'if command -v wl-paste >/dev/null 2>&1; then wl-paste -t text/uri-list 2>/dev/null; else xclip -selection clipboard -t text/uri-list -o 2>/dev/null; fi']).catch(() => null);
    return (r?.stdout ?? "").split(/\r?\n/).filter(l => l.startsWith("file://")).map(l => decodeURIComponent(l.slice(7)));
  },
  copyText(text) {
    if (isMac()) return exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]);
    if (isWin()) return ps("Set-Clipboard -Value $a[0]", [text]);
    return exec("sh", ["-c", 'if command -v wl-copy >/dev/null 2>&1; then printf %s "$1" | wl-copy; else printf %s "$1" | xclip -selection clipboard; fi', "copy", text]);
  },
  reveal(path) {
    if (isMac()) return exec("open", ["-R", path]);
    if (isWin()) return ps("$q = [char]34; Start-Process explorer.exe -ArgumentList ('/select,' + $q + $a[0].Replace('/', '\\') + $q)", [path]);
    return exec("xdg-open", [parentOf(path)]);
  },
  // In the default app (on macOS: Preview).
  open(path) {
    if (isMac()) return exec("open", ["-a", "Preview", path]);
    if (isWin()) return ps("Start-Process -FilePath $a[0]", [path]);
    return exec("xdg-open", [path]);
  },
  trash(path) {
    if (isMac()) return exec("trash", [path]);
    if (isWin()) return ps(TRASH_PS, [path]);
    return exec("gio", ["trash", "--", path]);
  },
  // "ru" when the system speaks Russian, else "en".
  async language() {
    if (isMac()) {
      const r = await exec("defaults", ["read", "-g", "AppleLanguages"]).catch(() => null);
      return /^\W*"?ru/m.test(r?.stdout?.split("\n").find(l => /\w/.test(l) && !/^\s*\(/.test(l)) ?? "") ? "ru" : "en";
    }
    if (isWin()) {
      const r = await ps("(Get-UICulture).Name").catch(() => null);
      return /^ru/i.test(r?.stdout?.trim() ?? "") ? "ru" : "en";
    }
    const r = await exec("sh", ["-c", 'printf %s "${LC_ALL:-${LC_MESSAGES:-$LANG}}"']).catch(() => null);
    return /^ru/i.test(r?.stdout ?? "") ? "ru" : "en";
  },
  // Makes the preview folder and drops copies older than an hour.
  cleanPreviews(dir) {
    if (isWin()) return ps("[IO.Directory]::CreateDirectory($a[0]) | Out-Null; Get-ChildItem -LiteralPath $a[0] -Force | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } | Remove-Item -Recurse -Force", [dir]);
    return exec("sh", ["-c", 'mkdir -p "$1" && find "$1" -mindepth 1 -mmin +60 -delete', "clean", dir]);
  },
  // An image as PNG (the formats GPUI can't draw). Windows reads what GDI+ reads (ICO, TIFF);
  // HEIC and AVIF need codecs it doesn't have, so they fail and the panel says so.
  toPng(file, png) {
    if (isMac()) return exec("sips", ["-s", "format", "png", file, "--out", png]);
    if (isWin()) return ps("Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Image]::FromFile($a[0]); try { $i.Save($a[1], [System.Drawing.Imaging.ImageFormat]::Png) } finally { $i.Dispose() }", [file, png]);
    return exec("sh", ["-c", 'if command -v magick >/dev/null 2>&1; then magick "$1" "$2"; else convert "$1" "$2"; fi', "png", file, png]);
  },
  // Prints "pixelWidth: W" and "pixelHeight: H" lines, as sips does. A failure leaves them out.
  dimensions(file) {
    if (isMac()) return exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
    if (isWin()) return ps("Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Image]::FromFile($a[0]); try { 'pixelWidth: ' + $i.Width; 'pixelHeight: ' + $i.Height } finally { $i.Dispose() }", [file]);
    return exec("sh", ["-c", 'identify -format "pixelWidth: %w\\npixelHeight: %h" "$1"', "dims", file]);
  },
};

// The ssh target behind a Herdr machine name (hc machine ls: "dev@host" or an ssh-config alias).
async function sshTarget(machine) {
  const r = await hc(["machine", "ls", "--json"]);
  const m = JSON.parse(r.stdout || "{}").machines?.find(x => x.name === machine);
  if (!m?.target) throw new Error(`No ssh address for machine ${machine}`);
  return m.target;
}

// Interface text: Russian when the system is set to Russian, else English (see init).
const STRINGS = {
  en: {
    pasteHere: "Paste here", pasteInto: "Paste into this folder", pasteBeside: "Paste here",
    download: "Download to Downloads", downloadFolder: "Download folder to Downloads",
    copyPath: "Copy path", reveal: "Reveal in Finder", delete: "Delete…",
    pathCopied: "Path copied", nothingToPaste: "Nothing to paste",
    nothingToPasteBody: "Copy a file or folder in Finder (⌘C), then choose Paste.",
    tooDangerous: (p) => `Refusing to delete ${p}`, deleted: (n) => `Deleted ${n}`,
    downloadFailed: (n) => `Couldn't download ${n}`, uploadFailed: (n) => n ? `Couldn't upload ${n}` : "Couldn't upload",
    deleteFailed: (n) => `Couldn't delete ${n}`, failed: "Something went wrong", code: (c) => `exit code ${c}`,
    items: (n) => `${n} ${n === 1 ? "item" : "items"}`, downloaded: (n) => `Downloaded ${n}`, uploaded: (n) => `Uploaded ${n}`,
    askDelete: (dir, n) => `Delete ${dir ? "folder" : "file"} “${n}”?`,
    deleteDetail: (dir) => dir ? "The folder and everything in it will be deleted. This can't be undone." : "This can't be undone.",
    cancel: "Cancel", confirmDelete: "Delete",
    uploading: (n) => `Uploading ${n}…`, downloading: (n) => `Downloading ${n}…`, transferring: (n) => `Transferring ${n}…`,
    source: "Source", preview: "Preview", openInPreview: "Open in Preview", loadingImage: "Loading image…",
    imageTooBig: (n) => `Image is too large to preview (${n})`, imageFailed: "Couldn't show this image",
    newFile: "New file…", newFolder: "New folder…", rename: "Rename…", moveToTrash: "Move to Trash",
    newFileTitle: "New file", newFolderTitle: "New folder", renameTitle: (n) => `Rename “${n}”`,
    nameLabel: "Name", create: "Create", save: "Rename", in: (p) => `In ${p}`,
    badName: "Enter a name without “/”", exists: (n) => `“${n}” already exists`,
    created: (n) => `Created ${n}`, renamed: (a, b) => `Renamed ${a} → ${b}`, trashed: (n) => `Moved ${n} to the Trash`,
    createFailed: (n) => `Couldn't create ${n}`, renameFailed: (n) => `Couldn't rename ${n}`, trashFailed: (n) => `Couldn't move ${n} to the Trash`,
    remoteDelete: "This machine has no Trash: it will be deleted permanently.",
  },
  ru: {
    pasteHere: "Вставить сюда", pasteInto: "Вставить в эту папку", pasteBeside: "Вставить рядом",
    download: "Скачать в Загрузки", downloadFolder: "Скачать папку в Загрузки",
    copyPath: "Скопировать путь", reveal: "Показать в Finder", delete: "Удалить…",
    pathCopied: "Путь скопирован", nothingToPaste: "Нечего вставить",
    nothingToPasteBody: "Скопируйте файл или папку в Finder (⌘C), потом выберите «Вставить».",
    tooDangerous: (p) => `Слишком опасный путь: ${p}`, deleted: (n) => `Удалено: ${n}`,
    downloadFailed: (n) => `Не удалось скачать ${n}`, uploadFailed: (n) => n ? `Не удалось загрузить ${n}` : "Не удалось загрузить",
    deleteFailed: (n) => `Не удалось удалить ${n}`, failed: "Не получилось", code: (c) => `код ${c}`,
    items: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "объект" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "объекта" : "объектов"}`,
    downloaded: (n) => `Скачано: ${n}`, uploaded: (n) => `Загружено: ${n}`,
    askDelete: (dir, n) => `Удалить ${dir ? "папку" : "файл"} «${n}»?`,
    deleteDetail: (dir) => dir ? "Папка будет удалена со всем содержимым. Это нельзя отменить." : "Это нельзя отменить.",
    cancel: "Отмена", confirmDelete: "Удалить",
    uploading: (n) => `Загружается ${n}…`, downloading: (n) => `Скачивается ${n}…`, transferring: (n) => `Передаётся: ${n}…`,
    source: "Код", preview: "Просмотр", openInPreview: "Открыть в Просмотре", loadingImage: "Загружается изображение…",
    imageTooBig: (n) => `Изображение слишком большое для просмотра (${n})`, imageFailed: "Не удалось показать изображение",
    newFile: "Новый файл…", newFolder: "Новая папка…", rename: "Переименовать…", moveToTrash: "В Корзину",
    newFileTitle: "Новый файл", newFolderTitle: "Новая папка", renameTitle: (n) => `Переименовать «${n}»`,
    nameLabel: "Имя", create: "Создать", save: "Переименовать", in: (p) => `В папке ${p}`,
    badName: "Введите имя без «/»", exists: (n) => `«${n}» уже существует`,
    created: (n) => `Создано: ${n}`, renamed: (a, b) => `Переименовано: ${a} → ${b}`, trashed: (n) => `В Корзине: ${n}`,
    createFailed: (n) => `Не удалось создать ${n}`, renameFailed: (n) => `Не удалось переименовать ${n}`, trashFailed: (n) => `Не удалось переместить ${n} в Корзину`,
    remoteDelete: "На этой машине нет Корзины: удаление навсегда.",
  },
};
// Words that name this computer's desktop: Finder is the default; Windows has Explorer and
// the Recycle Bin; Linux a file manager.
const DESKTOP = {
  en: {
    windows: {
      reveal: "Show in Explorer", moveToTrash: "Move to Recycle Bin", openInPreview: "Open",
      trashed: (n) => `Moved ${n} to the Recycle Bin`, trashFailed: (n) => `Couldn't move ${n} to the Recycle Bin`,
      nothingToPasteBody: "Copy a file or folder in Explorer (Ctrl+C), then choose Paste.",
      remoteDelete: "This machine has no Recycle Bin: it will be deleted permanently.",
    },
    linux: {
      reveal: "Show in file manager", openInPreview: "Open",
      nothingToPasteBody: "Copy a file or folder in your file manager (Ctrl+C), then choose Paste.",
    },
  },
  ru: {
    windows: {
      reveal: "Показать в Проводнике", openInPreview: "Открыть",
      nothingToPasteBody: "Скопируйте файл или папку в Проводнике (Ctrl+C), потом выберите «Вставить».",
    },
    linux: {
      reveal: "Показать в файловом менеджере", openInPreview: "Открыть",
      nothingToPasteBody: "Скопируйте файл или папку в файловом менеджере (Ctrl+C), потом выберите «Вставить».",
    },
  },
};
const T = () => { const lang = STRINGS[shared(LANG_KEY)] ? shared(LANG_KEY) : "en"; return { ...STRINGS[lang], ...(DESKTOP[lang][platform()] ?? {}) }; };
// The paste key: ⌘V on a Mac, Ctrl+V elsewhere.
const PASTE_KEY = () => isMac() ? "cmd-v" : "ctrl-v";

// Previews: Markdown is drawn formatted (with a Source toggle); images are copied into the
// app folder first, because image() only reads from there, and the formats GPUI can't draw
// are turned into PNG with sips.
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|heic|heif|avif)$/i;
const CONVERT = /\.(ico|tiff?|heic|heif|avif)$/i;
const PREVIEW_DIR = "data/files-transfer/preview";
const MAX_IMAGE = 50 * 1024 * 1024;
// Preview Plus (linziyanleo/herdr-mods), when the layout pairs it with this panel in a stack
// (this block's props.previewStack names the stack, its child "preview-plus" shows the file):
// Markdown, PNG/JPEG/WebP/SVG images and PDFs open there. It reads media only from this
// computer, so a remote image or PDF is copied here first. Everything else stays in this panel.
const PP_TARGET = "preview-plus.target";
const PP_MARKDOWN = /\.(md|markdown)$/i;
const PP_MEDIA = /\.(png|jpe?g|webp|svg|pdf)$/i;
const bytesText = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// Paths join with "/" everywhere (Windows accepts both separators), but a Windows root
// arrives with backslashes, so these read either.
const parentOf = path => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || "/";
const basename = path => path.split(/[\\/]/).pop();
const norm = path => path.replace(/\\/g, "/");
// Path components, without a Windows drive letter: "/home/x" and "C:\Users\x" are both 2 deep.
const depth = path => path.split(/[\\/]/).filter(s => s && !/^[A-Za-z]:$/.test(s)).length;

// A menu row is [action, label, icon]; null draws a divider.
const MENU = (target, t = T()) => target.root
  ? [["paste", t.pasteHere, "paste.svg"], ["copy", t.copyPath, "copy.svg"], null,
     ["new-file", t.newFile, "file-plus.svg"], ["new-folder", t.newFolder, "folder-plus.svg"]]
  : [
      ["download", target.dir ? t.downloadFolder : t.download, "download.svg"],
      ["paste", target.dir ? t.pasteInto : t.pasteBeside, "paste.svg"],
      ["copy", t.copyPath, "copy.svg"],
      ...(target.on ? [] : [["reveal", t.reveal, "finder.svg"]]),
      null,
      ["new-file", t.newFile, "file-plus.svg"],
      ["new-folder", t.newFolder, "folder-plus.svg"],
      ["rename", t.rename, "pen.svg"],
      null,
      // Here: the Trash (Put Back works); another machine has none, so it asks and deletes.
      target.on ? ["delete", t.delete, "trash.svg"] : ["trash", t.moveToTrash, "trash.svg"],
    ];
// A name typed for a new entry or a rename: one path component.
const validName = (n) => n !== "" && n !== "." && n !== ".." && !/[\/\u0000-\u001f]/.test(n);
// Run on the entry's machine. Each refuses to replace what is there (exit 17).
const MAKE_FILE = 'set -C; [ -e "$1" ] || [ -L "$1" ] && exit 17; : > "$1"';
const MAKE_FOLDER = '[ -e "$1" ] || [ -L "$1" ] && exit 17; mkdir -- "$1"';
const MOVE = '[ -e "$2" ] || [ -L "$2" ] && exit 17; mv -- "$1" "$2"';
const menuHeight = list => list.reduce((h, it) => h + (it ? MENU_ROW : 9), 10);

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const DIR = "mods/files-transfer";

// Material Icon Theme's rules, as VS Code applies them: names match case-insensitively; a
// path rule (".github/workflows") beats a name, a name beats an extension, and the longest
// extension wins ("spec.ts" over "ts"). Light themes check the theme's light table first.
const bare = name => name.replace(/^__(.+)__$/, "$1").replace(/^[._-]/, "");
const opened = id => id.endsWith("_light") ? `${id.slice(0, -6)}-open_light` : `${id}-open`;
function lookup(table, key, dark) { return (dark ? undefined : ICONS.light[table][key]) ?? ICONS[table][key]; }
function icon(path, dir, open, dark) {
  const parts = path.toLowerCase().split("/"), name = parts[parts.length - 1];
  const table = dir ? "folderNames" : "fileNames", find = key => lookup(table, key, dark) ?? (dir ? lookup(table, bare(key), dark) : undefined);
  let id;
  for (let i = 0; !id && i < parts.length - 1; i++) id = find(parts.slice(i).join("/"));
  if (dir) {
    id ??= find(name) ?? ICONS.folder;
    return `${DIR}/icons/${open ? opened(id) : id}.svg`;
  }
  id ??= lookup(table, name, dark);
  for (let dot = name.indexOf("."); !id && dot !== -1; dot = name.indexOf(".", dot + 1)) id = lookup("fileExtensions", name.slice(dot + 1), dark);
  return `${DIR}/icons/${id ?? ICONS.file}.svg`;
}

async function directory(path, on) {
  if (!on && isWin()) {
    const r = await ps("ConvertTo-Json -Compress -InputObject @(Get-ChildItem -LiteralPath $a[0] -Force | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name = $_.Name; dir = ($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } })", [path]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    if (props()?.ask) return this.initAsk(cx);
    if (props()?.menu || props()?.confirm) { this.at = 0; this.handle = cx.focus_handle(); this.handle.focus(); return; }
    // Which panel a menu choice is for: the one that opened the menu.
    this.me = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.jobs = [];
    // ⌘V / Ctrl+V pastes into the selected row's folder: the panel takes the keyboard when clicked.
    this.keys = cx.focus_handle();
    desktop.cleanPreviews(`${appHome()}/${PREVIEW_DIR}`).catch(() => {});
    this.selected = null; // { path, dir } inside the shown folder
    cx.spawn(async cx => {
      const lang = await desktop.language().catch(() => "en");
      if (shared(LANG_KEY) !== lang) setShared(LANG_KEY, lang);
    });
    cx.timer.every(1000, cx => this.poll(cx));
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async cx => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.refresh(cx); } }
      catch { if (this.watched === root) this.watched = null; }
    });
  }

  async loadFolder(path, context) {
    const on = this.on, root = this.root;
    const entries = (await directory(path ? `${root}/${path}` : root, on)).filter(e => !TEMP.test(e.name));
    if (key() !== context || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set();
      this.pending = new Set(); this.marks = {}; this.selected = null; this.show(null); this.watched = null; this.error = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) await this.loadFolder(path, context);
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[norm(`${top.stdout.trim()}/${entry.slice(3)}`)] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (key() !== context) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (key() === context) this.error = String(e); }
          finally { this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.md = null; this.source = false;
    if (this.img) { remove(parentOf(this.img.abs)).catch(() => {}); this.img = null; }
    if (!path || !cx) return;
    if (IMAGE.test(path)) return this.showImage(path, cx);
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || key() !== context) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        if (MARKDOWN.test(path)) this.md = text.length > 400000 ? text.slice(0, 400000) : text;
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && key() === context) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // A copy of src (on machine `on`) in this mod's preview folder, here; its absolute path.
  async stage(src, on) {
    const size = await fileSize(src, on);
    if (size.code !== 0) throw new Error((size.stderr || T().imageFailed).trim());
    const bytes = Number(size.stdout.trim());
    if (bytes > MAX_IMAGE) throw new Error(T().imageTooBig(bytesText(bytes)));
    const dir = `${appHome()}/${PREVIEW_DIR}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await mkdirp(dir);
    const file = `${dir}/${basename(src)}`;
    const copied = on
      ? await exec("scp", ["-p", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `${await sshTarget(on)}:${src}`, file])
      : await copy(src, file);
    if (copied.code !== 0) { await remove(dir).catch(() => {}); throw new Error((copied.stderr || T().imageFailed).trim()); }
    return { file, bytes };
  }

  // Shows the file in the paired Preview Plus; false when it isn't paired or isn't for it.
  handoff(path, cx) {
    const stack = props()?.previewStack, markdown = PP_MARKDOWN.test(path);
    if (!stack || (!markdown && !PP_MEDIA.test(path))) return false;
    const abs = `${this.root}/${path}`, on = this.on ?? null, root = this.root;
    const go = (target) => {
      const f = focused(), space = f?.space ?? spaces().find(s => s.active)?.id;
      if (!space) return;
      setShared(PP_TARGET, { ...(shared(PP_TARGET) ?? {}), [space]: target });
      run("layout.select", { stack, child: "preview-plus" });
    };
    if (markdown || !on) { go({ file: abs, root, on: markdown ? on : null }); return true; }
    cx.spawn(async () => {
      try { const { file } = await this.stage(abs, on); go({ file, root: parentOf(file), on: null }); }
      catch (e) { notify({ title: T().imageFailed, body: String(e.message ?? e), level: "error" }); }
    });
    return true;
  }

  // An image: copied into the app folder (scp from a remote machine), converted when GPUI
  // can't draw its format, measured (sips, GDI+ or ImageMagick), then drawn fitted to the panel.
  showImage(path, cx) {
    const context = this.context, root = this.root, on = this.on ?? null, src = `${root}/${path}`;
    const ext = path.split(".").pop().toLowerCase(), id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    cx.spawn(async cx => {
      let file = null;
      try {
        const staged = await this.stage(src, on), dir = parentOf(staged.file), bytes = staged.bytes;
        file = `${dir}/${id}.${ext}`;
        await move(staged.file, file);
        if (CONVERT.test(path)) {
          const png = `${dir}/${id}.png`;
          const c = await desktop.toPng(file, png);
          await removeFiles([file]);
          file = png;
          if (c.code !== 0) throw new Error(T().imageFailed);
        }
        let w = null, h = null;
        if (ext !== "svg") {
          const d = await desktop.dimensions(file).catch(() => ({ stdout: "" }));
          w = Number(d.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]) || null;
          h = Number(d.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]) || null;
        }
        if (this.file !== path || key() !== context) { await remove(parentOf(file)); return; }
        this.img = { rel: norm(file.slice(appHome().length + 1)), abs: file, local: on ? null : src, w, h, bytes };
      } catch (e) {
        if (file) remove(parentOf(file)).catch(() => {});
        if (this.file === path && key() === context) this.fileError = String(e.message ?? e);
      } finally { cx.notify(); }
    });
  }

  // What an open file shows: an image, formatted Markdown, or the read-only code view.
  preview(t) {
    const img = this.img;
    if (img) {
      const room = { w: (this.size?.width ?? 360) - 32, h: (this.size?.height ?? 480) - 42 - 34 - 32 - (this.jobs.length ? 30 : 0) };
      const k = img.w && img.h ? Math.min(1, room.w / img.w, room.h / img.h) : null;
      const info = [img.w && `${img.w}×${img.h}`, bytesText(img.bytes), k !== null && k < 1 && `${Math.round(k * 100)}%`].filter(Boolean).join(" · ");
      return v_flex().flex_1().min_h(0)
        .child(div().id("files-image").flex_1().min_h(0).p(16).flex().items_center().justify_center().overflow_hidden().bg(t.canvas)
          .child(k !== null ? image(img.rel).w(Math.max(1, img.w * k)).h(Math.max(1, img.h * k)) : image(img.rel).size_full()))
        .child(h_flex().h(34).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(12).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(info))
          .child(div().id("files-open-preview").px(8).py(3).rounded(6).cursor_pointer().text_color(t.muted)
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => desktop.open(img.local ?? img.abs).catch(() => {}))
            .child(T().openInPreview)));
    }
    if (this.md !== null && !this.source) {
      return div().id("files-md").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).text_size(13.5)
        .child(TextView.markdown(`md-${this.file}`, this.md).selectable(true));
    }
    if (this.code) return Editor.new(this.code).flex_1().min_h(0);
    return div().p(12).text_color(t.dim).child(this.fileError || (IMAGE.test(this.file) ? T().loadingImage : "Loading file…"));
  }

  // path: inside the shown folder ("" for the folder itself).
  openMenu(path, dir) {
    const target = path
      ? { path: `${this.root}/${path}`, name: path.split("/").pop(), dir, on: this.on ?? null, from: this.me }
      : { path: this.root, name: basename(this.root), dir: true, root: true, on: this.on ?? null, from: this.me };
    openOverlay({ mod: "files-transfer", kind: "popup", width: 250, height: menuHeight(MENU(target)), props: { menu: target } });
  }

  // A choice made in the menu or the confirmation, for this panel.
  take(cx) {
    const req = shared(REQUEST);
    if (!req || req.from !== this.me || req.id === this.lastRequest) return;
    this.lastRequest = req.id;
    setShared(REQUEST, null);
    const { action, path, name, dir, on } = req;
    if (action === "delete") {
      openOverlay({ mod: "files-transfer", kind: "dialog", width: 420, height: 176, props: { confirm: { path, name, dir, on, from: this.me } } });
      return;
    }
    if (action === "new-file" || action === "new-folder" || action === "rename") {
      // New entries go into the folder clicked, or beside the file clicked.
      const folder = action === "rename" ? parentOf(path) : dir ? path : parentOf(path);
      openOverlay({ mod: "files-transfer", kind: "dialog", width: 440, height: 214,
        props: { ask: { kind: action, folder, path, name, dir, on, from: this.me } } });
      return;
    }
    cx.spawn(async cx => {
      try {
        if (action === "copy") {
          const r = await desktop.copyText(path);
          if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
          notify({ title: T().pathCopied, body: path, level: "info", timeout: 2500 });
        } else if (action === "reveal") {
          await desktop.reveal(path);
        } else if (action === "download") {
          await this.download(path, name, dir, on);
        } else if (action === "paste") {
          await this.paste(dir ? path : parentOf(path), on);
        } else if (action === "trash") {
          if (on || path === this.root || depth(path) < 2) throw new Error(T().tooDangerous(path));
          const r = await desktop.trash(path);
          if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
          notify({ title: T().trashed(name), body: path.replace(home(), "~"), level: "success", timeout: 4000 });
          if (this.file && `${this.root}/${this.file}`.startsWith(path)) this.show(null);
          this.refresh(cx);
        } else if (action === "create-file" || action === "create-folder") {
          const target = `${req.folder}/${req.value}`;
          const r = await makeEntry(action === "create-file" ? "file" : "folder", target, on);
          if (r.code === 17) throw new Error(T().exists(req.value));
          if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
          notify({ title: T().created(req.value), body: on ? `${on}:${target}` : target.replace(home(), "~"), level: "success", timeout: 3000 });
          this.reveal(target, action === "create-folder");
          this.refresh(cx);
        } else if (action === "rename-yes") {
          const target = `${parentOf(path)}/${req.value}`;
          if (target === path) return;
          const r = await rename(path, target, on);
          if (r.code === 17) throw new Error(T().exists(req.value));
          if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
          notify({ title: T().renamed(name, req.value), body: on ? `${on}:${target}` : target.replace(home(), "~"), level: "success", timeout: 3000 });
          if (this.file && `${this.root}/${this.file}` === path) this.show(null);
          this.reveal(target, dir);
          this.refresh(cx);
        } else if (action === "delete-yes") {
          // Never the shown folder itself, the home folder or a root-level path.
          if (path === this.root || depth(path) < 2) throw new Error(T().tooDangerous(path));
          const r = await remove(path, on);
          if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
          notify({ title: T().deleted(name), body: on ? `${on}:${path}` : path, level: "success", timeout: 4000 });
          if (this.file && `${this.root}/${this.file}`.startsWith(path)) this.show(null);
          this.refresh(cx);
        }
      } catch (e) {
        const what = { download: T().downloadFailed(name), paste: T().uploadFailed(), "delete-yes": T().deleteFailed(name),
          trash: T().trashFailed(name), "create-file": T().createFailed(req.value), "create-folder": T().createFailed(req.value),
          "rename-yes": T().renameFailed(name) }[action] ?? T().failed;
        notify({ title: what, body: String(e.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  // Files copied in Finder / Explorer, uploaded into folder (absolute, on the machine `on`).
  async paste(folder, on) {
    const files = await desktop.clipboardFiles();
    if (!files.length) return notify({ title: T().nothingToPaste, body: T().nothingToPasteBody, level: "warning", timeout: 5000 });
    await this.upload(files, folder, on);
  }

  // ⌘V / Ctrl+V: into the selected folder, beside the selected file, else into the shown folder.
  pasteKey(cx) {
    if (!this.root) return;
    const sel = this.selected;
    const folder = !sel ? this.root : sel.dir ? `${this.root}/${sel.path}` : parentOf(`${this.root}/${sel.path}`);
    const on = this.on ?? null;
    cx.spawn(async cx => {
      try { await this.paste(folder, on); }
      catch (e) { notify({ title: T().uploadFailed(), body: String(e.message ?? e), level: "error" }); }
      cx.notify();
    });
  }

  // A new or renamed entry: its folders open in the tree and it is selected.
  reveal(abs, dir) {
    if (!abs.startsWith(`${this.root}/`)) return;
    const rel = abs.slice(this.root.length + 1), parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
    this.selected = { path: rel, dir };
  }

  async download(path, name, dir, on) {
    const src = on ? `${await sshTarget(on)}:${path}` : path;
    const status = `${appHome()}/${WORKERS}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const downloads = `${home()}/Downloads`, mode = on ? "scp" : "cp", isdir = dir ? "1" : "0";
    if (isWin()) await detach({ kind: "fetch", st: status, src, dir: downloads, name, mode, isdir });
    else {
      const r = await exec("sh", ["-c", FETCH, "fetch", src, downloads, name, status, mode, isdir]);
      if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
    }
    this.jobs.push({ kind: "download", status, name });
  }

  // Local files into dir on the shown folder's machine: into a temporary folder there
  // first, then into place under free names (PLACE), so nothing is overwritten.
  async upload(files, dir, on) {
    const mk = await tempDir(dir, on);
    if (mk.code !== 0) throw new Error((mk.stderr || `exit ${mk.code}`).trim());
    const tmp = mk.stdout.trim();
    const dest = on ? `${await sshTarget(on)}:${tmp}/` : `${tmp}/`;
    const status = `${appHome()}/${WORKERS}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mode = on ? "scp" : "cp";
    try {
      if (isWin()) await detach({ kind: "send", st: status, mode, dest, files });
      else {
        const r = await exec("sh", ["-c", SEND, "send", status, mode, dest, ...files]);
        if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
      }
    } catch (e) {
      await remove(tmp, on).catch(() => {});
      throw e;
    }
    const name = files.length === 1 ? basename(files[0]) : T().items(files.length);
    this.jobs.push({ kind: "upload", status, name, tmp, dir, on });
  }

  // Finished transfers write their exit code to the status file.
  poll(cx) {
    if (!this.jobs?.length) return;
    cx.spawn(async cx => {
      let changed = false;
      for (const job of [...this.jobs]) {
        const code = await readTextFile(job.status).catch(() => null);
        if (code === null) continue;
        this.jobs = this.jobs.filter(j => j !== job);
        changed = true;
        const ok = code.trim() === "0";
        const log = (await readTextFile(`${job.status}.log`).catch(() => null))?.trim();
        const fail = log?.split("\n").pop() || T().code(code.trim());
        if (job.kind === "download") {
          const dest = (await readTextFile(`${job.status}.dest`).catch(() => null)) || `${home()}/Downloads/${job.name}`;
          if (ok) notify({ title: T().downloaded(basename(dest)), body: dest.replace(home(), "~"), level: "success", timeout: 6000 });
          else notify({ title: T().downloadFailed(job.name), body: fail, level: "error" });
        } else {
          try {
            if (!ok) throw new Error(fail);
            const r = await place(job.tmp, job.dir, job.on);
            if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
            const names = r.stdout.trim().split(/\r?\n/).filter(Boolean);
            notify({ title: T().uploaded(names.length === 1 ? names[0] : T().items(names.length)),
              body: job.on ? `${job.on}:${job.dir}` : job.dir.replace(home(), "~"), level: "success", timeout: 6000 });
          } catch (e) {
            notify({ title: T().uploadFailed(job.name), body: String(e.message ?? e), level: "error" });
          }
          await remove(job.tmp, job.on).catch(() => {});
          this.refresh(cx);
        }
        await removeFiles([job.status, `${job.status}.log`, `${job.status}.dest`]).catch(() => {});
      }
      if (changed) cx.notify();
    });
  }

  // Files dragged in from Finder / Explorer: uploaded into dir (a folder inside the shown one, "" for it).
  drop(paths, dir, cx) {
    if (!paths?.length || !this.root) return;
    const target = dir ? `${this.root}/${dir}` : this.root, on = this.on ?? null;
    cx.spawn(async cx => {
      try { await this.upload(paths, target, on); }
      catch (e) { notify({ title: T().uploadFailed(), body: String(e.message ?? e), level: "error" }); }
      cx.notify();
    });
  }

  menu(t) {
    const target = props().menu, list = MENU(target), items = list.filter(Boolean);
    const choose = it => {
      setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, action: it[0], ...target });
      closeOverlay(props().overlay);
    };
    return v_flex().id("files-menu").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % items.length;
        else if (e.key === "up") this.at = (this.at + items.length - 1) % items.length;
        else if (e.key === "enter") choose(items[this.at]);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, n) => {
        if (!it) return div().mx(7).my(4).h(1).bg(t.border);
        const i = items.indexOf(it), danger = it[0] === "delete";
        return h_flex().id(`fm-${n}`).h(MENU_ROW).px(8).gap(9).rounded(7).items_center().cursor_pointer()
          .when(i === this.at, el => el.bg(t.hover)).hover(s => s.bg(t.hover))
          .on_hover((on, cx) => { if (on && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click(() => choose(it))
          .child(svg(`${DIR}/${it[2]}`).size(14).flex_none().text_color(danger ? t.ansi1 : t.muted))
          .child(div().flex_1().min_w(0).truncate().text_color(danger ? t.ansi1 : t.foreground).child(it[1]));
      }));
  }

  // A name for a new file or folder, or a new name: Enter creates or renames, Esc cancels.
  initAsk(cx) {
    const a = props().ask, value = a.kind === "rename" ? a.name : "";
    this.text = value; this.askError = null;
    this.input = InputState.new({ value });
    // Renaming a file selects its name without the extension, as Finder does.
    const dot = a.kind === "rename" && !a.dir ? value.lastIndexOf(".") : -1;
    if (value) this.input.set_selected_range({ start: 0, end: dot > 0 ? dot : value.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.askError = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => { this.submitAsk(); cx.notify(); });
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submitAsk() {
    const a = props().ask, value = this.text.trim();
    if (!validName(value)) { this.askError = T().badName; return; }
    const action = { "new-file": "create-file", "new-folder": "create-folder", rename: "rename-yes" }[a.kind];
    setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, action, ...a, value });
    closeOverlay(props().overlay);
  }

  ask(t) {
    const a = props().ask;
    const title = a.kind === "rename" ? T().renameTitle(a.name) : a.kind === "new-file" ? T().newFileTitle : T().newFolderTitle;
    const where = a.on ? `${a.on}:${a.folder}` : a.folder.replace(home(), "~");
    const button = (id, label, primary, act) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12.5).cursor_pointer().hover(s => s.opacity(0.88)).on_click(act).child(label);
    return v_flex().id("files-ask").track_focus(this.handle).size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().text_size(14).font_semibold().truncate().child(title))
      .child(div().pt(4).text_size(12).text_color(t.dim).truncate().child(T().in(where)))
      .child(div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(T().nameLabel))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.askError ? t.ansi1 : t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().h(18).pt(4).text_size(11.5).text_color(t.ansi1).child(this.askError ?? ""))
      .child(h_flex().flex_1().items_end().justify_end().gap(8)
        .child(button("ask-cancel", T().cancel, false, () => closeOverlay(props().overlay)))
        .child(button("ask-ok", a.kind === "rename" ? T().save : T().create, true, (_e, cx) => { this.submitAsk(); cx.notify(); })));
  }

  // "Delete …?" with the path and the machine; Enter deletes, Esc cancels.
  confirm(t) {
    const c = props().confirm;
    const yes = () => {
      setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, action: "delete-yes", ...c });
      closeOverlay(props().overlay);
    };
    const button = (id, label, bg, fg, border, act) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(border).bg(bg)
      .text_color(fg).cursor_pointer().hover(s => s.opacity(0.88)).on_click(act).child(label);
    return v_flex().id("files-confirm").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "enter") yes();
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .child(div().font_semibold().text_size(14).text_color(t.foreground).truncate().child(T().askDelete(c.dir, c.name)))
      .child(div().text_size(12).text_color(t.muted).truncate().child(c.on ? `${c.on}:${c.path}` : c.path))
      .child(div().text_size(12).text_color(t.dim).child(`${c.on ? `${T().remoteDelete} ` : ""}${T().deleteDetail(c.dir)}`))
      .child(h_flex().flex_1().items_end().justify_end().gap(8)
        .child(button("no", T().cancel, t.popover, t.foreground, t.input, () => closeOverlay(props().overlay)))
        .child(button("yes", T().confirmDelete, t.ansi1, t.background, t.ansi1, yes)));
  }

  select(path, dir) {
    this.selected = { path, dir };
    this.keys?.focus();
  }

  rows(prefix, depth, out, t, dark) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[norm(`${this.root}/${path}`)];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(this.selected?.path === path, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.select(path, entry.dir); entry.dir ? this.toggle(path, cx) : this.handoff(path, cx) || this.show(path, cx); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.select(path, entry.dir); cx.notify(); this.openMenu(path, entry.dir); })
        .on_drop((e, cx) => { cx.stop_propagation(); this.drop(e.paths, entry.dir ? path : prefix, cx); })
        .child(entry.dir ? svg(`${DIR}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(icon(path, entry.dir, open, dark)).size(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, dark);
    }
    return out;
  }

  render(cx) {
    if (props()?.menu) return this.menu(theme());
    if (props()?.confirm) return this.confirm(theme());
    if (props()?.ask) return this.ask(theme());
    this.take(cx);
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), dark = Boolean(settings().dark);
    return v_flex().id("files").track_focus(this.keys).size_full().min_h(0)
      .on_key_down((e, cx) => {
        if (e.keystroke === PASTE_KEY()) { cx.stop_propagation(); this.pasteKey(cx); }
        else if (e.keystroke === "escape" && this.selected) { cx.stop_propagation(); this.selected = null; cx.notify(); }
      })
      // Sizes arrive in window points; element sizes are given at zoom 1.
      .on_size_change((size, cx) => {
        const z = settings().zoom || 1, w = size.width / z, h = size.height / z;
        if (w !== this.size?.width || h !== this.size?.height) { this.size = { width: w, height: h }; cx.notify(); }
      })
      .rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(h_flex().flex_1().min_w(0).gap(6).justify_end().items_center().text_size(12).text_color(t.dim)
          .when(Boolean(this.file), el => el.child(image(icon(this.file, false, false, dark)).size(14).flex_none()))
          .child(div().min_w(0).truncate().child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
          .when(this.md !== null && Boolean(this.file), el => el.child(div().id("files-md-toggle").flex_none().px(8).py(2).ml(4).rounded(6).border_1().border_color(t.border)
            .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.source = !this.source; cx.notify(); })
            .child(this.source ? T().preview : T().source)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_mouse_down("left", (_e, cx) => { this.selected = null; this.keys.focus(); cx.notify(); })
        .on_mouse_down("right", () => this.root && this.openMenu("", true))
        .on_drop((e, cx) => this.drop(e.paths, "", cx)).children(this.rows("", 0, [], t, dark))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.preview(t)))
      .when(this.jobs.length > 0, el => el.child(h_flex().h(30).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(svg(`${DIR}/spinner.svg`).size(12).flex_none().text_color(t.working).spin(900))
        .child(div().flex_1().min_w(0).truncate().child(this.jobs.length === 1 ? T()[this.jobs[0].kind === "upload" ? "uploading" : "downloading"](this.jobs[0].name) : T().transferring(this.jobs.length)))));
  }
}
