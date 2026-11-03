import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
	getCanonicalMimeType,
	getExtension,
	inspectFileContent,
	sanitizeFilename,
	validateUploadDescriptor,
} from './upload-allowlist.js';
import {
	buildOle, buildPowerPoint, buildWorkbook, oleSectorOffset, SHEET_TYPE, supBook
} from './ole-fixture.js';
import { MAX_ZIP_ENTRIES, readZipEntries } from './zip-entries.js';
import { buildZip, type ZipFixtureEntry } from './zip-fixture.js';

const MAX = 10 * 1024 * 1024;

describe( 'validateUploadDescriptor', () => {
	it( 'accepts allowed office formats, LibreOffice files and photos', () => {
		for ( const filename of [
			'cv.pdf', 'brief.docx', 'tabelle.xlsx', 'folien.pptx', 'alt.doc', 'brief.odt', 'tabelle.ods', 'folien.odp', 'zeugnis.jpg', 'zeugnis.JPEG', 'screenshot.png',
		] ) {
			expect( validateUploadDescriptor( { filename, mimeType: '', size: 1000 }, { maxBytes: MAX } ).ok ).toBe( true );
		}
	} );

	it( 'tolerates a generic octet-stream MIME', () => {
		const result = validateUploadDescriptor(
			{ filename: 'cv.docx', mimeType: 'application/octet-stream', size: 1000 },
			{ maxBytes: MAX }
		);
		expect( result ).toMatchObject( { ok: true, extension: 'docx' } );
	} );

	it( 'rejects disallowed extensions', () => {
		for ( const filename of [ 'malware.exe', 'archive.zip', 'grafik.svg', 'backup.rar', 'notes.rtf', 'readme.md', 'noext' ] ) {
			expect( validateUploadDescriptor( { filename, mimeType: '', size: 1000 }, { maxBytes: MAX } ).ok ).toBe( false );
		}
	} );

	it( 'rejects oversized and empty files', () => {
		expect( validateUploadDescriptor( { filename: 'cv.pdf', mimeType: '', size: MAX + 1 }, { maxBytes: MAX } ).ok ).toBe( false );
		expect( validateUploadDescriptor( { filename: 'cv.pdf', mimeType: '', size: 0 }, { maxBytes: MAX } ).ok ).toBe( false );
	} );

	it( 'rejects a MIME that contradicts the extension', () => {
		const result = validateUploadDescriptor(
			{ filename: 'cv.pdf', mimeType: 'application/vnd.ms-excel', size: 1000 },
			{ maxBytes: MAX }
		);
		expect( result ).toEqual( { ok: false, reason: 'mime-mismatch' } );
	} );

	it( 'sanitizes the returned filename', () => {
		const result = validateUploadDescriptor(
			{ filename: '../../etc/Lebenslauf Müller.pdf', mimeType: '', size: 1000 },
			{ maxBytes: MAX }
		);
		expect( result ).toMatchObject( { ok: true, sanitizedFilename: 'Lebenslauf Müller.pdf' } );
	} );

	it( 'names the reason a descriptor fails', () => {
		const check = ( filename: string, size: number ) => validateUploadDescriptor( { filename, mimeType: '', size }, { maxBytes: MAX } );
		expect( check( 'cv.pdf', 0 ) ).toEqual( { ok: false, reason: 'empty' } );
		expect( check( 'cv.pdf', MAX + 1 ) ).toEqual( { ok: false, reason: 'too-large' } );
		expect( check( 'malware.exe', 1000 ) ).toEqual( { ok: false, reason: 'type-not-allowed' } );
	} );

	it( 'accepts only the extensions a caller allows', () => {
		const options = { maxBytes: MAX, allowedExtensions: [ 'pdf' ] as const };
		expect( validateUploadDescriptor( { filename: 'cv.pdf', mimeType: '', size: 1000 }, options ).ok ).toBe( true );
		expect( validateUploadDescriptor( { filename: 'cv.docx', mimeType: '', size: 1000 }, options ) ).toEqual( { ok: false, reason: 'type-not-allowed' } );
	} );
} );

describe( 'sanitizeFilename', () => {
	it( 'strips directory traversal and keeps umlauts', () => {
		expect( sanitizeFilename( '../../../passwd' ) ).toBe( 'passwd' );
		expect( sanitizeFilename( 'C:\\Users\\me\\Zeugnis Übung.docx' ) ).toBe( 'Zeugnis Übung.docx' );
	} );

	// macOS often hands over decomposed names, where "ü" is "u" plus a combining diaeresis.
	it( 'keeps umlauts of a decomposed name', () => {
		expect( sanitizeFilename( 'Lebenslauf Müller.pdf'.normalize( 'NFD' ) ) ).toBe( 'Lebenslauf Müller.pdf' );
	} );

	it( 'keeps accents that have no precomposed letter', () => {
		expect( sanitizeFilename( 'Bewerbung Nguyễn q\u0308.pdf'.normalize( 'NFD' ) ) ).toBe( 'Bewerbung Nguyễn q\u0308.pdf' );
	} );

	it( 'keeps the extension when it shortens a long name', () => {
		const shortened = sanitizeFilename( `${ 'a'.repeat( 250 ) }.pdf` );

		expect( shortened ).toHaveLength( 200 );
		expect( shortened.endsWith( '.pdf' ) ).toBe( true );
	} );

	it( 'keeps the extension as written when it shortens a long name', () => {
		expect( sanitizeFilename( `${ 'a'.repeat( 250 ) }.PDF` ).endsWith( '.PDF' ) ).toBe( true );
	} );

	it( 'never returns a name longer than the limit, even for an endless extension', () => {
		expect( sanitizeFilename( `a.${ 'b'.repeat( 250 ) }` ).length ).toBeLessThanOrEqual( 200 );
	} );

	it( 'counts the limit in UTF-8 bytes and cuts between whole characters', () => {
		for ( const character of [ '文', '𝐀', 'é', 'e\u0301', 'क्ष' ] ) {
			const shortened = sanitizeFilename( `${ character.repeat( 150 ) }.docx` );
			expect( Buffer.byteLength( shortened ), character ).toBeLessThanOrEqual( 200 );
			expect( shortened.endsWith( '.docx' ) ).toBe( true );
			expect( shortened.slice( 0, -5 ).replaceAll( character.normalize( 'NFC' ), '' ), character ).toBe( '' );
		}
	} );

	it( 'keeps a Windows device name from naming the file', () => {
		for ( const name of [ 'CON.pdf', 'con.tar.pdf', 'Nul .pdf', 'COM1.pdf', 'lpt9.docx', 'COM¹.pdf', 'AUX' ] ) {
			expect( sanitizeFilename( name ), name ).toMatch( /^_/ );
		}
		for ( const name of [ 'CONTRACT.pdf', 'console.pdf', 'COM10.pdf', 'my CON.pdf' ] ) {
			expect( sanitizeFilename( name ), name ).toBe( name );
		}
	} );

	it( 'drops trailing dots and spaces, which Windows would drop on saving', () => {
		expect( sanitizeFilename( 'report.pdf. . .' ) ).toBe( 'report.pdf' );
		expect( sanitizeFilename( `${ 'a'.repeat( 197 ) }. b` ) ).not.toMatch( /[. ]$/ );
	} );

	it( 'never returns an empty string', () => {
		expect( sanitizeFilename( '///' ) ).toBe( 'file' );
	} );

	// macOS and Linux hide a downloaded file whose name starts with a dot.
	it( 'never returns a name that a download would save as a hidden file', () => {
		expect( sanitizeFilename( '.pdf' ) ).toBe( 'file.pdf' );
		expect( sanitizeFilename( 'exploit.php/.jpg' ) ).toBe( 'file.jpg' );
		expect( sanitizeFilename( '<>.png' ) ).toBe( 'file.png' );
		expect( sanitizeFilename( ' .hidden.pdf' ) ).not.toMatch( /^\./ );
		expect( sanitizeFilename( `.${ 'a'.repeat( 250 ) }.pdf` ) ).not.toMatch( /^\./ );
	} );
} );

describe( 'getExtension', () => {
	it( 'returns the lowercased extension', () => {
		expect( getExtension( 'Report.PDF' ) ).toBe( 'pdf' );
		expect( getExtension( 'no-extension' ) ).toBe( '' );
		expect( getExtension( 'trailing.' ) ).toBe( '' );
	} );
} );

/** Bytes of a fake file: a signature followed by content. */
function fakeFile( signature: number[], ...content: string[] ): Uint8Array {
	const body = new TextEncoder().encode( content.join( '\0' ) );
	return new Uint8Array( [ ...signature, 0, 0, 0, 0, ...body ] );
}

const DOCX = { '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' };
const XLSX = { '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' };
const PPTX = { '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<p:presentation/>' };

/** An OpenDocument file: `mimetype` first and stored, then the content. */
function openDocument( mimeType: string, files: Record<string, string | ZipFixtureEntry> = {} ): Uint8Array {
	return buildZip( { mimetype: mimeType, 'content.xml': '<office:document-content/>', ...files } );
}

const DOC = { WordDocument: Buffer.alloc( 5000, 1 ), '1Table': 'table' };
const XLS = { Workbook: Buffer.alloc( 600, 1 ) };
const PPT = buildPowerPoint( { hasMacros: 0 } );

describe( 'inspectFileContent', () => {
	it( 'accepts files whose structure matches the extension', () => {
		expect( inspectFileContent( 'pdf', fakeFile( [ 0x25, 0x50, 0x44, 0x46 ], '-1.7' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'docx', buildZip( DOCX ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'xlsx', buildZip( XLSX ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'pptx', buildZip( PPTX ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'doc', buildOle( DOC ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'xls', buildOle( XLS ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'xls', buildOle( { Book: 'BIFF5' } ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'ppt', buildOle( PPT ) ) ).toBe( 'valid' );
	} );

	it( 'accepts LibreOffice files and photos whose content matches the extension', () => {
		expect( inspectFileContent( 'odt', openDocument( 'application/vnd.oasis.opendocument.text' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'ods', openDocument( 'application/vnd.oasis.opendocument.spreadsheet' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'odp', openDocument( 'application/vnd.oasis.opendocument.presentation' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'jpg', fakeFile( [ 0xff, 0xd8, 0xff, 0xe0 ] ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'jpeg', fakeFile( [ 0xff, 0xd8, 0xff, 0xe1 ] ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'png', fakeFile( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] ) ) ).toBe( 'valid' );
	} );

	it( 'rejects a Word or other LibreOffice file renamed to a LibreOffice extension', () => {
		expect( inspectFileContent( 'odt', buildZip( DOCX ) ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'odt', openDocument( 'application/vnd.oasis.opendocument.spreadsheet' ) ) ).not.toBe( 'valid' );
		// A text template shares the prefix of the text type.
		expect( inspectFileContent( 'odt', openDocument( 'application/vnd.oasis.opendocument.text-template' ) ) ).not.toBe( 'valid' );
	} );

	it( 'rejects a ZIP archive that only mentions the OpenDocument type somewhere', () => {
		expect( inspectFileContent( 'odt', buildZip( { 'notes.txt': 'mimetypeapplication/vnd.oasis.opendocument.text content.xml' } ) ) ).not.toBe( 'valid' );
	} );

	it( 'rejects a photo whose bytes are of another image format', () => {
		expect( inspectFileContent( 'jpg', fakeFile( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] ) ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'png', fakeFile( [ 0xff, 0xd8, 0xff, 0xe0 ] ) ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'png', fakeFile( [ 0x3c, 0x73, 0x76, 0x67 ], 'svg' ) ) ).not.toBe( 'valid' );
	} );

	it( 'rejects an arbitrary ZIP archive named like an Office document', () => {
		expect( inspectFileContent( 'docx', buildZip( { 'photo.jpg': '', 'notes.txt': '' } ) ) ).not.toBe( 'valid' );
		// A spreadsheet renamed to .docx is still not a Word document.
		expect( inspectFileContent( 'docx', buildZip( XLSX ) ) ).not.toBe( 'valid' );
	} );

	it( 'does not take a Word file whose text mentions a book for a spreadsheet', () => {
		const text = Buffer.from( 'Book\0Workbook\0', 'utf16le' );
		expect( inspectFileContent( 'xls', buildOle( { WordDocument: Buffer.concat( [ text, Buffer.alloc( 5000 ) ] ) } ) ) ).toBe( 'mismatch' );
	} );

	it( 'rejects a legacy Office file of another program', () => {
		expect( inspectFileContent( 'doc', buildOle( XLS ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'ppt', buildOle( DOC ) ) ).toBe( 'mismatch' );
		// The stream must sit right below the root, not in a storage.
		expect( inspectFileContent( 'xls', buildOle( { 'Data/Workbook': 'BIFF8' } ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'xls', fakeFile( [ 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1 ], 'Workbook' ) ) ).toBe( 'mismatch' );
	} );

	it( 'rejects OOXML files that contain VBA macros', () => {
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, 'word/vbaProject.bin': '' } ) ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'xlsx', buildZip( { ...XLSX, 'xl/vbaProject.bin': '' } ) ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'pptx', buildZip( { ...PPTX, 'ppt/vbaProject.bin': '' } ) ) ).not.toBe( 'valid' );
	} );

	it( 'rejects legacy Office files that contain VBA macros', () => {
		expect( inspectFileContent( 'doc', buildOle( { ...DOC, 'Macros/VBA/dir': 'x' } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'doc', buildOle( { ...DOC, _VBA_PROJECT: 'x' } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xls', buildOle( { ...XLS, '_VBA_PROJECT_CUR/VBA/dir': 'x' } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xls', buildOle( { ...XLS, '_vba_project_cur/PROJECT': 'x' } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'ppt', buildOle( { ...PPT, Macros: 'x' } ) ) ).toBe( 'macros' );
	} );

	it( 'rejects Excel 4.0 macro sheets and VBA modules, which live in the Workbook stream', () => {
		const workbook = ( ...sheets: Parameters<typeof buildWorkbook>[ 0 ] ) => buildOle( { Workbook: buildWorkbook( sheets ) } );
		const worksheet = { type: SHEET_TYPE.worksheet };

		expect( inspectFileContent( 'xls', workbook( worksheet, { type: SHEET_TYPE.macro } ) ) ).toBe( 'macros' );
		// Droppers hide the macro sheet so that only the worksheet shows.
		expect( inspectFileContent( 'xls', workbook( worksheet, { type: SHEET_TYPE.macro, state: 2 } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xls', workbook( worksheet, { type: SHEET_TYPE.module } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xls', workbook( worksheet, { type: SHEET_TYPE.chart } ) ) ).toBe( 'valid' );
	} );

	it( 'rejects DDE and OLE links in a legacy workbook, but not references to itself, add-ins or other workbooks', () => {
		const workbook = ( ...records: Buffer[] ) => buildOle( { Workbook: buildWorkbook( [ { type: SHEET_TYPE.worksheet } ], records ) } );
		const dde = 'cmd\u0003/c calc';

		expect( inspectFileContent( 'xls', workbook( supBook( 0, dde.length, dde ) ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xls', workbook( supBook( 1, 0x0401 ), supBook( 0, dde.length, dde ) ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xls', workbook( supBook( 1, 0x0401 ), supBook( 0, 0x3a01 ) ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'xls', workbook( supBook( 2, 'Book2.xls'.length, 'Book2.xls' ) ) ) ).toBe( 'valid' );
	} );

	it( 'rejects Excel 4.0 macro sheets in OOXML by content type or relationship', () => {
		const byContentType = ( contentType: string ) => buildZip( {
			...XLSX,
			'[Content_Types].xml': `<Types><Override PartName="/xl/macrosheets/sheet1.xml" ContentType="${ contentType }"/></Types>`,
			'xl/macrosheets/sheet1.xml': '<xm:macrosheet/>',
		} );
		const byRelationship = ( type: string ) => buildZip( {
			...XLSX,
			'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/${ type }" Target="sheets/code.xml"/></Relationships>`,
			'xl/sheets/code.xml': '<xm:macrosheet/>',
		} );

		expect( inspectFileContent( 'xlsx', byContentType( 'application/vnd.ms-excel.macrosheet+xml' ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xlsx', byContentType( 'application/vnd.ms-excel.intlmacrosheet+xml' ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xlsx', byRelationship( 'xlMacrosheet' ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xlsx', byRelationship( 'xlIntlMacrosheet' ) ) ).toBe( 'macros' );
	} );

	it( 'rejects a PowerPoint file whose document stream holds a VBA project', () => {
		expect( inspectFileContent( 'ppt', buildOle( buildPowerPoint( { hasMacros: 1 } ) ) ) ).toBe( 'macros' );
		// Every file has the atom; only its flag tells a project apart.
		expect( inspectFileContent( 'ppt', buildOle( buildPowerPoint() ) ) ).toBe( 'valid' );
		// Bytes outside the records the persist directory points at are not read.
		expect( inspectFileContent( 'ppt', buildOle( buildPowerPoint( { hasMacros: 1, prefix: Buffer.alloc( 64, 0xff ) } ) ) ) ).toBe( 'macros' );
	} );

	// Whether PowerPoint loads a referenced project despite a cleared flag is unknown, so the reference alone counts.
	it( 'rejects a PowerPoint file that references a VBA project with its flag cleared', () => {
		expect( inspectFileContent( 'ppt', buildOle( buildPowerPoint( { hasMacros: 0, vbaProjectRef: 2 } ) ) ) ).toBe( 'macros' );
	} );

	// Sources: SimpleMacro.ppt from Apache POI test-data (Apache-2.0),
	// sample_with_vba.ppt from oletools test-data, decalage2/oletools (BSD-2-Clause).
	it.each( [ 'SimpleMacro.ppt', 'sample_with_vba.ppt' ] )( 'rejects %s, whose VBA project has no storage of its own', ( name ) => {
		expect( inspectFileContent( 'ppt', readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) ) ) ).toBe( 'macros' );
	} );

	it( 'refuses a PowerPoint file it cannot read', () => {
		const document = buildPowerPoint( { hasMacros: 0 } )[ 'PowerPoint Document' ];
		const documentLength = document.readUInt32LE( 4 );

		expect( inspectFileContent( 'ppt', buildOle( buildPowerPoint( { hasMacros: 0, documentLength: documentLength - 4 } ) ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'ppt', buildOle( buildPowerPoint( { hasMacros: 0, documentLength: 0xffffff } ) ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'ppt', buildOle( { 'PowerPoint Document': PPT[ 'PowerPoint Document' ] } ) ) ).toBe( 'mismatch' );
	} );

	it( 'refuses legacy Office files encrypted with a password', () => {
		const bof = buildWorkbook( [] ).subarray( 0, 20 );
		const filePass = Buffer.from( [ 0x2f, 0x00, 0x06, 0x00, 0x00, 0x00, 0x34, 0x12, 0x78, 0x56 ] );
		const word = ( flags: number ) => {
			const stream = Buffer.alloc( 5000 );
			stream.writeUInt16LE( 0xa5ec, 0 );
			stream.writeUInt16LE( flags, 0x0a );
			return buildOle( { WordDocument: stream, '1Table': 'table' } );
		};

		expect( inspectFileContent( 'xls', buildOle( { Workbook: Buffer.concat( [ bof, filePass, buildWorkbook( [ { type: SHEET_TYPE.macro } ] ) ] ) } ) ) ).toBe( 'encrypted' );
		expect( inspectFileContent( 'xls', buildOle( { Book: Buffer.concat( [ bof, filePass ] ) } ) ) ).toBe( 'encrypted' );
		// `fEncrypted`, with `fObfuscated` for XOR; the latter alone means nothing.
		expect( inspectFileContent( 'doc', word( 0x0100 ) ) ).toBe( 'encrypted' );
		expect( inspectFileContent( 'doc', word( 0x8100 ) ) ).toBe( 'encrypted' );
		expect( inspectFileContent( 'doc', word( 0x8000 ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'doc', word( 0x0200 ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'ppt', buildOle( buildPowerPoint( { hasMacros: 0, token: 0xf3d1c4df } ) ) ) ).toBe( 'encrypted' );
	} );

	it( 'refuses OOXML files that Office saved encrypted with a password', () => {
		const encrypted = buildOle( { EncryptionInfo: 'info', EncryptedPackage: Buffer.alloc( 5000, 1 ) } );

		for ( const extension of [ 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt' ] as const ) {
			expect( inspectFileContent( extension, encrypted ) ).toBe( 'encrypted' );
		}
		expect( inspectFileContent( 'odt', encrypted ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'docx', buildOle( { EncryptionInfo: 'info' } ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'docx', buildOle( { 'Data/EncryptionInfo': 'info', EncryptedPackage: 'package' } ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'docx', buildOle( DOC ) ) ).toBe( 'mismatch' );
	} );

	// Sources: xor-encryption-abc.xls from Apache POI test-data, PasswordSample-256bit.pdf from Apache PDFBox
	// (both Apache-2.0), encrypted.docx from oletools test-data, decalage2/oletools (BSD-2-Clause).
	it.each( [ [ 'xor-encryption-abc.xls', 'xls' ], [ 'encrypted.docx', 'docx' ], [ 'PasswordSample-256bit.pdf', 'pdf' ] ] as const )( 'refuses %s, which is encrypted with a password', ( name, extension ) => {
		expect( inspectFileContent( extension, readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) ) ) ).toBe( 'encrypted' );
	} );

	it( 'refuses a malformed compound file', () => {
		const file = buildOle( DOC );
		const fatOffset = oleSectorOffset( file.readUInt32LE( 0x4c ) );
		const patched = ( offset: number, value: number, bytes = file ) => {
			const copy = Buffer.from( bytes );
			copy.writeUInt32LE( value, offset );
			return copy;
		};

		expect( inspectFileContent( 'doc', patched( 0, 0 ) ) ).toBe( 'mismatch' );
		// WordDocument starts in sector 0; a loop back to it or a sector past the end breaks its chain.
		expect( inspectFileContent( 'doc', patched( fatOffset + 4, 0 ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'doc', patched( fatOffset + 4, 100000 ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'doc', patched( 0x30, 100000 ) ) ).toBe( 'mismatch' );
		// The root's child is an entry past the end of the directory.
		const directoryOffset = oleSectorOffset( file.readUInt32LE( 0x30 ) );
		expect( inspectFileContent( 'doc', patched( directoryOffset + 0x4c, 40 ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'doc', file.subarray( 0, directoryOffset + 64 ) ) ).toBe( 'mismatch' );
	} );

	it( 'does not take a document whose text mentions VBA for a macro file', () => {
		const text = Buffer.from( 'Macros\0VBA\0_VBA_PROJECT\0', 'utf16le' );
		expect( inspectFileContent( 'doc', buildOle( { ...DOC, WordDocument: Buffer.concat( [ text, Buffer.alloc( 5000 ) ] ) } ) ) ).toBe( 'valid' );
	} );

	it( 'names macros as the reason, apart from a wrong file type', () => {
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, 'word/vbaProject.bin': '' } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'xls', buildOle( { ...XLS, '_VBA_PROJECT_CUR/VBA/dir': 'x' } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', buildZip( DOCX ) ) ).not.toBe( 'macros' );
		expect( inspectFileContent( 'pdf', fakeFile( [ 0x25, 0x50, 0x44, 0x46 ], 'vbaProject.bin' ) ) ).not.toBe( 'macros' );
	} );

	it( 'rejects a ZIP archive whose file contents only mention the Office parts', () => {
		const misleading = buildZip( { 'readme.txt': '[Content_Types].xml word/document.xml xl/workbook.xml ppt/presentation.xml' } );

		expect( inspectFileContent( 'docx', misleading ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'xlsx', misleading ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'pptx', misleading ) ).not.toBe( 'valid' );
	} );

	it( 'does not take a document whose text mentions vbaProject.bin for a macro file', () => {
		const docx = buildZip( { ...DOCX, 'word/document.xml': '<w:t>word/vbaProject.bin</w:t>' } );

		expect( inspectFileContent( 'docx', docx ) ).toBe( 'valid' );
		expect( inspectFileContent( 'docx', docx ) ).not.toBe( 'macros' );
	} );

	it( 'rejects OOXML files with ActiveX controls', () => {
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, 'word/activeX/activeX1.xml': '' } ) ) ).not.toBe( 'valid' );
	} );

	it( 'finds VBA under another name through its content type or relationship', () => {
		const byContentType = buildZip( {
			...DOCX,
			'[Content_Types].xml': '<Types><Override PartName="/word/code.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
			'word/code.bin': '',
		} );
		const byRelationship = buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': '<Relationships><Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="code.bin"/></Relationships>',
			'word/code.bin': '',
		} );

		for ( const docx of [ byContentType, byRelationship ] ) {
			expect( inspectFileContent( 'docx', docx ) ).toBe( 'macros' );
			expect( inspectFileContent( 'docx', docx ) ).not.toBe( 'valid' );
		}
	} );

	it( 'decodes character references and encoded part names before looking for VBA', () => {
		const byReference = buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': '<Relationships><Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vba&#80;roject" Target="code.bin"/></Relationships>',
			'word/code.bin': '',
		} );
		const byHexReference = buildZip( {
			...DOCX,
			'[Content_Types].xml': '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macro&#x45;nabled.main+xml"/></Types>',
		} );
		const byEncodedPartName = buildZip( {
			...DOCX,
			'[Content_Types].xml': '<Types><Override PartName="/word/c%6Fde.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
			'word/code.bin': '',
		} );
		const byPrefixedElement = buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': '<r:Relationships><r:Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="code.bin"/></r:Relationships>',
			'word/code.bin': '',
		} );

		for ( const docx of [ byReference, byHexReference, byEncodedPartName, byPrefixedElement ] ) {
			expect( inspectFileContent( 'docx', docx ) ).toBe( 'macros' );
		}
	} );

	it( 'reads UTF-16 content types and relationships by their byte order mark', () => {
		const relationships = '<?xml version="1.0" encoding="UTF-16"?><Relationships><Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="code.bin"/></Relationships>';
		const contentTypes = '<?xml version="1.0" encoding="UTF-16"?><Types><Override PartName="/word/code.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>';
		const docx = ( entries: Record<string, ZipFixtureEntry> ) => buildZip( { ...DOCX, ...entries, 'word/code.bin': '' } );

		for ( const encoding of [ 'utf16le', 'utf16be' ] as const ) {
			for ( const bom of [ true, false ] ) {
				expect( inspectFileContent( 'docx', docx( { 'word/_rels/document.xml.rels': { text: relationships, encoding, bom } } ) ) ).toBe( 'macros' );
				expect( inspectFileContent( 'docx', docx( { '[Content_Types].xml': { text: contentTypes, encoding, bom, deflate: true } } ) ) ).toBe( 'macros' );
			}
		}
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, 'word/_rels/document.xml.rels': { text: '<Relationships/>', bom: true } } ) ) ).toBe( 'valid' );
	} );

	it( 'refuses XML parts in an encoding the checks cannot read', () => {
		const declared = buildZip( { ...DOCX, 'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-32"?><Relationships/>' } );
		const invalidUtf16 = buildZip( { ...DOCX, '[Content_Types].xml': { text: '<Types>\udc00</Types>', encoding: 'utf16le' } } );

		expect( inspectFileContent( 'docx', declared ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'docx', invalidUtf16 ) ).toBe( 'mismatch' );
	} );

	it( 'reads attributes past quoted delimiters and values that look like attributes', () => {
		const relationship = ( attributes: string ) => buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': `<Relationships><Relationship ${ attributes } Target="code.bin"/></Relationships>`,
			'word/code.bin': '',
		} );
		const vbaType = 'Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject"';
		const byQuotedDelimiter = relationship( `Id="rId9" Note=">" ${ vbaType }` );
		const byAttributeInValue = relationship( `Id="x Type='harmless'" ${ vbaType }` );
		const byContentType = buildZip( {
			...DOCX,
			'[Content_Types].xml': '<Types><Override Note="a>b" PartName="/word/code.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
			'word/code.bin': '',
		} );

		for ( const docx of [ byQuotedDelimiter, byAttributeInValue, byContentType ] ) {
			expect( inspectFileContent( 'docx', docx ) ).toBe( 'macros' );
		}
		expect( inspectFileContent( 'docx', relationship( 'Id="rId9" Note=">" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"' ) ) ).toBe( 'valid' );
	} );

	it( 'refuses more relationship parts than are inspected, instead of skipping the rest', () => {
		const relationships = ( count: number ) => Object.fromEntries( Array.from( { length: count }, ( _, index ) => [
			`word/_rels/part${ index }.xml.rels`, '<Relationships/>',
		] ) );

		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, ...relationships( 200 ) } ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, ...relationships( 201 ) } ) ) ).toBe( 'mismatch' );
	} );

	it( 'flags a macro-enabled main part, also when the content types are deflated', () => {
		const contentTypes = '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>';

		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, '[Content_Types].xml': contentTypes } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, '[Content_Types].xml': { text: contentTypes, deflate: true } } ) ) ).toBe( 'macros' );
	} );

	it( 'accepts a normal document with deflated content types and relationships', () => {
		const docx = buildZip( {
			'[Content_Types].xml': {
				text: '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
				deflate: true,
			},
			'_rels/.rels': {
				text: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
				deflate: true,
			},
			'word/document.xml': { text: '<w:document/>', deflate: true },
		} );

		expect( inspectFileContent( 'docx', docx ) ).not.toBe( 'macros' );
		expect( inspectFileContent( 'docx', docx ) ).toBe( 'valid' );
	} );

	it.each( [
		[ 'a comment', '<!-- ', ' -->' ],
		[ 'a CDATA section', '<![CDATA[ ', ' ]]>' ],
		[ 'a processing instruction', '<?note ', ' ?>' ],
	] )( 'does not let %s hide the macro element after it', ( _, open, close ) => {
		// The quote opened inside the markup would swallow the real element up to the closing one.
		const hide = ( element: string, real: string ) => `${ open }<${ element } x="${ close }${ real }${ open }">${ close }`;
		const byRelationship = buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': `<Relationships>${ hide( 'Relationship', "<Relationship Id='rId9' Type='http://schemas.microsoft.com/office/2006/relationships/vbaProject' Target='code.bin'/>" ) }</Relationships>`,
			'word/code.bin': '',
		} );
		const byContentType = buildZip( {
			...DOCX,
			'[Content_Types].xml': `<Types>${ hide( 'Override', "<Override PartName='/word/code.bin' ContentType='application/vnd.ms-office.vbaProject'/>" ) }</Types>`,
			'word/code.bin': '',
		} );

		expect( inspectFileContent( 'docx', byRelationship ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', byContentType ) ).toBe( 'macros' );
	} );

	it( 'refuses XML parts with a document type, unclosed markup or NUL characters', () => {
		const relationships = ( text: string ) => buildZip( { ...DOCX, 'word/_rels/document.xml.rels': text } );

		expect( inspectFileContent( 'docx', relationships( '<!DOCTYPE r [<!ENTITY v "vbaProject">]><Relationships/>' ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'docx', relationships( '<Relationships><!-- </Relationships>' ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'docx', relationships( '<Relationships><?note </Relationships>' ) ) ).toBe( 'mismatch' );
		// UTF-32 decodes as UTF-8 with NULs between the characters, which no pattern matches.
		expect( inspectFileContent( 'docx', relationships( '<\0\0\0R\0\0\0/\0\0\0>\0\0\0' ) ) ).toBe( 'mismatch' );
	} );

	it( 'counts an element whose attributes do not parse as a macro', () => {
		const relationship = buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': '<Relationships><Relationship Id=rId9 Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
		} );
		const contentType = buildZip( {
			...DOCX,
			'[Content_Types].xml': '<Types><Default Extension=xml ContentType="application/xml"/></Types>',
		} );

		expect( inspectFileContent( 'docx', relationship ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', contentType ) ).toBe( 'macros' );
	} );

	it( 'reads single-quoted, prefixed and repeated relationship types', () => {
		const relationship = ( attributes: string ) => buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId9" ${ attributes } Target="code.bin"/></Relationships>`,
			'word/code.bin': '',
		} );
		const vba = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject';
		const styles = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';

		expect( inspectFileContent( 'docx', relationship( `Type='${ vba }'` ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', relationship( `x:Type="${ vba }"` ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', relationship( `Type="${ styles }" Type="${ vba }"` ) ) ).toBe( 'macros' );
	} );

	it( 'finds a relationship type with whitespace around it', () => {
		const relationship = ( type: string ) => buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId9" Type="${ type }" Target="code.bin"/></Relationships>`,
			'word/code.bin': '',
		} );
		const vba = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject';

		expect( inspectFileContent( 'docx', relationship( `${ vba } ` ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', relationship( `${ vba }&#9;` ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', relationship( `\n${ vba }\n` ) ) ).toBe( 'macros' );
	} );

	it( 'finds ActiveX controls by content type or relationship', () => {
		const byContentType = buildZip( {
			...DOCX,
			'[Content_Types].xml': '<Types><Override PartName="/word/ctrl1.xml" ContentType="application/vnd.ms-office.activeX+xml"/></Types>',
			'word/ctrl1.xml': '<ax:ocx/>',
		} );
		const relationship = ( type: string ) => buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${ type }" Target="ctrl1.xml"/></Relationships>`,
		} );

		expect( inspectFileContent( 'docx', byContentType ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', relationship( 'control' ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', relationship( 'activeXControl' ) ) ).toBe( 'macros' );
	} );

	describe( 'external relationships', () => {
		const external = ( part: string, type: string, target: string ) => buildZip( {
			...DOCX,
			[ part ]: `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${ type }" Target="${ target }" TargetMode="External"/></Relationships>`,
		} );
		const template = ( target: string ) => external( 'word/_rels/settings.xml.rels', 'attachedTemplate', target );

		// Word loads the template on opening, and its macros with it.
		it.each( [
			'https://example.com/template.dotm',
			'\\\\example.com\\share\\template.dotm',
			'file://example.com/share/template.dotm',
			'file:////example.com/share/template.dotm',
		] )( 'refuses a template attached from %s', ( target ) => {
			expect( inspectFileContent( 'docx', template( target ) ) ).not.toBe( 'valid' );
		} );

		it( 'accepts a template attached from a local path, as Word writes for its own templates', () => {
			expect( inspectFileContent( 'docx', template( 'file:///C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Templates\\Normal.dotm' ) ) ).toBe( 'valid' );
		} );

		// A linked OLE object fetches and runs its target on opening (CVE-2017-0199).
		it( 'refuses a linked OLE object', () => {
			expect( inspectFileContent( 'docx', external( 'word/_rels/document.xml.rels', 'oleObject', 'https://example.com/payload.hta' ) ) ).not.toBe( 'valid' );
		} );

		it( 'accepts a hyperlink', () => {
			expect( inspectFileContent( 'docx', external( 'word/_rels/document.xml.rels', 'hyperlink', 'https://example.com/' ) ) ).toBe( 'valid' );
		} );

		// Saved by Word for Mac 16.113, with author and user name replaced. A document on
		// Normal.dotm names no template; one made from a template of the user names its path.
		const wordForMac = ( name: string ) => readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) );

		it( 'accepts a document Word for Mac saved on its default template', () => {
			expect( inspectFileContent( 'docx', wordForMac( 'word-mac.docx' ) ) ).toBe( 'valid' );
		} );

		// Word for Mac writes `file:////Users/…`, which Word on Windows reads as a share on a host named Users.
		it( 'refuses a document Word for Mac made from a local template', () => {
			expect( inspectFileContent( 'docx', wordForMac( 'word-mac-template.docx' ) ) ).not.toBe( 'valid' );
		} );
	} );

	it( 'flags a macro Override only for a part the package has', () => {
		const contentTypes = '<Types><Override PartName="/word/code.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>';

		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, '[Content_Types].xml': contentTypes } ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, '[Content_Types].xml': contentTypes, 'word/code.bin': '' } ) ) ).toBe( 'macros' );
	} );

	it( 'matches a macro Default extension regardless of case', () => {
		const xlsx = buildZip( {
			...XLSX,
			'[Content_Types].xml': '<Types><Default Extension="BIN" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
			'xl/code.bin': '',
		} );

		expect( inspectFileContent( 'xlsx', xlsx ) ).toBe( 'macros' );
	} );

	it( 'reads the XML declaration and byte order mark of a part', () => {
		const declaration = ( encoding: string ) => `<?xml version="1.0" encoding="${ encoding }" standalone="yes"?>`;
		const macro = `${ declaration( 'UTF-8' ) }<Types><Override PartName="/word/code.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`;
		const docx = ( contentTypes: string | ZipFixtureEntry ) => buildZip( { ...DOCX, '[Content_Types].xml': contentTypes, 'word/code.bin': '' } );

		expect( inspectFileContent( 'docx', docx( `${ declaration( 'UTF-8' ) }<Types/>` ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'docx', docx( { text: macro, bom: true } ) ) ).toBe( 'macros' );
		// The byte order mark wins over a declaration that names UTF-8.
		expect( inspectFileContent( 'docx', docx( { text: macro, encoding: 'utf16le', bom: true } ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', docx( `${ declaration( 'ISO-8859-1' ) }<Types/>` ) ) ).toBe( 'mismatch' );
	} );

	it( 'keeps a reference past the last code point literal and decodes named entities', () => {
		const docx = ( partName: string, entry: string ) => buildZip( {
			...DOCX,
			'[Content_Types].xml': `<Types><Override PartName="/word/${ partName }" ContentType="application/vnd.ms-office.vbaProject"/></Types>`,
			[ `word/${ entry }` ]: '',
		} );

		expect( inspectFileContent( 'docx', docx( '&#x110000;.bin', '&#x110000;.bin' ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', docx( 'a&amp;b.bin', 'a&b.bin' ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'docx', docx( 'a&amp;b.bin', 'a&amp;b.bin' ) ) ).toBe( 'valid' );
	} );

	it( 'ignores a macro content type no part of the package uses', () => {
		const contentTypes = '<Types><Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>';
		const xlsx = buildZip( { ...XLSX, '[Content_Types].xml': contentTypes } );

		expect( inspectFileContent( 'xlsx', xlsx ) ).not.toBe( 'macros' );
		expect( inspectFileContent( 'xlsx', buildZip( { ...XLSX, '[Content_Types].xml': contentTypes, 'xl/code.bin': '' } ) ) ).toBe( 'macros' );
	} );

	it( 'rejects a document whose content types do not inflate', () => {
		const docx = buildZip( { ...DOCX, '[Content_Types].xml': { text: '<Types/>', method: 8 } } );

		expect( inspectFileContent( 'docx', docx ) ).toBe( 'mismatch' );
	} );

	it( 'refuses relationship parts larger than any real document has', () => {
		const padding = ' '.repeat( 300 * 1024 );
		const docx = buildZip( { ...DOCX, 'word/_rels/document.xml.rels': { text: `<Relationships>${ padding }</Relationships>`, deflate: true } } );

		expect( inspectFileContent( 'docx', docx ) ).toBe( 'mismatch' );
	} );

	it( 'inspects a part of exactly 256 KB and refuses one byte more', () => {
		const relationships = ( size: number ) => {
			const padding = ' '.repeat( size - '<Relationships></Relationships>'.length );
			return buildZip( { ...DOCX, 'word/_rels/document.xml.rels': { text: `<Relationships>${ padding }</Relationships>`, deflate: true } } );
		};

		expect( inspectFileContent( 'docx', relationships( 256 * 1024 ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'docx', relationships( 256 * 1024 + 1 ) ) ).toBe( 'mismatch' );
	} );

	it( 'stops inflating once the parts add up past the budget', () => {
		const padding = ' '.repeat( 200 * 1024 );
		const relationships = Object.fromEntries( Array.from( { length: 12 }, ( _, index ) => [
			`word/_rels/part${ index }.xml.rels`, { text: `<Relationships>${ padding }</Relationships>`, deflate: true },
		] ) );

		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, ...relationships } ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, ...Object.fromEntries( Object.entries( relationships ).slice( 0, 5 ) ) } ) ) ).toBe( 'valid' );
	} );

	describe( 'embedded objects and other active content', () => {
		const oleEntry = ( deflate: boolean ): ZipFixtureEntry => ( {
			text: String.fromCharCode( 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1 ) + 'x'.repeat( 3000 ), encoding: 'latin1', deflate,
		} );
		const relationship = ( type: string ) => buildZip( {
			...DOCX,
			'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${ type }" Target="part.bin"/></Relationships>`,
		} );
		const word = ( body: string ) => buildZip( { ...DOCX, 'word/document.xml': `<w:document><w:body>${ body }</w:body></w:document>`, 'word/footer1.xml': '<w:ftr/>' } );
		const run = ( instruction: string ) => `<w:r><w:instrText xml:space="preserve">${ instruction }</w:instrText></w:r>`;

		it( 'refuses an embedded OLE object in an OOXML or OpenDocument package, stored or deflated', () => {
			for ( const deflate of [ false, true ] ) {
				expect( inspectFileContent( 'docx', buildZip( { ...DOCX, 'word/embeddings/oleObject1.bin': oleEntry( deflate ) } ) ) ).toBe( 'macros' );
				expect( inspectFileContent( 'odt', openDocument( 'application/vnd.oasis.opendocument.text', { 'Object 1': oleEntry( deflate ) } ) ) ).toBe( 'macros' );
			}
		} );

		it( 'refuses an internal OLE object or an altChunk by its relationship', () => {
			expect( inspectFileContent( 'docx', relationship( 'oleObject' ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'docx', relationship( 'aFChunk' ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'docx', relationship( 'image' ) ) ).toBe( 'valid' );
		} );

		it( 'accepts an embedded chart workbook, which is a ZIP package and not an OLE object', () => {
			expect( inspectFileContent( 'docx', buildZip( { ...DOCX, 'word/embeddings/Microsoft_Excel_Worksheet.xlsx': 'PK\u0003\u0004 chart data' } ) ) ).toBe( 'valid' );
		} );

		it( 'refuses DDE fields, also split across runs, in CDATA, simple fields or spelled with QUOTE', () => {
			expect( inspectFileContent( 'docx', word( run( ' DDEAUTO c:\\windows\\system32\\cmd.exe "/k calc"' ) ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'docx', word( run( ' DD' ) + run( 'E cmd "/c calc"' ) ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'docx', word( '<w:r><w:instrText><![CDATA[DDEAUTO cmd]]></w:instrText></w:r>' ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'docx', word( '<w:r><w:instrText>&#68;DE cmd</w:instrText></w:r>' ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'docx', word( '<w:fldSimple w:instr=" DDE cmd &quot;/c calc&quot;"/>' ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'docx', word( run( 'QUOTE 68 68 69 65 85 84 79' ) ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'docx', buildZip( { ...DOCX, 'word/header1.xml': `<w:hdr>${ run( 'DDEAUTO cmd' ) }</w:hdr>` } ) ) ).toBe( 'macros' );
		} );

		it( 'accepts ordinary fields and text that mentions DDE', () => {
			expect( inspectFileContent( 'docx', word( run( ' PAGE ' ) + run( ' HYPERLINK "https://example.com/" ' ) ) ) ).toBe( 'valid' );
			expect( inspectFileContent( 'docx', word( '<w:r><w:t>DDEAUTO is a field type</w:t></w:r>' ) ) ).toBe( 'valid' );
		} );

		it( 'refuses an Excel DDE link but not a link to another workbook', () => {
			const link = ( body: string ) => buildZip( { ...XLSX, 'xl/externalLinks/externalLink1.xml': `<externalLink>${ body }</externalLink>` } );
			expect( inspectFileContent( 'xlsx', link( '<ddeLink ddeService="cmd" ddeTopic="/c calc"/>' ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'xlsx', link( '<externalBook r:id="rId1"/>' ) ) ).toBe( 'valid' );
		} );

		it( 'refuses LibreOffice event listeners and links to macros', () => {
			const odt = ( content: string, name = 'content.xml' ) => openDocument( 'application/vnd.oasis.opendocument.text', { [ name ]: content } );
			const listener = '<office:event-listeners><script:event-listener script:language="ooo:script" script:event-name="dom:load" xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=application"/></office:event-listeners>';
			expect( inspectFileContent( 'odt', odt( `<office:document-content>${ listener }</office:document-content>` ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'odt', odt( '<office:document-styles><presentation:event-listener presentation:action="execute" xlink:href="calc.exe"/></office:document-styles>', 'styles.xml' ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'odt', odt( '<office:document-content><text:a xlink:href="vnd.sun.star.script&#58;x">x</text:a></office:document-content>' ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'odt', odt( '<office:document-content><text:a xlink:href="macro:///Standard.Module1.Main">x</text:a></office:document-content>' ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'odt', odt( '<office:document-content><text:p>A macro: nothing to run</text:p><text:a xlink:href="https://example.com/">x</text:a></office:document-content>' ) ) ).toBe( 'valid' );
		} );

		it( 'accepts a LibreOffice chart, which is a sub-document and not an OLE object', () => {
			expect( inspectFileContent( 'odt', openDocument( 'application/vnd.oasis.opendocument.text', { 'Object 1/content.xml': '<office:document-content/>' } ) ) ).toBe( 'valid' );
		} );

		it( 'refuses embedded objects in legacy Office files', () => {
			expect( inspectFileContent( 'doc', buildOle( { ...DOC, 'ObjectPool/_1234567890/\u0001CompObj': 'x' } ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'doc', buildOle( { ...DOC, 'ObjectPool/_1234567890/\u0001Ole10Native': 'x' } ) ) ).toBe( 'macros' );
			expect( inspectFileContent( 'xls', buildOle( { ...XLS, 'MBD0012ABCD/\u0001CompObj': 'x' } ) ) ).toBe( 'macros' );
			const storage = Buffer.alloc( 16 );
			storage.writeUInt16LE( 0x1011, 2 );
			storage.writeUInt32LE( 8, 4 );
			expect( inspectFileContent( 'ppt', buildOle( buildPowerPoint( { hasMacros: 0, objects: [ storage ] } ) ) ) ).toBe( 'macros' );
		} );
	} );

	it( 'rejects LibreOffice files that contain Basic or other scripts', () => {
		const withBasic = openDocument( 'application/vnd.oasis.opendocument.text', { 'Basic/Standard/Module1.xml': 'Sub Main' } );
		const withPython = openDocument( 'application/vnd.oasis.opendocument.spreadsheet', { 'Scripts/python/run.py': 'import os' } );

		expect( inspectFileContent( 'odt', withBasic ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'odt', withBasic ) ).toBe( 'macros' );
		expect( inspectFileContent( 'ods', withPython ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'ods', withPython ) ).toBe( 'macros' );
	} );

	it( 'refuses LibreOffice files encrypted with a password or key', () => {
		const odt = 'application/vnd.oasis.opendocument.text';
		const manifest = ( entry: string, prolog = '<?xml version="1.0" encoding="UTF-8"?>' ) => openDocument( odt, {
			'META-INF/manifest.xml': `${ prolog }<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="content.xml">${ entry }</manifest:file-entry></manifest:manifest>`,
		} );
		const encryption = '<manifest:encryption-data manifest:checksum-type="SHA1/1K"><manifest:algorithm manifest:algorithm-name="Blowfish CFB"/></manifest:encryption-data>';
		const ooo = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE manifest:manifest PUBLIC "-//OpenOffice.org//DTD Manifest 1.0//EN" "Manifest.dtd">';

		expect( inspectFileContent( 'odt', manifest( encryption ) ) ).toBe( 'encrypted' );
		expect( inspectFileContent( 'odt', manifest( encryption, ooo ) ) ).toBe( 'encrypted' );
		expect( inspectFileContent( 'odt', manifest( '' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'odt', manifest( '', ooo ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'odt', manifest( `<!-- ${ encryption } -->` ) ) ).toBe( 'valid' );
		// An internal subset could declare the element as an entity.
		expect( inspectFileContent( 'odt', manifest( '', '<!DOCTYPE m [<!ENTITY e "x">]>' ) ) ).toBe( 'mismatch' );
	} );

	it( 'rejects a LibreOffice file without content or with a compressed or late mimetype', () => {
		const odt = 'application/vnd.oasis.opendocument.text';
		expect( inspectFileContent( 'odt', buildZip( { mimetype: odt } ) ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'odt', buildZip( { 'content.xml': '', mimetype: odt } ) ) ).not.toBe( 'valid' );

		const compressed = openDocument( odt );
		Buffer.from( compressed.buffer ).writeUInt16LE( 8, 8 );
		expect( inspectFileContent( 'odt', compressed ) ).not.toBe( 'valid' );
	} );

	it( 'rejects a well-formed archive whose mimetype header breaks the OpenDocument rules', () => {
		const odt = 'application/vnd.oasis.opendocument.text';
		const withMimetype = ( mimetype: ZipFixtureEntry ) => buildZip( { mimetype, 'content.xml': '<office:document-content/>' } );
		const extra = Buffer.from( [ 0x55, 0x54, 0x01, 0x00, 0x00 ] );
		const deflated = withMimetype( { text: odt, deflate: true } );
		const withExtra = withMimetype( { text: odt, extra } );
		const withDescriptor = withMimetype( { text: odt, centralFlags: 0x0808, localFlags: 0x0808 } );
		// Bit 3 with the real sizes in the local header too, so only the flag breaks the rules.
		const withDescriptorAndSizes = Buffer.from( withDescriptor );
		withDescriptorAndSizes.writeUInt32LE( odt.length, 18 );
		withDescriptorAndSizes.writeUInt32LE( odt.length, 22 );

		for ( const file of [ deflated, withExtra, withDescriptor, withDescriptorAndSizes ] ) {
			// The archive itself parses, so the verdict comes from the OpenDocument check.
			expect( readZipEntries( Buffer.from( file ) ) ).not.toBeNull();
			expect( inspectFileContent( 'odt', file ) ).toBe( 'mismatch' );
		}
		expect( inspectFileContent( 'odt', buildZip( { mimetype: odt, 'content.xml': { text: '', extra } } ) ) ).toBe( 'valid' );
	} );

	it( 'rejects archives with too many entries', () => {
		const files: Record<string, string> = { ...DOCX };
		for ( let index = 0; index < MAX_ZIP_ENTRIES; index++ ) {
			files[ `word/media/image${ index }.png` ] = '';
		}

		expect( inspectFileContent( 'docx', buildZip( files ) ) ).not.toBe( 'valid' );
	} );

	it( 'rejects a truncated or missing central directory', () => {
		const docx = buildZip( DOCX );
		const truncated = new Uint8Array( [ ...docx.subarray( 0, docx.length - 22 - 10 ), ...docx.subarray( docx.length - 22 ) ] );

		expect( inspectFileContent( 'docx', truncated ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'docx', docx.subarray( 0, docx.length - 1 ) ) ).not.toBe( 'valid' );
	} );

	it( 'rejects entry names that leave the archive or appear twice', () => {
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, '../evil.sh': '' } ) ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, '/etc/passwd': '' } ) ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'docx', buildZip( { ...DOCX, 'Word/Document.xml': '' } ) ) ).not.toBe( 'valid' );
	} );

	it( 'rejects a declared uncompressed size beyond the limit', () => {
		const docx = buildZip( DOCX );
		const view = Buffer.from( docx.buffer );
		const directory = view.readUInt32LE( docx.length - 22 + 16 );
		view.writeUInt32LE( 0xfffffff0, directory + 24 );

		expect( inspectFileContent( 'docx', docx ) ).not.toBe( 'valid' );
	} );

	it( 'rejects content of another family (pdf bytes claimed as docx)', () => {
		expect( inspectFileContent( 'docx', fakeFile( [ 0x25, 0x50, 0x44, 0x46 ], '[Content_Types].xml', 'word/' ) ) ).not.toBe( 'valid' );
		expect( inspectFileContent( 'pdf', buildZip( { '[Content_Types].xml': '' } ) ) ).not.toBe( 'valid' );
	} );
} );

describe( 'getCanonicalMimeType', () => {
	it( 'returns the canonical MIME per extension', () => {
		expect( getCanonicalMimeType( 'pdf' ) ).toBe( 'application/pdf' );
		expect( getCanonicalMimeType( 'xlsx' ) ).toBe(
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		);
	} );
} );

describe( 'getExtension — edge cases', () => {
	it( 'double extension: cv.pdf.exe resolves to exe', () => {
		expect( getExtension( 'cv.pdf.exe' ) ).toBe( 'exe' );
	} );

	it( 'bare dotfile .pdf has no stem: extension is empty string', () => {
		// lastDot === 0 so slice returns 'pdf'… but lastDot === 0 and filename.length > 1
		// so the check `lastDot < 0` is false; getExtension returns 'pdf'
		expect( getExtension( '.pdf' ) ).toBe( 'pdf' );
	} );
} );

describe( 'validateUploadDescriptor — edge cases', () => {
	it( 'rejects a double-extension file cv.pdf.exe (extension is exe)', () => {
		const result = validateUploadDescriptor(
			{ filename: 'cv.pdf.exe', mimeType: '', size: 1000 },
			{ maxBytes: MAX }
		);
		expect( result.ok ).toBe( false );
	} );

	it( 'bare dotfile .pdf is accepted (getExtension returns "pdf")', () => {
		const result = validateUploadDescriptor(
			{ filename: '.pdf', mimeType: '', size: 1000 },
			{ maxBytes: MAX }
		);
		expect( result ).toMatchObject( { ok: true, extension: 'pdf' } );
	} );

	it( 'accepts an uppercase .PPTX extension', () => {
		const result = validateUploadDescriptor(
			{ filename: 'slides.PPTX', mimeType: '', size: 1000 },
			{ maxBytes: MAX }
		);
		expect( result ).toMatchObject( { ok: true, extension: 'pptx' } );
	} );
} );
