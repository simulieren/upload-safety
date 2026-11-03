---
title: OpenDocument
description: Checks for LibreOffice and OpenOffice text, spreadsheet and presentation files.
---

| Extension | MIME type |
| - | - |
| `odt` | `application/vnd.oasis.opendocument.text` |
| `ods` | `application/vnd.oasis.opendocument.spreadsheet` |
| `odp` | `application/vnd.oasis.opendocument.presentation` |

OpenDocument files are ZIP archives, read with the same caps as OOXML. The `mimetype` entry must name the type that matches the extension, so an `.ods` renamed to `.odt` is refused as `content-mismatch`.

Refused as `macros`:

- Basic and script modules.
- Embedded OLE objects.
- Event listeners, such as a script that runs when the document opens.
- Links to macros (`vnd.sun.star.script:` and `macro:` URLs in attributes).

A manifest that lists encrypted entries is refused as `encrypted`.
