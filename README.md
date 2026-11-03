# upload-safety

[![npm](https://img.shields.io/npm/v/upload-safety?color=cb3837)](https://www.npmjs.com/package/upload-safety)
[![CI](https://github.com/simulieren/upload-safety/actions/workflows/ci.yml/badge.svg)](https://github.com/simulieren/upload-safety/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/simulieren/upload-safety)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933)](package.json)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![types](https://img.shields.io/badge/types-TypeScript-3178c6)](src/index.ts)

Server-side upload checks for Node that read the file, not just its name. An upload passes only when its extension, its declared MIME type and its bytes agree, and when it carries nothing that runs on its own: no macros, embedded objects, DDE fields, PDF scripts or CSV formulas. Photos, including iPhone HEIC, lose their GPS position and other metadata on the way through.

For apps that take CVs, invoices, contracts and photos from strangers and hand them to colleagues who open them in Office or Acrobat.

```ts
const result = checkUpload( { filename, mimeType, bytes }, { maxBytes: 10 * 1024 * 1024 } );
if ( ! result.ok ) {
	// result.reason: 'macros', 'encrypted', 'content-mismatch', ...
}
```

## What it catches

| Upload | Result |
| - | - |
| `cv.pdf` that is a Windows executable | refused, `content-mismatch` |
| `report.docx` with a VBA project, also renamed or hidden behind a content type | refused, `macros` |
| `invoice.docx` with an embedded OLE package that runs a file on double click | refused, `macros` |
| `letter.docx` with a `DDEAUTO` field, also split across runs or spelled with `QUOTE` | refused, `macros` |
| `template.docx` that loads a remote `.dotm` on opening | refused, `macros` |
| `form.pdf` with JavaScript, a launch action or an attachment, also in compressed object streams | refused, `macros` |
| `budget.xls` with a very hidden Excel 4.0 macro sheet | refused, `macros` |
| `notes.odt` with a Basic macro or an event listener | refused, `macros` |
| `export.csv` with `=HYPERLINK(...)` or `=cmd\|' /C calc'!A0` in a cell | refused, `macros` |
| `contract.docx` saved with a password | refused, `encrypted` |
| `data.xlsx` that is a zip bomb | refused, `content-mismatch` |
| `holiday.jpg` with GPS coordinates | accepted, EXIF, XMP, IPTC and comments removed, orientation kept |
| `IMG_0042.heic` from an iPhone | accepted, EXIF and XMP overwritten in place, pixels unchanged |
| `../../CON.pdf`, a plain PDF | accepted, stored as `_CON.pdf` |

Every check fails closed: a part it cannot read is a refusal, not a pass.

## Why

- **Zero runtime dependencies.** Only `node:zlib` and `node:crypto`. Nothing to audit but this package.
- **Typed reasons.** Each refusal is one of seven string literals, so a `Record<UploadRejection, string>` of messages is checked by the compiler.
- **Fast enough to run inline.** Synchronous; 647 real documents up to 20 MB each took at most 65 ms on a laptop.
- **Tested against crafted files.** 235 tests build malformed ZIPs, compound files and PDFs byte by byte, next to real Office and PDF files.

## Install

```sh
npm install upload-safety
```

Node 22 or later, ESM.

## Usage

### Web `Request` (Next.js route handlers, Hono, Remix, Bun)

```ts
import { checkUpload, type UploadRejection } from 'upload-safety';

export async function POST( request: Request ) {
	const file = ( await request.formData() ).get( 'file' );
	if ( ! ( file instanceof File ) ) {
		return Response.json( { error: 'No file.' }, { status: 400 } );
	}

	const result = checkUpload(
		{ filename: file.name, mimeType: file.type, bytes: new Uint8Array( await file.arrayBuffer() ) },
		{ maxBytes: 10 * 1024 * 1024, allowedExtensions: [ 'pdf', 'docx', 'jpg', 'jpeg', 'png' ] }
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

### Express with multer

```ts
import express from 'express';
import multer from 'multer';
import { checkUpload } from 'upload-safety';

const MAX_BYTES = 10 * 1024 * 1024;
// Memory storage hands over the bytes; the limit stops a large body before it is buffered.
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

### In the browser

`acceptAttribute()` gives the matching value for the file picker. It only filters the dialog; the server check is what counts.

```tsx
<input type="file" accept={ acceptAttribute( [ 'pdf', 'docx' ] ) } />
```

## Formats

| Format | Extensions | Checked beyond the magic number |
| - | - | - |
| PDF | `pdf` | JavaScript, launch, form submit and import actions, links to other files (`GoToR`, `GoToE`), multimedia, XFA forms and embedded files, also inside compressed object streams; encryption |
| Office (OOXML) | `docx` `xlsx` `pptx` | Required parts; VBA and ActiveX parts; macro content types and relationships; embedded and linked OLE objects; altChunk imports; subdocuments, frames and remote templates; DDE fields in Word and DDE links in Excel; encryption |
| Office (legacy) | `doc` `xls` `ppt` | OLE directory; VBA storages; embedded OLE objects; Excel 4.0 macro sheets; DDE and OLE links in Excel; PowerPoint VBA and object records; encryption flags |
| OpenDocument | `odt` `ods` `odp` | The `mimetype` entry; Basic and script modules; embedded OLE objects; event listeners; links to macros; encrypted manifests |
| Photos | `jpg` `jpeg` `png` `webp` | Structure; EXIF (GPS included), XMP, IPTC, comments and any other metadata segment or chunk are removed, the orientation is kept |
| HEIF photos | `heic` `heif` `avif` | Brands; EXIF and XMP items are overwritten in place, since dropping them would shift the offsets the file is built on. The orientation lives in the image properties and stays. Image sequences, such as animated AVIF, are refused |
| Text | `csv` `txt` | No binary data (UTF-8, UTF-16 with a byte order mark, or a Windows code page); in CSV no cell that starts like a formula (`=`, `+`, `-`, `@`) and calls a function or DDE. Numbers such as `-5` or `+49 (30) 1234` pass |

ZIP and OLE reading is capped against zip bombs and malformed sector chains. Every format is in the default list; pass `allowedExtensions` to accept fewer. A PDF that asks for a password is refused. One that only restricts permissions opens without a password and passes, unless its object streams are encrypted, since then they cannot be checked.

## API

`checkUpload` validates the descriptor, inspects the bytes, strips photo metadata and returns the sanitized file name and the canonical MIME type. The parts are exported on their own too:

| Export | Does |
| - | - |
| `checkUpload( { filename, mimeType, bytes }, options )` | Every check below; `{ ok: true, extension, filename, mimeType, bytes }` or `{ ok: false, reason }` |
| `validateUploadDescriptor( { filename, mimeType, size }, options )` | Size, extension and MIME checks before reading the body |
| `inspectFileContent( extension, bytes )` | `'valid' \| 'macros' \| 'encrypted' \| 'mismatch'` |
| `stripPhotoMetadata( extension, bytes )` | Cleaned bytes, the input for non-photos, `null` for a broken photo |
| `sanitizeFilename( name )` | Drops path parts, unsafe characters and trailing dots, renames Windows device names such as `CON`, caps the length at 200 UTF-8 bytes |
| `getCanonicalMimeType( extension )` | The MIME type to store |
| `acceptAttribute( extensions? )` | Value for `<input type="file" accept>` |
| `isEncryptedPdf( buffer )` | PDF encryption check alone |

`options` takes `maxBytes` and, to narrow the built-in list, `allowedExtensions`. The reason `macros` covers all active content: VBA and Excel 4.0 macros, embedded OLE objects, DDE, event listeners and PDF scripts and attachments.

## Limits

These checks are not an antivirus scan. They refuse active content and anything they cannot read. They do not judge whether the data in an otherwise plain file is malicious, and they do not look inside a document embedded in another one, such as the workbook behind a Word chart. DDE is not looked for in legacy `.doc` files, nor in an `.xlsx` cell formula that names a DDE source without an external link part.

The ZIP limits (`MAX_ZIP_UNCOMPRESSED_BYTES`, `MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES`) are set to 100 MB. If a virus scanner runs after these checks, keep them at or below its own limits: ClamAV, for one, reports content past `MaxScanSize` and `MaxFileSize` as clean.

## Before and after the checks

The library checks the bytes it is handed. The rest of the upload path is up to you:

- **Limit the request body before reading it.** `maxBytes` is checked after the whole file is in memory, so cap the body in your server or proxy first.
- **Serve stored files as downloads.** Send `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, and use the canonical `result.mimeType`, not the one the client declared. Serving uploads from a separate origin keeps a file that slips through away from your cookies.
- **Limit image dimensions before resizing.** A small JPEG or PNG can declare a huge size. These checks do not decode images, so cap width and height in whatever makes thumbnails (sharp's `limitInputPixels`, ImageMagick's `policy.xml`).
- **Expect metadata in documents.** Only JPEG and PNG uploads are stripped. Author names in Office and PDF files, and EXIF in images inside documents, are kept.
- **Run a virus scanner if you need one.** These checks refuse active content; they do not recognise malware in data.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build   # dist/ with .d.ts
```

Found a way past a check? Please report it privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
