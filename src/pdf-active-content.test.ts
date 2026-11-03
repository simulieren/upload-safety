import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { inspectFileContent } from './upload-allowlist.js';

function pdf( ...objects: Array<string | Buffer> ): Buffer {
	return Buffer.concat( [
		Buffer.from( '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1' ),
		...objects.map( ( object ) => ( typeof object === 'string' ? Buffer.from( `${ object }\n`, 'latin1' ) : object ) ),
		Buffer.from( 'trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n', 'latin1' ),
	] );
}

/** An object stream whose data is `body`, compressed as `dictionary` says. */
function objectStream( body: Buffer, dictionary = '/Filter /FlateDecode' ): Buffer {
	return Buffer.concat( [
		Buffer.from( `5 0 obj\n<< /Type /ObjStm /N 1 /First 4 ${ dictionary } /Length ${ body.length } >>\nstream\r\n`, 'latin1' ),
		body,
		Buffer.from( '\nendstream\nendobj\n', 'latin1' ),
	] );
}

const fixture = ( name: string ) => readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) );

describe( 'PDF active content', () => {
	it( 'refuses JavaScript, launch, submit and import actions, remote links, multimedia, XFA and attachments', () => {
		for ( const object of [
			'3 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj',
			'3 0 obj << /S /Launch /F (cmd.exe) >> endobj',
			'3 0 obj << /S /SubmitForm /F << /FS /URL /F (https://example.com/) >> >> endobj',
			'3 0 obj << /S /ImportData /F (data.fdf) >> endobj',
			'3 0 obj << /S /GoToR /F (\\\\\\\\example.com\\\\share\\\\a.pdf) >> endobj',
			'3 0 obj << /S /GoToE /T << /R /C /N (a) >> >> endobj',
			'3 0 obj << /S /Rendition /JS (x) >> endobj',
			'3 0 obj << /Subtype /RichMedia >> endobj',
			'3 0 obj << /Fields [] /XFA 4 0 R >> endobj',
			'3 0 obj << /Names << /EmbeddedFiles 4 0 R >> >> endobj',
			'3 0 obj << /Type /EmbeddedFile /Length 0 >> endobj',
			'3 0 obj << /Subtype /FileAttachment /FS 4 0 R >> endobj',
		] ) {
			expect( inspectFileContent( 'pdf', pdf( object ) ), object ).toBe( 'macros' );
		}
	} );

	it( 'finds a name spelled with `#xx` escapes', () => {
		expect( inspectFileContent( 'pdf', pdf( '3 0 obj << /S /Java#53cript /JS (x) >> endobj' ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'pdf', pdf( '3 0 obj << /S /#4a#61vaScript >> endobj' ) ) ).toBe( 'macros' );
	} );

	it( 'finds an action type behind whitespace and comments of any length', () => {
		expect( inspectFileContent( 'pdf', pdf( `3 0 obj << /S %${ 'x'.repeat( 2 * 1024 * 1024 ) }\n /JavaScript >> endobj` ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'pdf', pdf( `3 0 obj << /S${ ' '.repeat( 2 * 1024 * 1024 ) }/Launch >> endobj` ) ) ).toBe( 'macros' );
	} );

	it( 'accepts a link whose address mentions an active name', () => {
		expect( inspectFileContent( 'pdf', pdf( '3 0 obj << /S /URI /URI (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference) >> endobj' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'pdf', pdf( '3 0 obj << /S /URI /URI (https://example.com/XFA/EmbeddedFiles/Launch) >> endobj' ) ) ).toBe( 'valid' );
	} );

	it( 'accepts links, an initial view and names that only start like an active one', () => {
		expect( inspectFileContent( 'pdf', pdf(
			'3 0 obj << /S /URI /URI (https://example.com/) >> endobj',
			'4 0 obj << /OpenAction [ 2 0 R /Fit ] /S /GoTo /D [ 2 0 R /XYZ 0 0 0 ] >> endobj',
			'6 0 obj << /JavaScripts 1 /LaunchPad 2 /XFAx 3 >> endobj'
		) ) ).toBe( 'valid' );
	} );

	it( 'finds active content in a compressed object stream', () => {
		const action = Buffer.from( '3 0 << /S /JavaScript /JS (app.alert(1)) >>', 'latin1' );
		expect( inspectFileContent( 'pdf', pdf( objectStream( deflateSync( action ) ) ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'pdf', pdf( objectStream( deflateSync( action ), '/Filter [ /FlateDecode ] /DecodeParms null' ) ) ) ).toBe( 'macros' );
		const plain = Buffer.from( '3 0 << /S /URI /URI (https://example.com/) >>', 'latin1' );
		expect( inspectFileContent( 'pdf', pdf( objectStream( deflateSync( plain ) ) ) ) ).toBe( 'valid' );
	} );

	it( 'accepts outline items, which have /First without a stream', () => {
		expect( inspectFileContent( 'pdf', pdf( '7 0 obj << /Type /Outlines /First 8 0 R /Last 8 0 R /Count 1 >> endobj' ) ) ).toBe( 'valid' );
	} );

	it( 'refuses an object stream it cannot read', () => {
		const action = Buffer.from( '3 0 << /S /JavaScript >>', 'latin1' );
		expect( inspectFileContent( 'pdf', pdf( objectStream( Buffer.from( action.toString( 'hex' ) ), '/Filter /ASCIIHexDecode' ) ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'pdf', pdf( objectStream( deflateSync( action ), '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>' ) ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'pdf', pdf( objectStream( Buffer.from( 'not deflated' ) ) ) ) ).toBe( 'mismatch' );
	} );

	it( 'calls an unreadable object stream encrypted when the PDF is, though it opens without a password', () => {
		const update = objectStream( Buffer.from( 'ciphertext' ) );
		expect( inspectFileContent( 'pdf', fixture( 'pdf-permissions-only.pdf' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'pdf', Buffer.concat( [ fixture( 'pdf-permissions-only.pdf' ), update ] ) ) ).toBe( 'encrypted' );
	} );
} );
