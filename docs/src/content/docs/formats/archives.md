---
title: Check ZIP and TAR uploads file by file
description: How ZIP, TAR, GZ and TGZ uploads are checked, and why RAR and 7z are only checked by signature.
sidebar:
  label: Archives
---

| Extension | Risk | Checked |
| - | - | - |
| `zip` | `elevated` | Every file inside |
| `tar` | `elevated` | Every file inside |
| `gz` | `elevated` | The tar or the single file inside |
| `tgz` | `elevated` | The tar inside |
| `rar` | `unchecked` | Signature only |
| `7z` | `unchecked` | Signature only |

None of these are in the default list. An archive would otherwise be a way around every other check.

## How a ZIP or TAR is checked

Each file inside must:

- have an extension in your `allowedExtensions`,
- not be an archive itself,
- pass the checks it would pass uploaded alone, its structure included.

The first file that fails decides the reason. A `.docx` with macros inside makes the ZIP fail as `macros`, an `.exe` or a file of a format you did not allow as `content-mismatch`.

Refused as `content-mismatch` too:

- symbolic and hard links, devices and other special entries
- paths that are absolute or contain `..`
- archives without any file
- ZIP64, base-256 tar sizes and other forms the reader does not model
- more than 2,000 entries, or more than 100 MB unpacked

Password-protected ZIP entries are refused as `encrypted`.

macOS adds `__MACOSX/._*` and `.DS_Store` files to archives it makes. They are skipped when their bytes really are that metadata.

A `.gz` holds a tar or a single file, named in the gzip header. Without a name it is refused, since its format would be unknown.

## Limits

- Archives are stored as uploaded, not rewritten. Photos inside keep their metadata.
- Whoever unpacks the archive gets the files at the paths inside, so unpack them yourself only into a fresh directory.

## RAR and 7z

Reading them needs a decompressor that upload-safety, with no dependencies, does not have. Only their signature is checked, so anything can be inside. If you accept them, serve them only as downloads, and scan them first.
