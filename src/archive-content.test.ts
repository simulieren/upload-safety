import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { type ArchiveVerdict, type EntryCheck, inspectGzip, inspectTarArchive, inspectZipArchive } from './archive-content.js';
import { MAX_ZIP_UNCOMPRESSED_BYTES } from './zip-entries.js';
import { buildZip } from './zip-fixture.js';

/** Allows .txt files without 'EVIL' in them, flags 'EVIL' as macros and refuses the rest. */
function fakeCheck( seen: string[] = [] ): EntryCheck {
	return ( name, bytes ) => {
		seen.push( name );
		if ( ! name.endsWith( '.txt' ) ) {
			return 'mismatch';
		}
		return bytes.toString() === 'EVIL' ? 'macros' : 'valid';
	};
}

function zipOf( files: Parameters<typeof buildZip>[ 0 ] ): Buffer {
	return Buffer.from( buildZip( files ) );
}

function fixture( name: string ): Buffer {
	return readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) );
}

interface TarFile {
	name: string;
	data?: string | Buffer;
	type?: string;
	prefix?: string;
}

function octal( value: number, length: number ): Buffer {
	return Buffer.from( `${ value.toString( 8 ).padStart( length - 1, '0' ) }\0`, 'latin1' );
}

/** One tar entry: a ustar header with a valid checksum, then its data padded to a block. */
function tarEntry( { name, data = '', type = '0', prefix = '' }: TarFile, mutate?: ( header: Buffer ) => void ): Buffer {
	const body = Buffer.from( data );
	const header = Buffer.alloc( 512 );
	header.write( name, 0, 100, 'utf8' );
	header.write( '0000644\0', 100, 'latin1' );
	octal( body.length, 12 ).copy( header, 124 );
	header.write( type, 156, 'latin1' );
	header.write( 'ustar\x0000', 257, 'latin1' );
	header.write( prefix, 345, 155, 'utf8' );
	mutate?.( header );
	header.fill( 0x20, 148, 156 );
	let sum = 0;
	for ( const byte of header ) {
		sum += byte;
	}
	header.write( `${ sum.toString( 8 ).padStart( 6, '0' ) }\0 `, 148, 'latin1' );
	const padding = Buffer.alloc( ( 512 - body.length % 512 ) % 512 );
	return Buffer.concat( [ header, body, padding ] );
}

const TAR_END = Buffer.alloc( 1024 );

function tarOf( ...parts: Array<TarFile | Buffer> ): Buffer {
	return Buffer.concat( [ ...parts.map( ( part ) => Buffer.isBuffer( part ) ? part : tarEntry( part ) ), TAR_END ] );
}

function paxRecord( key: string, value: string ): string {
	const body = ` ${ key }=${ value }\n`;
	let length = body.length + 1;
	while ( String( length ).length + body.length !== length ) {
		length = String( length ).length + body.length;
	}
	return `${ length }${ body }`;
}

function gzipWithName( data: Buffer, name?: string ): Buffer {
	const plain = gzipSync( data );
	if ( name === undefined ) {
		return plain;
	}
	// FNAME goes right after the fixed 10 byte header.
	const header = Buffer.from( plain.subarray( 0, 10 ) );
	header[ 3 ] |= 0x08;
	return Buffer.concat( [ header, Buffer.from( `${ name }\0`, 'latin1' ), plain.subarray( 10 ) ] );
}

describe( 'inspectZipArchive', () => {
	it( 'passes an archive whose files all pass', () => {
		const seen: string[] = [];
		expect( inspectZipArchive( zipOf( { 'a.txt': 'one', 'dir/b.txt': { text: 'two', deflate: true } } ), fakeCheck( seen ) ) ).toBe( 'valid' );
		expect( seen ).toEqual( [ 'a.txt', 'dir/b.txt' ] );
	} );

	it( 'returns the verdict of the first bad file', () => {
		expect( inspectZipArchive( zipOf( { 'a.txt': 'one', 'b.txt': 'EVIL', 'c.exe': 'x' } ), fakeCheck() ) ).toBe( 'macros' );
		expect( inspectZipArchive( zipOf( { 'a.txt': 'one', 'c.exe': 'x' } ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'skips directories', () => {
		const seen: string[] = [];
		expect( inspectZipArchive( zipOf( { 'dir/': '', 'dir/a.txt': 'one' } ), fakeCheck( seen ) ) ).toBe( 'valid' );
		expect( seen ).toEqual( [ 'dir/a.txt' ] );
	} );

	it( 'refuses an archive without files', () => {
		expect( inspectZipArchive( zipOf( { 'dir/': '' } ), fakeCheck() ) ).toBe( 'mismatch' );
		expect( inspectZipArchive( Buffer.from( 'not a zip' ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'refuses unsafe names', () => {
		expect( inspectZipArchive( zipOf( { '../a.txt': 'one' } ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'refuses a symbolic link', () => {
		const zip = zipOf( { 'a.txt': 'one', 'link.txt': 'a.txt' } );
		// Mark the second central entry as made on Unix with mode 120777.
		let position = zip.readUInt32LE( zip.length - 22 + 16 );
		position += 46 + zip.readUInt16LE( position + 28 );
		zip[ position + 5 ] = 3;
		zip.writeUInt32LE( ( 0o120777 << 16 ) >>> 0, position + 38 );
		expect( inspectZipArchive( zip, fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'reports an encrypted entry', () => {
		const zip = zipOf( { 'a.txt': { text: 'one', centralFlags: 0x0801, localFlags: 0x0801 } } );
		expect( inspectZipArchive( zip, fakeCheck() ) ).toBe( 'encrypted' );
	} );

	it( 'checks files in a real macOS archive and ignores its AppleDouble files', () => {
		const seen: string[] = [];
		expect( inspectZipArchive( fixture( 'archive-macos.zip' ), fakeCheck( seen ) ) ).toBe( 'valid' );
		expect( seen.sort() ).toEqual( [ 'src/b.txt', 'src/docs/a.txt' ] );
	} );

	it( 'accepts macOS metadata only with its real signature', () => {
		const appleDouble = '\x00\x05\x16\x07rest';
		const dsStore = '\0\0\0\x01Bud1rest';
		expect( inspectZipArchive( zipOf( { 'a.txt': 'one', '__MACOSX/._a.bin': appleDouble, 'x/.DS_Store': dsStore } ), fakeCheck() ) ).toBe( 'valid' );
		expect( inspectZipArchive( zipOf( { 'a.txt': 'one', '__MACOSX/._a.bin': 'payload' } ), fakeCheck() ) ).toBe( 'mismatch' );
		expect( inspectZipArchive( zipOf( { 'a.txt': 'one', '.DS_Store': 'payload' } ), fakeCheck() ) ).toBe( 'mismatch' );
		// Outside __MACOSX/ a ._ file is an ordinary file.
		expect( inspectZipArchive( zipOf( { 'a.txt': 'one', '._a.txt': appleDouble } ), fakeCheck() ) ).toBe( 'valid' );
		expect( inspectZipArchive( zipOf( { '__MACOSX/._a.bin': appleDouble } ), fakeCheck() ) ).toBe( 'mismatch' );
	} );
} );

describe( 'inspectTarArchive', () => {
	it( 'passes an archive whose files all pass', () => {
		const seen: string[] = [];
		expect( inspectTarArchive( tarOf( { name: 'a.txt', data: 'one' }, { name: 'dir/b.txt', data: 'x'.repeat( 600 ) } ), fakeCheck( seen ) ) ).toBe( 'valid' );
		expect( seen ).toEqual( [ 'a.txt', 'dir/b.txt' ] );
	} );

	it( 'accepts the GNU magic and the end of data without end blocks', () => {
		const gnu = tarEntry( { name: 'a.txt', data: 'one' }, ( header ) => header.write( 'ustar  \0', 257, 'latin1' ) );
		expect( inspectTarArchive( Buffer.concat( [ gnu, TAR_END ] ), fakeCheck() ) ).toBe( 'valid' );
		expect( inspectTarArchive( gnu, fakeCheck() ) ).toBe( 'valid' );
	} );

	it( 'returns the verdict of the first bad file', () => {
		expect( inspectTarArchive( tarOf( { name: 'a.txt', data: 'one' }, { name: 'b.txt', data: 'EVIL' } ), fakeCheck() ) ).toBe( 'macros' );
	} );

	it( 'skips directories', () => {
		const seen: string[] = [];
		expect( inspectTarArchive( tarOf( { name: 'dir/', type: '5' }, { name: 'dir/a.txt', data: 'one' } ), fakeCheck( seen ) ) ).toBe( 'valid' );
		expect( seen ).toEqual( [ 'dir/a.txt' ] );
	} );

	it( 'refuses an archive without files', () => {
		expect( inspectTarArchive( tarOf( { name: 'dir/', type: '5' } ), fakeCheck() ) ).toBe( 'mismatch' );
		expect( inspectTarArchive( TAR_END, fakeCheck() ) ).toBe( 'mismatch' );
		expect( inspectTarArchive( Buffer.alloc( 0 ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'refuses links, devices and other special entries', () => {
		for ( const type of [ '1', '2', '3', '4', '6', 'K' ] ) {
			expect( inspectTarArchive( tarOf( { name: 'a.txt', data: 'one' }, { name: 'link.txt', type } ), fakeCheck() ) ).toBe( 'mismatch' );
		}
	} );

	it( 'refuses a bad checksum', () => {
		const entry = tarEntry( { name: 'a.txt', data: 'one' } );
		entry[ 0 ] = 'b'.charCodeAt( 0 );
		expect( inspectTarArchive( Buffer.concat( [ entry, TAR_END ] ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'refuses a missing ustar signature', () => {
		const entry = tarEntry( { name: 'a.txt', data: 'one' }, ( header ) => header.fill( 0, 257, 265 ) );
		expect( inspectTarArchive( Buffer.concat( [ entry, TAR_END ] ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'refuses base-256 sizes', () => {
		const entry = tarEntry( { name: 'a.txt', data: 'one' }, ( header ) => {
			header[ 124 ] = 0x80;
		} );
		expect( inspectTarArchive( Buffer.concat( [ entry, TAR_END ] ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'refuses unsafe names', () => {
		for ( const name of [ '../x.txt', '/etc/x.txt', 'a/../../x.txt', 'C:\\x.txt' ] ) {
			expect( inspectTarArchive( tarOf( { name, data: 'one' } ), fakeCheck() ) ).toBe( 'mismatch' );
		}
	} );

	it( 'joins the ustar prefix to the name', () => {
		const seen: string[] = [];
		expect( inspectTarArchive( tarOf( { name: 'a.txt', prefix: 'deep/dir', data: 'one' } ), fakeCheck( seen ) ) ).toBe( 'valid' );
		expect( seen ).toEqual( [ 'deep/dir/a.txt' ] );
		expect( inspectTarArchive( tarOf( { name: 'a.txt', prefix: '../up', data: 'one' } ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'gives the check the pax path instead of the header name', () => {
		const seen: string[] = [];
		const pax = { name: 'PaxHeader', type: 'x', data: paxRecord( 'path', 'long/real-name.txt' ) + paxRecord( 'mtime', '1.5' ) };
		expect( inspectTarArchive( tarOf( pax, { name: 'short', data: 'one' }, { name: 'b.txt', data: 'two' } ), fakeCheck( seen ) ) ).toBe( 'valid' );
		expect( seen ).toEqual( [ 'long/real-name.txt', 'b.txt' ] );
	} );

	it( 'refuses a pax path that is unsafe, and pax records it cannot follow', () => {
		const unsafe = { name: 'PaxHeader', type: 'x', data: paxRecord( 'path', '../x.txt' ) };
		expect( inspectTarArchive( tarOf( unsafe, { name: 'a.txt', data: 'one' } ), fakeCheck() ) ).toBe( 'mismatch' );
		const size = { name: 'PaxHeader', type: 'x', data: paxRecord( 'size', '1' ) };
		expect( inspectTarArchive( tarOf( size, { name: 'a.txt', data: 'one' } ), fakeCheck() ) ).toBe( 'mismatch' );
		const broken = { name: 'PaxHeader', type: 'x', data: '99 path=a.txt\n' };
		expect( inspectTarArchive( tarOf( broken, { name: 'a.txt', data: 'one' } ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'skips global pax headers', () => {
		const global = { name: 'GlobalHead', type: 'g', data: paxRecord( 'comment', 'hi' ) };
		expect( inspectTarArchive( tarOf( global, { name: 'a.txt', data: 'one' } ), fakeCheck() ) ).toBe( 'valid' );
	} );

	it( 'gives the check the GNU long name', () => {
		const seen: string[] = [];
		const longName = `${ 'd/'.repeat( 80 ) }a.txt`;
		expect( inspectTarArchive( tarOf( { name: '././@LongLink', type: 'L', data: `${ longName }\0` }, { name: 'truncated', data: 'one' } ), fakeCheck( seen ) ) ).toBe( 'valid' );
		expect( seen ).toEqual( [ longName ] );
	} );

	it( 'refuses a header with nothing after it', () => {
		const pax = { name: 'PaxHeader', type: 'x', data: paxRecord( 'path', 'a.txt' ) };
		expect( inspectTarArchive( tarOf( pax ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'refuses truncated data and data after the end', () => {
		const entry = tarEntry( { name: 'a.txt', data: 'x'.repeat( 600 ) } );
		expect( inspectTarArchive( entry.subarray( 0, 700 ), fakeCheck() ) ).toBe( 'mismatch' );
		expect( inspectTarArchive( Buffer.concat( [ tarOf( { name: 'a.txt', data: 'one' } ), Buffer.from( 'trailing' ) ] ), fakeCheck() ) ).toBe( 'mismatch' );
		expect( inspectTarArchive( Buffer.concat( [ tarOf( { name: 'a.txt', data: 'one' } ), tarEntry( { name: 'b.exe', data: 'x' } ) ] ), fakeCheck() ) ).toBe( 'mismatch' );
	} );

	it( 'checks the files of a real tgz', () => {
		const seen: string[] = [];
		expect( inspectGzip( fixture( 'archive.tgz' ), fakeCheck( seen ), true ) ).toBe( 'valid' );
		expect( seen.sort() ).toEqual( [ 'b.txt', 'docs/a.txt' ] );
	} );
} );

describe( 'inspectGzip', () => {
	it( 'checks a tgz as a tar', () => {
		const tgz = gzipSync( tarOf( { name: 'a.txt', data: 'one' }, { name: 'b.txt', data: 'EVIL' } ) );
		expect( inspectGzip( tgz, fakeCheck(), true ) ).toBe( 'macros' );
		expect( inspectGzip( gzipSync( tarOf( { name: 'a.txt', data: 'one' } ) ), fakeCheck(), true ) ).toBe( 'valid' );
	} );

	it( 'treats a tar inside a .gz as a tar', () => {
		const seen: string[] = [];
		expect( inspectGzip( gzipSync( tarOf( { name: 'a.txt', data: 'one' } ) ), fakeCheck( seen ), false ) ).toBe( 'valid' );
		expect( seen ).toEqual( [ 'a.txt' ] );
	} );

	it( 'gives the check the file named in the header', () => {
		const seen: string[] = [];
		expect( inspectGzip( gzipWithName( Buffer.from( 'one' ), 'notes.txt' ), fakeCheck( seen ), false ) ).toBe( 'valid' );
		expect( inspectGzip( gzipWithName( Buffer.from( 'EVIL' ), 'dir/notes.txt' ), fakeCheck( seen ), false ) ).toBe( 'macros' );
		expect( seen ).toEqual( [ 'notes.txt', 'notes.txt' ] );
	} );

	it( 'refuses a single file without a name or with an unsafe one', () => {
		expect( inspectGzip( gzipWithName( Buffer.from( 'one' ) ), fakeCheck(), false ) ).toBe( 'mismatch' );
		expect( inspectGzip( gzipWithName( Buffer.from( 'one' ), '..' ), fakeCheck(), false ) ).toBe( 'mismatch' );
		expect( inspectGzip( gzipWithName( Buffer.from( 'one' ), 'dir/' ), fakeCheck(), false ) ).toBe( 'mismatch' );
	} );

	it( 'refuses a tgz that does not hold a tar', () => {
		expect( inspectGzip( gzipWithName( Buffer.from( 'one' ), 'notes.txt' ), fakeCheck(), true ) ).toBe( 'mismatch' );
	} );

	it( 'refuses data that is not gzip, or is damaged', () => {
		const verdicts: ArchiveVerdict[] = [
			inspectGzip( Buffer.from( 'plain text' ), fakeCheck(), false ),
			inspectGzip( Buffer.alloc( 0 ), fakeCheck(), false ),
			inspectGzip( gzipWithName( Buffer.from( 'one' ), 'a.txt' ).subarray( 0, 20 ), fakeCheck(), false )
		];
		expect( verdicts ).toEqual( [ 'mismatch', 'mismatch', 'mismatch' ] );
	} );

	it( 'refuses content that inflates past the limit', () => {
		const bomb = gzipSync( Buffer.alloc( MAX_ZIP_UNCOMPRESSED_BYTES + 1 ) );
		expect( bomb.length ).toBeLessThan( 1024 * 1024 );
		expect( inspectGzip( bomb, fakeCheck(), false ) ).toBe( 'mismatch' );
	} );
} );
