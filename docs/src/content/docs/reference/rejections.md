---
title: Rejection reasons
description: The seven values of UploadRejection and what triggers each.
---

| Reason | When |
| - | - |
| `empty` | The file has no bytes. |
| `too-large` | The file is larger than `maxBytes`. |
| `type-not-allowed` | The extension is not supported, or not in `allowedExtensions`. |
| `mime-mismatch` | The declared MIME type does not belong to the extension. An empty type, `application/octet-stream` and `application/zip` are accepted for every extension. |
| `content-mismatch` | The bytes are not what the extension says, or cannot be read: a wrong signature, a zip bomb, a malformed ZIP or OLE file, a broken photo, an image sequence, binary data in a text file. |
| `macros` | The file carries active content. See below. |
| `encrypted` | The file is password-protected, so its content cannot be checked. |

The checks run in this order, so a file that is too large is refused as `too-large` before its bytes are read.

## What `macros` covers

The name is short for all active content:

- VBA projects and ActiveX controls in Office files
- Excel 4.0 macro sheets
- Embedded and linked OLE objects
- DDE fields and links
- `altChunk` imports, subdocuments, frames and remote templates
- Basic and script modules, event listeners and macro links in OpenDocument files
- JavaScript, launch, submit and import actions, links to other files, multimedia, XFA forms and attachments in PDFs
- Formulas that call a function or DDE in CSV files

The per-format pages list the details: [PDF](/formats/pdf/), [Office](/formats/office/), [OpenDocument](/formats/opendocument/), [CSV](/formats/csv-and-text/).
