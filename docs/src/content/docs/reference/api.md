---
title: API
description: Every export of upload-safety with its signature and return value.
---

```ts
import { checkUpload } from 'upload-safety';
```

## checkUpload

```ts
function checkUpload( input: UploadInput, options: UploadOptions ): UploadCheck;

interface UploadInput {
	filename: string;
	mimeType: string; // what the client declared; '' when it sent none
	bytes: Uint8Array; // a Node Buffer works too
}

interface UploadOptions {
	maxBytes: number;
	allowedExtensions?: readonly AllowedExtension[]; // defaults to ALLOWED_EXTENSIONS, the low-risk formats
}

type UploadCheck =
	| { ok: true; extension: AllowedExtension; filename: string; mimeType: string; bytes: Uint8Array }
	| { ok: false; reason: UploadRejection };
```

Runs every check in order: descriptor (size, extension, MIME type), content, then photo metadata. On success, `filename` is sanitized, `mimeType` is the canonical type for the extension, and `bytes` are the bytes to store.

It is synchronous. 647 real documents up to 20 MB each took at most 65 ms on a laptop.

## validateUploadDescriptor

```ts
function validateUploadDescriptor(
	descriptor: { filename: string; mimeType: string; size: number },
	options: UploadOptions
):
	| { ok: true; extension: AllowedExtension; sanitizedFilename: string }
	| { ok: false; reason: 'empty' | 'too-large' | 'type-not-allowed' | 'mime-mismatch' };
```

The checks that need no bytes. Use it to refuse an upload before reading the body.

## inspectFileContent

```ts
function inspectFileContent(
	extension: AllowedExtension,
	bytes: Uint8Array,
	allowedExtensions?: readonly AllowedExtension[] // for files inside an archive; defaults to ALLOWED_EXTENSIONS
): 'valid' | 'macros' | 'encrypted' | 'mismatch';
```

The content checks alone. `checkUpload` maps `mismatch` to `content-mismatch`. For images, audio and video it checks the signature; their full structure is read by `stripPhotoMetadata`.

## stripPhotoMetadata

```ts
function stripPhotoMetadata( extension: AllowedExtension, bytes: Uint8Array ): Uint8Array | null;
```

Cleaned bytes for an image, audio or video file, the input unchanged for any other type, `null` for a media file it cannot read. See [Photos and images](/formats/photos/) and [Audio and video](/formats/audio-and-video/).

## sanitizeFilename

```ts
function sanitizeFilename( name: string ): string;
```

Drops path parts, unsafe characters and trailing dots, renames Windows device names such as `CON` (to `_CON`), and caps the length at 200 UTF-8 bytes while keeping the extension.

## getCanonicalMimeType

```ts
function getCanonicalMimeType( extension: AllowedExtension ): string;
```

The MIME type to store and serve for an extension, such as `image/jpeg` for `jpg`.

## acceptAttribute

```ts
function acceptAttribute( extensions?: readonly AllowedExtension[] ): string;
```

A value for `<input type="file" accept>`. See [File picker](/guides/file-picker/).

## isEncryptedPdf

```ts
function isEncryptedPdf( buffer: Buffer ): boolean;
```

Whether a PDF needs a password to open.

## Types and constants

| Export | Value |
| - | - |
| `AllowedExtension` | Every supported extension: the documents, `jpg` `jpeg` `png` `webp` `heic` `heif` `avif` `gif` `bmp` `ico`, `mp3` `wav` `flac` `ogg` `m4a` `mp4` `mov` `webm`, `csv` `txt` `md` `rtf`, `zip` `tar` `gz` `tgz` `rar` `7z` |
| `ALLOWED_EXTENSIONS` | The default list: every extension of `low` risk |
| `FORMAT_RISK` | `Record<AllowedExtension, 'low' \| 'elevated' \| 'unchecked'>`, see [Choosing formats](/formats/risk/) |
| `FormatRisk` | `'low' \| 'elevated' \| 'unchecked'` |
| `UploadRejection` | See [Rejection reasons](/reference/rejections/) |
| `MAX_ZIP_ENTRIES` | 2,000 |
| `MAX_ZIP_UNCOMPRESSED_BYTES` | 100 MB |
| `MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES` | 100 MB |
| `MAX_OLE_STREAM_BYTES` | 64 MB |
