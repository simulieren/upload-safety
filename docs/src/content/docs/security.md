---
title: Security
description: How to report a way past a check, and what counts as in scope.
---

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the [Security tab](https://github.com/simulieren/upload-safety/security) and choose **Report a vulnerability**. Please do not open a public issue.

Useful reports name the check that was bypassed, include a file or a script that builds one, and say which version you tested.

You should hear back within a week. Once a fix is released, the advisory is published with credit, unless you ask not to be named.

## In scope

- A file with active content (macros, embedded objects, DDE, PDF scripts or attachments, event listeners) that passes `checkUpload` or `inspectFileContent`.
- A file whose bytes are of another type than its extension that passes.
- Metadata that survives `stripPhotoMetadata`.
- Input that makes a check crash, hang or use far more memory than the file's size suggests.

## Out of scope

The gaps listed in [Limits](/reference/limits/), such as DDE in legacy `.doc` files and documents nested inside other documents.

## Supported versions

Only the latest release gets fixes.
