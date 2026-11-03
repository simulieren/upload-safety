# upload-safety

Server-side checks for user uploads in Node 22+. No runtime dependencies.

It accepts PDF, Word, Excel and PowerPoint (OOXML and the legacy binary formats), OpenDocument, JPEG and PNG. A file passes only when its extension, its declared MIME type and its bytes agree. The bytes are checked deeper than the magic number:

- OOXML: required parts, VBA and ActiveX parts, macro content types and relationships, external OLE objects, subdocuments, frames and remote templates.
- Legacy Office: OLE directory, VBA storages, Excel 4.0 macro sheets, PowerPoint VBA records, encryption flags.
- OpenDocument: the `mimetype` entry, Basic and script modules, encrypted manifests.
- PDF: any encryption, including permission-only.
- ZIP and OLE reading is capped against zip bombs and malformed sector chains.
- JPEG and PNG: EXIF (GPS included), XMP, IPTC and comments are removed. The orientation is kept.

## Usage

```ts
import { checkUpload, type UploadRejection } from 'upload-safety';

const result = checkUpload(
	{ filename: file.name, mimeType: file.type, bytes: new Uint8Array( await file.arrayBuffer() ) },
	{ maxBytes: 10 * 1024 * 1024, allowedExtensions: [ 'pdf', 'docx', 'jpg', 'jpeg', 'png' ] }
);

if ( ! result.ok ) {
	return Response.json( { error: MESSAGES[ result.reason ] }, { status: 422 } );
}
// Store result.bytes under result.filename with result.mimeType.

const MESSAGES: Record<UploadRejection, string> = {
	'empty': 'The file is empty.',
	'too-large': 'The file is too large.',
	'type-not-allowed': 'This file type is not allowed.',
	'mime-mismatch': 'The file type does not match its extension.',
	'content-mismatch': 'The file content does not match its extension.',
	'macros': 'Files with macros are not allowed.',
	'encrypted': 'Password-protected files cannot be checked.',
};
```

`checkUpload` validates the descriptor, inspects the bytes, strips photo metadata and returns the sanitized file name and the canonical MIME type. The parts are exported on their own too:

| Export | Does |
| - | - |
| `validateUploadDescriptor( { filename, mimeType, size }, options )` | Size, extension and MIME checks before reading the body |
| `inspectFileContent( extension, bytes )` | `'valid' \| 'macros' \| 'encrypted' \| 'mismatch'` |
| `stripPhotoMetadata( extension, bytes )` | Cleaned bytes, the input for non-photos, `null` for a broken photo |
| `sanitizeFilename( name )` | Drops path parts and unsafe characters, caps the length at 200 |
| `getCanonicalMimeType( extension )` | The MIME type to store |
| `acceptAttribute( extensions? )` | Value for `<input type="file" accept>` |
| `isEncryptedPdf( buffer )` | PDF encryption check alone |

These checks are not an antivirus scan. They reject active content and anything they cannot read. They do not judge whether the data in an otherwise plain file is malicious.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build   # dist/ with .d.ts; also runs on install from git
```
