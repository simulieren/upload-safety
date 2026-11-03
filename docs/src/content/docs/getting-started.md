---
title: Getting started
description: Install upload-safety and check your first upload.
---

## Install

```sh
npm install upload-safety
```

Node 22 or later. The package is ESM and has no runtime dependencies.

## Check an upload

`checkUpload` takes the file name and MIME type the client sent, plus the bytes, and runs every check:

```ts
import { checkUpload } from 'upload-safety';

const result = checkUpload(
	{ filename: 'cv.pdf', mimeType: 'application/pdf', bytes },
	{ maxBytes: 10 * 1024 * 1024 }
);

if ( result.ok ) {
	// result.bytes: the bytes to store (photos without their metadata)
	// result.filename: a safe file name
	// result.mimeType: the canonical MIME type for the extension
	// result.extension: the lower-case extension
} else {
	// result.reason: why the upload was refused
}
```

Store `result.bytes`, not the original bytes, and serve them with `result.mimeType`, not the type the client declared.

## Choose the accepted types

By default every format of `low` risk is accepted: documents, images, audio, video, CSV and text. RTF, Markdown and archives are opt-in, see [Choosing formats](/formats/risk/). Pass `allowedExtensions` to take fewer or more:

```ts
checkUpload( file, { maxBytes: 5 * 1024 * 1024, allowedExtensions: [ 'pdf', 'docx', 'jpg', 'jpeg', 'png' ] } );
```

## Tell users why

Each refusal is one of seven string literals, so a message table is checked by the compiler:

```ts
import type { UploadRejection } from 'upload-safety';

const MESSAGES: Record<UploadRejection, string> = {
	'empty': 'The file is empty.',
	'too-large': 'The file is too large.',
	'type-not-allowed': 'This file type is not allowed.',
	'mime-mismatch': 'The file type does not match its extension.',
	'content-mismatch': 'The file content does not match its extension.',
	'macros': 'Files with macros or other active content are not allowed.',
	'encrypted': 'Password-protected files cannot be checked.',
};
```

[Rejection reasons](/reference/rejections/) lists what triggers each one.

## Next

- Wire it into [a web `Request` handler](/guides/web-request/) or [Express](/guides/express/).
- Read [Serving uploads safely](/guides/serving-uploads/): the library checks bytes, your server decides how they come back out.
