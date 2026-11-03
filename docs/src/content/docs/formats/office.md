---
title: Microsoft Office
description: Checks for Word, Excel and PowerPoint files, both OOXML and the legacy binary formats.
---

| Extension | MIME type |
| - | - |
| `docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `doc` | `application/msword` |
| `xls` | `application/vnd.ms-excel` |
| `ppt` | `application/vnd.ms-powerpoint` |

`application/octet-stream`, `application/zip` and an empty type are accepted for every extension, since browsers send them for Office files.

## OOXML: docx, xlsx, pptx

These are ZIP archives. The central directory is read with caps on entry count and inflated size, so a zip bomb is refused as `content-mismatch`. `[Content_Types].xml` and the main part (`word/document.xml`, `xl/workbook.xml` or `ppt/presentation.xml`) must be there.

Refused as `macros`:

- VBA projects and ActiveX controls, found by part name, by content type and by relationship type, so renaming `vbaProject.bin` does not hide it.
- Embedded and linked OLE objects, such as a Package object that runs a file on double click.
- `altChunk` imports, which pull another document in when Word opens the file.
- Subdocuments, frames and attached templates that point outside the file, such as a remote `.dotm`.
- DDE fields in Word (`DDE`, `DDEAUTO`, also split across runs or built with `QUOTE`) and DDE links in Excel.

An OOXML file saved with a password is an OLE compound file with an `EncryptedPackage` stream. It is refused as `encrypted`.

## Legacy: doc, xls, ppt

These are OLE compound files. The directory and sector chains are read with caps, and the stream the format needs (`WordDocument`, `Workbook` or `Book`, `PowerPoint Document`) must be there.

Refused as `macros`:

- VBA storages.
- Embedded OLE objects.
- Excel 4.0 macro sheets, including very hidden ones.
- DDE and OLE links in Excel.
- PowerPoint VBA and embedded object records.

Files with the encryption flag set are refused as `encrypted`.

DDE is not looked for in legacy `.doc` files. See [Limits](/reference/limits/).
