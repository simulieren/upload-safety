---
title: Web Request handlers
description: Use upload-safety in Next.js route handlers, Hono, Remix, Bun or any server that hands you a standard Request.
---

Any framework that gives you a standard `Request` can read the upload with `formData()`:

```ts
import { checkUpload, type UploadRejection } from 'upload-safety';

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST( request: Request ) {
	const file = ( await request.formData() ).get( 'file' );
	if ( ! ( file instanceof File ) ) {
		return Response.json( { error: 'No file.' }, { status: 400 } );
	}

	const result = checkUpload(
		{ filename: file.name, mimeType: file.type, bytes: new Uint8Array( await file.arrayBuffer() ) },
		{ maxBytes: MAX_BYTES, allowedExtensions: [ 'pdf', 'docx', 'jpg', 'jpeg', 'png' ] }
	);
	if ( ! result.ok ) {
		return Response.json( { error: MESSAGES[ result.reason ] }, { status: 422 } );
	}

	// Store result.bytes under result.filename with result.mimeType.
	return Response.json( { name: result.filename } );
}

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

:::caution[Cap the body first]
`formData()` reads the whole body into memory before `checkUpload` sees `maxBytes`. Limit the request size in the framework or the proxy in front of it (for example `bodySizeLimit` in Next.js server actions, `client_max_body_size` in nginx).
:::

## Check before reading the body

When the client sends the size up front, for example to get a presigned upload URL, `validateUploadDescriptor` runs the size, extension and MIME checks without the bytes:

```ts
import { validateUploadDescriptor } from 'upload-safety';

const descriptor = validateUploadDescriptor( { filename, mimeType, size }, { maxBytes: MAX_BYTES } );
if ( ! descriptor.ok ) {
	return Response.json( { error: descriptor.reason }, { status: 422 } );
}
```

This does not replace `checkUpload` once the bytes arrive. A client can declare anything.
