# upload-safety

Server-side checks for user uploads in Node 22+. No runtime dependencies.

It accepts PDF, Word, Excel and PowerPoint (OOXML and the legacy binary formats), OpenDocument, JPEG and PNG. A file passes only when its extension, its declared MIME type and its bytes agree. The bytes are checked deeper than the magic number:

- OOXML: required parts, VBA and ActiveX parts, macro content types and relationships, embedded and linked OLE objects, altChunk imports, subdocuments, frames, remote templates, DDE fields in Word and DDE links in Excel.
- Legacy Office: OLE directory, VBA storages, embedded OLE objects, Excel 4.0 macro sheets, DDE and OLE links in Excel, PowerPoint VBA and object records, encryption flags.
- OpenDocument: the `mimetype` entry, Basic and script modules, embedded OLE objects, event listeners, links to macros, encrypted manifests.
- PDF: JavaScript, launch, form submit and import actions, links to other files (`GoToR`, `GoToE`), multimedia, XFA forms and embedded files, also inside compressed object streams. A PDF that asks for a password is refused. One that only restricts permissions opens without a password and passes, unless its object streams are encrypted, since then they cannot be checked.
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
	'macros': 'Files with macros or other active content are not allowed.',
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

`macros` covers all active content: VBA and Excel 4.0 macros, embedded OLE objects, DDE, event listeners and PDF scripts and attachments.

These checks are not an antivirus scan. They reject active content and anything they cannot read. They do not judge whether the data in an otherwise plain file is malicious, and they do not look inside a document embedded in another one, such as the workbook behind a Word chart. DDE is not looked for in legacy `.doc` files, nor in an `.xlsx` cell formula that names a DDE source without an external link part.

The ZIP limits (`MAX_ZIP_UNCOMPRESSED_BYTES`, `MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES`) are set to 100 MB. If a virus scanner runs after these checks, keep them at or below its own limits: ClamAV, for one, reports content past `MaxScanSize` and `MaxFileSize` as clean.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build   # dist/ with .d.ts; also runs on install from git
```
