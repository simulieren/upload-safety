---
title: Serving uploads safely
description: What to do before and after the checks, from body limits to download headers.
---

upload-safety checks the bytes it is handed. The rest of the upload path is up to you.

## Before the checks

**Limit the request body before reading it.** `maxBytes` is checked after the whole file is in memory, so cap the body in your server or proxy first.

**Limit image dimensions before resizing.** A small JPEG or PNG can declare a huge size. These checks do not decode images, so cap width and height in whatever makes thumbnails (sharp's `limitInputPixels`, ImageMagick's `policy.xml`).

## Storing

Store `result.bytes`, not the bytes you received. For photos they are the cleaned copy without GPS and other metadata.

Store under `result.filename` or, better, under a generated key, and keep `result.filename` as a display name. `sanitizeFilename` removes path parts and Windows device names, but two users can still upload `cv.pdf`.

## Serving

Send stored files as downloads:

```http
Content-Type: application/pdf
Content-Disposition: attachment; filename="cv.pdf"
X-Content-Type-Options: nosniff
```

Use the canonical `result.mimeType`, not the one the client declared. Serving uploads from a separate origin (a different domain, not a subdomain that shares cookies) keeps a file that slips through away from your session cookies.

## Metadata in documents

Only photos are stripped. Author names in Office and PDF files, and EXIF in images inside documents, are kept.

## Virus scanning

These checks refuse active content. They do not recognise malware in data. If you need that, run a scanner after the checks, and keep the [ZIP limits](/reference/limits/) at or below its own.
