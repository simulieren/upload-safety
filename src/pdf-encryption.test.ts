import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
	describe, expect, it, vi
} from 'vitest';

import { hashR6, isEncryptedPdf, MAX_R6_ROUNDS, PdfReader } from './pdf-encryption.js';
import { inspectFileContent } from './upload-allowlist.js';

/** A minimal PDF with `trailer` after its cross-reference table. */
function pdf( trailer: string, body = '' ): Buffer {
	return Buffer.from( `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n${ body }xref\n0 1\n0000000000 65535 f \ntrailer\n${ trailer }\nstartxref\n9\n%%EOF\n`, 'latin1' );
}

const PLAIN_TRAILER = '<< /Size 3 /Root 1 0 R >>';

describe( 'isEncryptedPdf', () => {
	it( 'accepts a plain PDF', () => {
		expect( inspectFileContent( 'pdf', pdf( PLAIN_TRAILER ) ) ).toBe( 'valid' );
	} );

	it( 'refuses a trailer with an encryption dictionary', () => {
		expect( inspectFileContent( 'pdf', pdf( '<< /Size 6 /Root 1 0 R /Encrypt 5 0 R >>' ) ) ).toBe( 'encrypted' );
	} );

	it( 'refuses an encryption dictionary added by an incremental update', () => {
		const update = Buffer.from( 'xref\n0 1\n0000000000 65535 f \ntrailer\n<</Size 6/Root 1 0 R/Encrypt 5 0 R/Prev 9>>\nstartxref\n99\n%%EOF\n', 'latin1' );
		expect( isEncryptedPdf( Buffer.concat( [ pdf( PLAIN_TRAILER ), update ] ) ) ).toBe( true );
	} );

	it( 'refuses a cross-reference stream dictionary with an encryption dictionary', () => {
		const xrefStream = '7 0 obj\n<</Type/XRef/Size 8/W[1 2 1]/Root 1 0 R/Encrypt 6 0 R/Filter/FlateDecode/Length 0>>stream\n\nendstream\nendobj\n';
		expect( isEncryptedPdf( Buffer.from( `%PDF-1.5\n${ xrefStream }startxref\n9\n%%EOF\n`, 'latin1' ) ) ).toBe( true );
	} );

	// Most uploads carry no `/Encrypt`; they must not cost a second copy of the whole file as text.
	it( 'checks a PDF without encryption without copying it into a string', () => {
		const large = pdf( PLAIN_TRAILER, `3 0 obj\n<< /Length 4000000 >>\nstream\n${ 'x'.repeat( 4_000_000 ) }\nendstream\nendobj\n` );
		const toString = vi.spyOn( Buffer.prototype, 'toString' );
		try {
			expect( isEncryptedPdf( large ) ).toBe( false );
			expect( toString.mock.results.every( ( { value } ) => typeof value !== 'string' || value.length < large.length / 2 ) ).toBe( true );
		} finally {
			toString.mockRestore();
		}
	} );

	// The search reads the file a mebibyte at a time; a name must not get lost or made up at the seam.
	it( 'finds a name across the mebibyte boundary and reads it to its end there', () => {
		const at = ( name: string, start: number ) => Buffer.from( `${ 'x'.repeat( start - 3 ) }<< ${ name } 5 0 R >>`, 'latin1' );

		expect( isEncryptedPdf( at( '/Encrypt', 1024 * 1024 - 3 ) ) ).toBe( true );
		expect( isEncryptedPdf( at( '/#45#6e#63#72#79#70#74', 1024 * 1024 - 10 ) ) ).toBe( true );
		expect( isEncryptedPdf( at( '/Encrypted', 1024 * 1024 - 8 ) ) ).toBe( false );
	} );

	it( 'decodes #xx escapes in names', () => {
		expect( isEncryptedPdf( pdf( '<< /Size 6 /Encr#79pt 5 0 R >>' ) ) ).toBe( true );
		expect( isEncryptedPdf( pdf( '<< /Size 6 /#45#6e#63#72#79#70#74 5 0 R >>' ) ) ).toBe( true );
	} );

	it( 'ignores other names and the word in a string', () => {
		expect( isEncryptedPdf( pdf( PLAIN_TRAILER, '3 0 obj\n<< /Encrypted true /EncryptMetadata false /Encryp 1 /Title (Encrypt) >>\nendobj\n' ) ) ).toBe( false );
		expect( isEncryptedPdf( pdf( '<< /Size 6 /Encr#7 >>' ) ) ).toBe( false );
	} );

	it( 'ends a name at whitespace or a delimiter', () => {
		for ( const end of [ ' ', '\n', '\r', '\t', '\f', '\0', '(', ')', '<', '>', '[', ']', '{', '}', '/', '%' ] ) {
			expect( isEncryptedPdf( Buffer.from( `<</Encrypt${ end }`, 'latin1' ) ) ).toBe( true );
		}
		expect( isEncryptedPdf( Buffer.from( '/Encrypt', 'latin1' ) ) ).toBe( true );
	} );

	// Saved by PDFKit on macOS with RC4 128-bit (revision 3), once with an owner password only and
	// once with an open password. Both carry `/Encrypt`; only the second needs a password to open,
	// and only that one ClamAV cannot scan (`Heuristics.Encrypted.PDF`).
	const fixture = ( name: string ) => readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) );

	it( 'accepts a PDF that only restricts permissions and opens without a password', () => {
		expect( inspectFileContent( 'pdf', fixture( 'pdf-permissions-only.pdf' ) ) ).toBe( 'valid' );
	} );

	it( 'refuses a PDF that needs a password to open', () => {
		expect( inspectFileContent( 'pdf', fixture( 'pdf-open-password.pdf' ) ) ).toBe( 'encrypted' );
	} );

	// Saved with qpdf 12.4.2 (through pikepdf) from a blank page, owner password `owner` and user password
	// empty or `secret`; each opens in `pdfinfo` exactly when it should.
	it.each( [ 'rc4-40bit', 'aes128', 'aes128-plain-metadata', 'aes256' ] )( 'accepts %s with no open password', ( name ) => {
		expect( inspectFileContent( 'pdf', fixture( `pdf-${ name }-no-open-password.pdf` ) ) ).toBe( 'valid' );
	} );

	it( 'refuses AES-256 with an open password', () => {
		expect( inspectFileContent( 'pdf', fixture( 'pdf-aes256-open-password.pdf' ) ) ).toBe( 'encrypted' );
	} );

	/** A fixture with `from` replaced by `to`, which must occur in it. */
	function edited( name: string, from: string | RegExp, to: string ): Buffer {
		const text = fixture( name ).toString( 'latin1' );
		expect( text ).toMatch( from );
		return Buffer.from( text.replace( from, to ), 'latin1' );
	}

	const RC4 = 'pdf-rc4-40bit-no-open-password.pdf';
	const AES128 = 'pdf-aes128-no-open-password.pdf';
	const AES256 = 'pdf-aes256-no-open-password.pdf';

	it( 'refuses security handlers other than Standard', () => {
		expect( isEncryptedPdf( edited( RC4, '/Filter /Standard', '/Filter /Adobe.PubSec' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( AES256, '/Filter /Standard', '/Filter (Standard)' ) ) ).toBe( true );
	} );

	it( 'refuses unknown revisions and versions', () => {
		expect( isEncryptedPdf( edited( RC4, '/R 2', '/R 7' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( RC4, '/V 1', '/V 3' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( AES128, '/V 4', '/V 5' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( AES256, '/V 5', '/V 4' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( AES128, '/Length 128', '/Length 132' ) ) ).toBe( true );
	} );

	it( 'refuses missing or malformed entries', () => {
		for ( const name of [ RC4, AES128, AES256 ] ) {
			expect( isEncryptedPdf( edited( name, / \/O <[0-9a-f]+>/, '' ) ) ).toBe( true );
			expect( isEncryptedPdf( edited( name, / \/U <[0-9a-f]+>/, '' ) ) ).toBe( true );
			expect( isEncryptedPdf( edited( name, / \/P -?\d+/, '' ) ) ).toBe( true );
			expect( isEncryptedPdf( edited( name, / \/P -?\d+/, ' /P 1.5' ) ) ).toBe( true );
			expect( isEncryptedPdf( edited( name, /\/U <([0-9a-f]{20})[0-9a-f]+>/, '/U <$1>' ) ) ).toBe( true );
			expect( isEncryptedPdf( edited( name, /\/U <[0-9a-f]{2}/, '/U <00' ) ) ).toBe( true );
		}
		expect( isEncryptedPdf( edited( RC4, / \/ID \[[^\]]+\]/, '' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( RC4, /\/ID \[<3b/, '/ID [<3c' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( RC4, '/Encrypt 5 0 R', '/Encrypt 9 0 R' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( RC4, '/Encrypt 5 0 R', '/Encrypt 5 0' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( RC4, '/Encrypt 5 0 R', '/Encrypt null' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( RC4, '/Filter /Standard', '/Filter /Standard /Title (never closed' ) ) ).toBe( true );
		expect( isEncryptedPdf( edited( RC4, '/Filter /Standard', `/Filter /Standard /Title (${ 'x'.repeat( 2000 ) })` ) ) ).toBe( true );
	} );

	it( 'reads an encryption dictionary given directly in the trailer', () => {
		const text = fixture( RC4 ).toString( 'latin1' );
		const dictionary = /5 0 obj\s*(<<.*?>>)\s*endobj/s.exec( text )?.[ 1 ] ?? '';
		expect( isEncryptedPdf( Buffer.from( text.replace( '/Encrypt 5 0 R', `/Encrypt ${ dictionary }` ), 'latin1' ) ) ).toBe( false );
		expect( isEncryptedPdf( Buffer.from( text.replace( '/Encrypt 5 0 R', `/Encrypt ${ dictionary.replace( '/R 2', '/R 3' ) }` ), 'latin1' ) ) ).toBe( true );
	} );

	it( 'reads literal strings with escapes', () => {
		// Every byte as an octal or named escape, with a line continuation and balanced parentheses.
		const literal = ( hex: string ) => '(' + [ ...Buffer.from( hex, 'hex' ) ].map( ( byte ) => byte === 0x0a ? '\\n' : `\\${ byte.toString( 8 ) }` ).join( '\\\n' ) + ')';
		const text = fixture( RC4 ).toString( 'latin1' ).replace( /\/([OU]) <([0-9a-f]+)>/g, ( _, key: string, hex: string ) => `/${ key } ${ literal( hex ) }` );
		expect( text ).not.toMatch( /\/[OU] </ );
		expect( isEncryptedPdf( Buffer.from( text, 'latin1' ) ) ).toBe( false );
	} );

	it( 'needs every encryption dictionary to be readable and to open without a password', () => {
		const update = ( encrypt: string ) => `\ntrailer\n<< /Size 6 /ID [<3b826aa361e2adf8611c40fa198e99d0><00>] /Encrypt ${ encrypt } >>\n%%EOF\n`;
		const base = fixture( AES128 ).toString( 'latin1' );
		const fallback = /5 0 obj\s*(<<.*?>>)\s*endobj/s.exec( fixture( RC4 ).toString( 'latin1' ) )?.[ 1 ] ?? '';
		expect( isEncryptedPdf( Buffer.from( base + update( '5 0 R' ), 'latin1' ) ) ).toBe( false );
		expect( isEncryptedPdf( Buffer.from( base + update( fallback.replace( '/R 2', '/R 3' ) ), 'latin1' ) ) ).toBe( true );
		expect( isEncryptedPdf( Buffer.from( base + update( '8 0 R' ), 'latin1' ) ) ).toBe( true );
		expect( isEncryptedPdf( Buffer.from( update( '8 0 R' ) + base, 'latin1' ) ) ).toBe( true );
	} );

	// Readers follow `startxref` and the xref table, so they never read bytes after `%%EOF` or a second
	// copy of the object; such a decoy must not stand in for the dictionary they do read.
	it( 'refuses a password-protected PDF behind a decoy trailer or a decoy copy of its encryption object', () => {
		const rc4 = fixture( RC4 ).toString( 'latin1' );
		const opensWithoutPassword = /5 0 obj\s*(<<.*?>>)\s*endobj/s.exec( rc4 )?.[ 1 ] ?? '';
		const id = /\/ID\s*\[[^\]]*\]/.exec( rc4 )?.[ 0 ] ?? '';
		const locked = fixture( 'pdf-aes256-open-password.pdf' ).toString( 'latin1' );

		expect( isEncryptedPdf( Buffer.from( `${ locked }\n% << ${ id } /Encrypt ${ opensWithoutPassword } >>\n`, 'latin1' ) ) ).toBe( true );
		expect( isEncryptedPdf( Buffer.from( `${ locked }\n5 0 obj\n${ opensWithoutPassword }\nendobj\n`, 'latin1' ) ) ).toBe( true );
	} );

	it( 'finds the encryption object behind any whitespace or comment in its header', () => {
		for ( const header of [ '5 0\nobj', '5  0 obj', '5\r\n0\tobj', '5 0 % written by hand\nobj' ] ) {
			expect( isEncryptedPdf( edited( RC4, '5 0 obj', header ) ) ).toBe( false );
		}
		// Spelled oddly, the real object must still count next to a decoy spelled plainly.
		const opensWithoutPassword = /5 0 obj\s*(<<.*?>>)\s*endobj/s.exec( fixture( RC4 ).toString( 'latin1' ) )?.[ 1 ] ?? '';
		const locked = edited( 'pdf-aes256-open-password.pdf', '5 0 obj', '5 0\nobj' ).toString( 'latin1' );
		expect( isEncryptedPdf( Buffer.from( `${ locked }\n5 0 obj\n${ opensWithoutPassword }\nendobj\n`, 'latin1' ) ) ).toBe( true );
	} );

	// A header may sit after any whitespace and comments, so every occurrence of the object number starts a read.
	it( 'reads text full of object numbers and comments in linear time, without refusing it', () => {
		const rc4 = fixture( RC4 ).toString( 'latin1' );
		const contents = [
			`(${ 'Rabatt 5 % '.repeat( 20_000 ) }) Tj`,
			`% ${ '5 % '.repeat( 20_000 ) }`,
			'% 5\n'.repeat( 20_000 ),
			'%x 5\n'.repeat( 20_000 ),
			'%%BoundingBox: 0 0 612 5\n'.repeat( 5_000 ),
			`% ${ 'a 5 % '.repeat( 2_000 ) }${ '\n'.repeat( 200_000 ) }x`,
			`5\n${ '% 5\n'.repeat( 20_000 ) }0 x`,
			`% ${ '5 % 5x '.repeat( 20_000 ) }`,
			`5\n${ '% 5 '.repeat( 20_000 ) }\n0${ ' '.repeat( 80_000 ) }x`,
			`5\n${ '% 5 '.repeat( 20_000 ) }\n${ '0'.repeat( 80_000 ) }1`,
		];
		for ( const content of contents ) {
			const started = performance.now();
			expect( isEncryptedPdf( Buffer.from( `${ rc4 }\n${ content }\n`, 'latin1' ) ) ).toBe( false );
			expect( performance.now() - started ).toBeLessThan( 1000 );
		}
	} );

	it( 'reads a header that many object numbers in its comments lead to only once', () => {
		const copy = `5\n${ '% 5\n'.repeat( 20_000 ) }0 obj << ${ '/K 1 '.repeat( 3_200 ) }>>`;
		const started = performance.now();
		expect( isEncryptedPdf( Buffer.from( `${ fixture( RC4 ).toString( 'latin1' ) }\n${ copy }\n`, 'latin1' ) ) ).toBe( true );
		expect( performance.now() - started ).toBeLessThan( 1000 );
	} );

	it( 'stops reading headers once the parse budget is spent', () => {
		const headers = `5 0 obj <<\n${ `${ '% 5 0 obj <<\n'.repeat( 1_200 ) }>>\n`.repeat( 80 ) }`;
		const started = performance.now();
		expect( isEncryptedPdf( Buffer.from( `${ fixture( RC4 ).toString( 'latin1' ) }\n${ headers }\n`, 'latin1' ) ) ).toBe( true );
		expect( performance.now() - started ).toBeLessThan( 1000 );
	} );

	// Readers take whatever header the xref table points at, so an oddly spelled one must still be read, or a
	// plainly spelled decoy next to it would decide alone.
	it( 'reads oddly spelled headers next to a decoy', () => {
		const opensWithoutPassword = /5 0 obj\s*(<<.*?>>)\s*endobj/s.exec( fixture( RC4 ).toString( 'latin1' ) )?.[ 1 ] ?? '';
		const decoy = `\n5 0 obj\n${ opensWithoutPassword }\nendobj\n`;
		const headers = [
			`5${ ' '.repeat( 1000 ) }0 obj`,
			`5 0 %${ 'x'.repeat( 100_000 ) }\nobj`,
			`5 0${ '\n% comment'.repeat( 100 ) }\nobj`,
			'005 0 obj',
			'5 00 obj',
		];
		for ( const header of headers ) {
			const locked = edited( 'pdf-aes256-open-password.pdf', '5 0 obj', header ).toString( 'latin1' );
			expect( isEncryptedPdf( Buffer.from( locked + decoy, 'latin1' ) ) ).toBe( true );
		}
		expect( isEncryptedPdf( edited( RC4, '5 0 obj', `5 0 %${ 'x'.repeat( 100_000 ) }\nobj` ) ) ).toBe( false );
	} );

	it( 'refuses a file with too many encryption dictionaries', () => {
		const base = fixture( RC4 ).toString( 'latin1' );
		const trailer = /trailer\s*<<.*?>>/s.exec( base )?.[ 0 ] ?? '';
		expect( isEncryptedPdf( Buffer.from( base + `\n${ trailer }`.repeat( 10 ), 'latin1' ) ) ).toBe( false );
		expect( isEncryptedPdf( Buffer.from( base + `\n${ trailer }`.repeat( 100 ), 'latin1' ) ) ).toBe( true );
	} );

	it( 'checks the empty password for revision 5', () => {
		const salt = Buffer.from( '0102030405060708', 'hex' );
		const user = Buffer.concat( [ createHash( 'sha256' ).update( salt ).digest(), salt, Buffer.alloc( 8 ) ] );
		const encrypt = ( hash: Buffer ) => `<< /Filter /Standard /V 5 /R 5 /P -4 /O <${ Buffer.alloc( 48, 1 ).toString( 'hex' ) }> /U <${ hash.toString( 'hex' ) }> >>`;
		expect( isEncryptedPdf( pdf( `<< /Size 3 /Root 1 0 R /Encrypt ${ encrypt( user ) } >>` ) ) ).toBe( false );
		expect( isEncryptedPdf( pdf( `<< /Size 3 /Root 1 0 R /Encrypt ${ encrypt( Buffer.concat( [ Buffer.alloc( 32 ), salt, Buffer.alloc( 8 ) ] ) ) } >>` ) ) ).toBe( true );
	} );

	it( 'ends Algorithm 2.B within its bound', () => {
		for ( let index = 0; index < 200; index++ ) {
			const { rounds } = hashR6( Buffer.alloc( 0 ), randomBytes( 8 ) );
			expect( rounds ).toBeGreaterThanOrEqual( 64 );
			expect( rounds ).toBeLessThan( MAX_R6_ROUNDS );
		}
	} );
} );

describe( 'PdfReader', () => {
	const read = ( text: string ) => new PdfReader( Buffer.from( text, 'latin1' ), 0 ).tryRead();
	const string = ( text: string ) => {
		const value = read( text );
		return value?.kind === 'string' ? value.value.toString( 'latin1' ) : undefined;
	};

	it( 'reads literal strings', () => {
		expect( string( '(a\\n\\r\\t\\b\\f\\(\\)\\\\b) ' ) ).toBe( 'a\n\r\t\b\f()\\b' );
		expect( string( '(\\101\\0011\\7\\4011) ' ) ).toBe( 'A\x011\x07\x011' );
		expect( string( '(a (b) c) ' ) ).toBe( 'a (b) c' );
		expect( string( '(a\\\nb\\\r\nc\\\rd) ' ) ).toBe( 'abcd' );
		expect( string( '(a\r\nb\rc\nd) ' ) ).toBe( 'a\nb\nc\nd' );
		expect( string( '(\\q) ' ) ).toBe( 'q' );
		expect( string( '(a (b) ' ) ).toBeUndefined();
		expect( string( `(${ 'x'.repeat( 1100 ) }) ` ) ).toBeUndefined();
	} );

	it( 'reads hex strings', () => {
		expect( string( '<41 42\n4a4B> ' ) ).toBe( 'ABJK' );
		expect( string( '<414> ' ) ).toBe( 'A@' );
		expect( string( '<> ' ) ).toBe( '' );
		expect( string( '<41G2> ' ) ).toBeUndefined();
		expect( string( '<4142 ' ) ).toBeUndefined();
	} );

	it( 'reads dictionaries, references and names', () => {
		const value = read( '<< /A 5 0 R /B [ 1 -2.5 /N#41 ] /C << /D true /E null >> % comment\n /F 3 >> ' );
		expect( value?.kind ).toBe( 'dict' );
		if ( value?.kind !== 'dict' ) {
			return;
		}
		expect( value.entries.get( 'A' ) ).toEqual( { kind: 'ref', object: 5, generation: 0 } );
		expect( value.entries.get( 'B' ) ).toEqual( { kind: 'array', items: [ { kind: 'number', value: 1 }, { kind: 'number', value: -2.5 }, { kind: 'name', value: 'NA' } ] } );
		expect( value.entries.get( 'F' ) ).toEqual( { kind: 'number', value: 3 } );
		expect( read( '<< /A 1 ' ) ).toBeUndefined();
		expect( read( '<< 1 2 >> ' ) ).toBeUndefined();
		expect( read( `${ '['.repeat( 20 ) }${ ']'.repeat( 20 ) } ` ) ).toBeUndefined();
	} );
} );
