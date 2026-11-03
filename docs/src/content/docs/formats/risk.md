---
title: Which file types are safe to accept
description: The risk level of every format upload-safety supports, and which ones are opt-in.
sidebar:
  label: Choosing formats
---

Every format has a risk level, exported as `FORMAT_RISK`. Only `low` formats are in the default list, `ALLOWED_EXTENSIONS`. The others are accepted only when you name them in `allowedExtensions`, so upgrading the package never makes your app accept a riskier format on its own.

| Risk | Formats | What it means |
| - | - | - |
| `low` | `pdf`, `doc` `docx`, `xls` `xlsx`, `ppt` `pptx`, `odt` `ods` `odp`, `jpg` `jpeg` `png` `webp` `heic` `heif` `avif` `gif` `bmp` `ico`, `mp3` `aac` `wav` `flac` `ogg` `m4a`, `mp4` `mov` `webm` `mkv` `avi`, `csv` `txt` | Read in full. Nothing in them runs once the checks pass. |
| `elevated` | `md`, `rtf`, `wma` `wmv`, `zip` `tar` `gz` `tgz` | Read in full, but each carries a risk the checks cannot remove. |
| `unchecked` | `rar`, `7z` | Only the signature is checked. Anything can be inside. |

## Why the elevated formats are elevated

**RTF** is one of the most common ways malware reaches Office users, through embedded OLE objects such as Equation Editor exploits. upload-safety refuses any object, attached template, data store and DDE field. Word's RTF reader is lenient, though, so a spelling it accepts and this check does not know stays possible. See [RTF](/formats/rtf/).

**WMA and WMV** use Microsoft's ASF container, which Windows Media Player opens, not browsers. Script commands in it make the player open URLs, and DRM objects carry license URLs it opens, which malware has used. Both are refused. What stays is a container read by a player with a long history of exploits. See [Audio and video](/formats/audio-and-video/).

**Markdown** is plain text, and is checked as such. The risk is in rendering it: raw HTML and `javascript:` links become part of your page. Sanitize the HTML you render, or offer the file only as a download.

**Archives** pass only when every file inside would pass on its own and is of a format in your list. But they are not rewritten, so photos inside keep their GPS position, and whoever unpacks them gets files your app never stored one by one. See [Archives](/formats/archives/).

## Why RAR and 7z are unchecked

Reading them needs an LZMA, PPMd or RAR decompressor. upload-safety has no dependencies and does not ship one, so it cannot see inside. Accept them only if you have to, serve them as downloads, and run a virus scanner first.

## Opting in

```ts
import { ALLOWED_EXTENSIONS, checkUpload } from 'upload-safety';

checkUpload( file, { maxBytes, allowedExtensions: [ ...ALLOWED_EXTENSIONS, 'zip', 'rtf' ] } );
```

Files inside an archive are checked against the same list, so a ZIP of PDFs needs `'pdf'` in it too. Nested archives are always refused.

```ts
import { FORMAT_RISK } from 'upload-safety';

FORMAT_RISK.rtf; // 'elevated'
```
