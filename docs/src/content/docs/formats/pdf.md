---
title: PDF
description: What upload-safety checks in a PDF beyond the %PDF signature.
---

Extension `pdf`, MIME type `application/pdf`.

## Refused as `macros`

Anything a reader runs, submits or opens on its own:

| Feature | PDF names |
| - | - |
| JavaScript | `/S /JavaScript`, a `/JavaScript` name tree |
| Launching a program or file | `/S /Launch` |
| Sending form data | `/S /SubmitForm`, `/S /ImportData` |
| Links to other files | `/S /GoToR`, `/S /GoToE` |
| Multimedia | `/S /Rendition`, `/Subtype /RichMedia` |
| XFA forms | `/XFA` |
| Attachments | `/EmbeddedFiles`, `/Type /EmbeddedFile`, `/Subtype /FileAttachment` |

Names count only where a reader takes them for one: an action type after `/S`, a type after `/Type` or `/Subtype`, or a key before its value. A link to `https://developer.mozilla.org/en-US/docs/Web/JavaScript/` in the text does not trip the check. Names spelled with `#xx` escapes, such as `/Java#53cript`, are decoded first.

PDF writers can pack dictionaries into compressed object streams. Every Flate-compressed object stream is inflated and searched too, within fixed limits. A stream that cannot be read counts as a refusal.

## Refused as `encrypted`

A PDF that asks for a password to open. One that only restricts permissions (printing, copying) opens without a password and passes, unless its object streams are encrypted, since then they cannot be checked. `isEncryptedPdf( buffer )` runs this check alone.

## Not checked

Plain links to web pages, fonts and images, and document metadata such as the author. See [Limits](/reference/limits/).
