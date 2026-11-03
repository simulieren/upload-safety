---
title: File upload validation beyond magic bytes
sidebar:
  label: What it catches
description: Concrete uploads and what upload-safety does with each.
---

| Upload | Result |
| - | - |
| `cv.pdf` that is a Windows executable | refused, `content-mismatch` |
| `report.docx` with a VBA project, also renamed or hidden behind a content type | refused, `macros` |
| `invoice.docx` with an embedded OLE package that runs a file on double click | refused, `macros` |
| `letter.docx` with a `DDEAUTO` field, also split across runs or spelled with `QUOTE` | refused, `macros` |
| `template.docx` that loads a remote `.dotm` on opening | refused, `macros` |
| `form.pdf` with JavaScript, a launch action or an attachment, also in compressed object streams | refused, `macros` |
| `budget.xls` with a very hidden Excel 4.0 macro sheet | refused, `macros` |
| `notes.odt` with a Basic macro or an event listener | refused, `macros` |
| `export.csv` with `=HYPERLINK(...)` or `=cmd\|' /C calc'!A0` in a cell | refused, `macros` |
| `contract.docx` saved with a password | refused, `encrypted` |
| `data.xlsx` that is a zip bomb | refused, `content-mismatch` |
| `holiday.jpg` with GPS coordinates | accepted, EXIF, XMP, IPTC and comments removed, orientation kept |
| `IMG_0042.heic` from an iPhone | accepted, EXIF and XMP overwritten in place, pixels unchanged |
| `../../CON.pdf`, a plain PDF | accepted, stored as `_CON.pdf` |

Every check fails closed: a part it cannot read is a refusal, not a pass.

## Why the extension and MIME type are not enough

Both come from the client. Anyone can name an executable `cv.pdf` and send it as `application/pdf`. Checking the first bytes (the magic number) is a step up, but it only says what kind of container a file is. A `.docx` with a VBA project has the same ZIP signature as a clean one, and a PDF with an `/OpenAction` script starts with `%PDF` like every other.

upload-safety reads the structure behind the signature: the ZIP central directory and content types of an Office file, the OLE directory of a legacy one, the dictionaries and object streams of a PDF, the chunks of a photo. The [Formats](/formats/pdf/) pages list what is checked for each.

## What it is not

It is not an antivirus scan. It refuses active content and anything it cannot read, but it does not judge whether the data in an otherwise plain file is malicious. See [Limits](/reference/limits/).
