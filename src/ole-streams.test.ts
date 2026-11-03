import { describe, expect, it } from 'vitest';

import { buildOle, oleSectorOffset } from './ole-fixture.js';
import { MAX_OLE_STREAM_BYTES, readOleDirectory } from './ole-streams.js';

const pattern = ( length: number ) => Buffer.from( Array.from( { length }, ( _, index ) => index % 251 ) );

describe( 'readOleDirectory', () => {
	it( 'reads streams from the mini stream and from regular sectors', () => {
		const small = pattern( 4095 );
		const large = pattern( 4096 );
		const directory = readOleDirectory( buildOle( { Small: small, Large: large, Tiny: 'abc', Empty: '' } ) );

		expect( directory?.readStream( 'Small' ) ).toEqual( small );
		expect( directory?.readStream( 'Large' ) ).toEqual( large );
		expect( directory?.readStream( 'tiny' )?.toString() ).toBe( 'abc' );
		expect( directory?.readStream( 'Empty' ) ).toEqual( Buffer.alloc( 0 ) );
		expect( directory?.readStream( 'Missing' ) ).toBeNull();
	} );

	it( 'lists entries at any depth but reads streams only right below the root', () => {
		const directory = readOleDirectory( buildOle( { WordDocument: 'text', 'Macros/VBA/dir': 'x' } ) );

		expect( directory?.names ).toEqual( [ 'Root Entry', 'WordDocument', 'Macros', 'VBA', 'dir' ] );
		expect( directory?.readStream( 'dir' ) ).toBeNull();
		expect( directory?.readStream( 'Macros' ) ).toBeNull();
	} );

	it( 'reads a FAT listed beyond the header, through the DIFAT', () => {
		const stream = Buffer.alloc( 8 * 1024 * 1024, 7 );
		const file = buildOle( { Workbook: stream } );

		expect( file.readUInt32LE( 0x48 ) ).toBeGreaterThan( 0 );
		expect( readOleDirectory( file )?.readStream( 'Workbook' )?.equals( stream ) ).toBe( true );
	} );

	it( 'reads a stream whose chain runs on past its size, as some writers leave it', () => {
		const file = buildOle( { WordDocument: pattern( 5000 ) } );
		// The stream's last sector is 9; chain it on to the directory sector.
		file.writeUInt32LE( file.readUInt32LE( 0x30 ), oleSectorOffset( file.readUInt32LE( 0x4c ) ) + 9 * 4 );

		expect( readOleDirectory( file )?.readStream( 'WordDocument' ) ).toEqual( pattern( 5000 ) );
	} );

	it( 'refuses a stream larger than the cap', () => {
		const file = buildOle( { WordDocument: pattern( 5000 ) } );
		const entry = oleSectorOffset( file.readUInt32LE( 0x30 ) ) + 128;
		file.writeUInt32LE( MAX_OLE_STREAM_BYTES + 1, entry + 0x78 );

		expect( readOleDirectory( file )?.readStream( 'WordDocument' ) ).toBeNull();
	} );

	it( 'refuses a stream whose chain ends before its size', () => {
		const file = buildOle( { WordDocument: pattern( 5000 ) } );
		file.writeUInt32LE( 0xfffffffe, oleSectorOffset( file.readUInt32LE( 0x4c ) ) + 4 );

		expect( readOleDirectory( file )?.readStream( 'WordDocument' ) ).toBeNull();
	} );

	it( 'refuses a header of another byte order, sector size or mini stream cutoff', () => {
		const patched = ( offset: number, value: number ) => {
			const file = buildOle( { WordDocument: 'text' } );
			file.writeUInt16LE( value, offset );
			return readOleDirectory( file );
		};

		expect( readOleDirectory( buildOle( { WordDocument: 'text' } ) ) ).not.toBeNull();
		expect( patched( 0x1c, 0xfeff ) ).toBeNull();
		expect( patched( 0x1e, 12 ) ).toBeNull();
		expect( patched( 0x20, 7 ) ).toBeNull();
		expect( patched( 0x38, 512 ) ).toBeNull();
	} );

	it( 'refuses two root streams of the same name, of which Office might read the other', () => {
		expect( readOleDirectory( buildOle( { WordDocument: 'text', worddocument: 'other' } ) ) ).toBeNull();
	} );

	it( 'refuses a sibling tree that loops', () => {
		const file = buildOle( { WordDocument: 'text', '1Table': 'table' } );
		const directory = oleSectorOffset( file.readUInt32LE( 0x30 ) );
		// Entry 2's right sibling points back to entry 1.
		file.writeUInt32LE( 1, directory + 2 * 128 + 0x48 );

		expect( readOleDirectory( file ) ).toBeNull();
	} );
} );
