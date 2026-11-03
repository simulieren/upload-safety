---
title: Limits
description: What upload-safety does not check, and the size caps it reads files with.
---

## Not an antivirus scan

These checks refuse active content and anything they cannot read. They do not judge whether the data in an otherwise plain file is malicious, such as an image crafted to crash a decoder.

## Known gaps

- Documents embedded in other documents, such as the workbook behind a Word chart, are not opened.
- DDE is not looked for in legacy `.doc` files.
- DDE is not found in an `.xlsx` cell formula that names a DDE source without an external link part.
- Image dimensions are not checked. See [Serving uploads safely](/guides/serving-uploads/).
- Metadata in Office and PDF files, such as author names, is kept.
- GPS recorded per frame in a video's metadata track (GoPro, DJI) and Ogg comments are kept.
- Files inside archives are checked but not rewritten, so they keep their metadata.
- RAR and 7z are checked by signature only. See [Choosing formats](/formats/risk/).
- RTF is checked against a list of what Word runs; a spelling Word accepts and the check does not know would pass.

## Size caps

ZIP and OLE files are read with caps against zip bombs and malformed sector chains. Past a cap, the file counts as unreadable and is refused as `content-mismatch`.

| Constant | Value |
| - | - |
| `MAX_ZIP_ENTRIES` | 2,000 entries |
| `MAX_ZIP_UNCOMPRESSED_BYTES` | 100 MB in total |
| `MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES` | 100 MB per entry |
| `MAX_OLE_STREAM_BYTES` | 64 MB per stream |

:::caution[Running a virus scanner after the checks]
Keep the ZIP caps at or below the scanner's own limits. ClamAV, for one, reports content past `MaxScanSize` and `MaxFileSize` as clean, so a file larger than its limits but smaller than these caps would pass both.
:::
