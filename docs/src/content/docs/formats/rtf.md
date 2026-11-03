---
title: Detect OLE objects and DDE in RTF uploads
description: How RTF uploads are checked for embedded objects, remote templates and DDE fields.
sidebar:
  label: RTF
---

Extension `rtf`, MIME type `application/rtf` or `text/rtf`. Risk `elevated`, so it is accepted only when named in `allowedExtensions`.

RTF has no macros, but it carries embedded OLE objects, and those have delivered some of the most used Office exploits: Equation Editor (CVE-2017-11882) and auto-loading links (CVE-2017-0199). Word opens any file starting with `{\rt` as RTF, whatever its extension.

## Refused as `macros`

The file is read like an RTF reader reads it: groups, control words, hex escapes and `\bin` data. It is refused on:

| Control word | Why |
| - | - |
| Any word starting with `obj` (`\object`, `\objdata`, `\objupdate`, `\objautlink`, ...) | Embedded or linked OLE objects |
| `\template` | An attached template, which can be remote and carry macros |
| `\datastore` | Data that can hide an object |
| A field whose instruction names `DDE`, `DDEAUTO` or `QUOTE` with character codes | Runs a command when Word opens the file |

Field instructions are read the way Word reads them: across groups, hex escapes, Unicode escapes and line breaks, so `{D}{DE}AUTO` and `\'44\'44\'45` are caught. The word DDE in body text is not refused.

## Limits

This is a denylist of what Word runs or loads. A spelling Word accepts and this check does not know would pass. Fields that fetch remote content without running it, such as `INCLUDEPICTURE` with a URL, are not refused.
