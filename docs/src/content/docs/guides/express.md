---
title: Validate file uploads in Express with multer
sidebar:
  label: Express with multer
description: Check uploads in an Express route with multer's memory storage.
---

multer's memory storage hands over the bytes as a `Buffer`, which `checkUpload` takes directly:

```ts
import express from 'express';
import multer from 'multer';
import { checkUpload } from 'upload-safety';

const MAX_BYTES = 10 * 1024 * 1024;
// The limit stops a large body before it is buffered.
const upload = multer( { storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } } );
const app = express();

app.post( '/upload', upload.single( 'file' ), ( req, res ) => {
	if ( ! req.file ) {
		return res.status( 400 ).json( { error: 'No file.' } );
	}
	const result = checkUpload(
		{ filename: req.file.originalname, mimeType: req.file.mimetype, bytes: req.file.buffer },
		{ maxBytes: MAX_BYTES }
	);
	if ( ! result.ok ) {
		return res.status( 422 ).json( { error: result.reason } );
	}
	// Store result.bytes under result.filename with result.mimeType.
	res.json( { name: result.filename } );
} );
```

Set `limits.fileSize` to the same value as `maxBytes`. multer then stops reading a larger file instead of buffering it.

## Disk storage

With `multer.diskStorage()` the file is already on disk under a name multer chose. Read it back with `fs.readFile`, run `checkUpload`, and delete the temporary file when the check fails. Memory storage is simpler when files are a few megabytes.
