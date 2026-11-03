import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stripIsoMedia, stripWebm } from './video-formats.js';

const GPS = '+47.2500+008.5000';
const TITLE = 'SecretTitle';
const MP4_BRANDS = [ 'isom', 'mp42' ];

function fixture( name: string ): Buffer {
	return readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) );
}

function box( type: string, ...content: Buffer[] ): Buffer {
	const body = Buffer.concat( content );
	const header = Buffer.alloc( 8 );
	header.writeUInt32BE( body.length + 8 );
	header.write( type, 4, 'latin1' );
	return Buffer.concat( [ header, body ] );
}

function ftyp( major: string, ...compatible: string[] ): Buffer {
	return box( 'ftyp', Buffer.from( major + '\0\0\0\0' + compatible.join( '' ), 'latin1' ) );
}

const text = ( value: string ): Buffer => Buffer.from( value, 'latin1' );

/** The payload of the first top-level box of `type`, found by walking boxes. */
function topLevel( bytes: Buffer, type: string ): Buffer | undefined {
	for ( let offset = 0; offset + 8 <= bytes.length; ) {
		const size = bytes.readUInt32BE( offset );
		if ( bytes.toString( 'latin1', offset + 4, offset + 8 ) === type ) {
			return bytes.subarray( offset + 8, offset + size );
		}
		offset += size;
	}
	return undefined;
}

describe( 'stripIsoMedia', () => {
	it.each( [
		[ 'video-gps.mp4', MP4_BRANDS ],
		[ 'video-gps.mov', null ],
		[ 'video-gps.m4a', [ 'M4A ' ] ],
	] )( 'removes location and title from %s without changing its size or media data', ( name, brands ) => {
		const input = fixture( name );
		const inputCopy = Buffer.from( input );
		const output = stripIsoMedia( input, brands );

		expect( output ).not.toBeNull();
		expect( input.equals( inputCopy ) ).toBe( true );
		expect( output!.length ).toBe( input.length );
		expect( output!.includes( TITLE ) ).toBe( false );
		expect( output!.includes( GPS ) ).toBe( false );
		expect( output!.includes( 'location' ) ).toBe( false );
		expect( topLevel( output!, 'mdat' )!.equals( topLevel( input, 'mdat' )! ) ).toBe( true );
		expect( stripIsoMedia( output!, brands ) ).toBe( output );
	} );

	it( 'confirms the fixtures carried the metadata to begin with', () => {
		expect( fixture( 'video-gps.mov' ).includes( GPS ) ).toBe( true );
		expect( fixture( 'video-gps.mp4' ).includes( TITLE ) ).toBe( true );
		expect( fixture( 'video-gps.m4a' ).includes( TITLE ) ).toBe( true );
	} );

	it( 'blanks udta, meta and uuid boxes nested in moov and trak and at the top level', () => {
		const file = Buffer.concat( [
			ftyp( 'isom', 'mp42' ),
			box( 'uuid', Buffer.alloc( 16, 1 ), text( 'xmp-packet' ) ),
			box( 'meta', text( 'top-meta' ) ),
			box( 'moov', box( 'mvhd', Buffer.alloc( 4 ) ), box( 'udta', text( GPS ) ), box( 'trak', box( 'meta', text( 'trak-meta' ) ), box( 'mdia', box( 'XMP_', text( 'xmp-in-mdia' ) ) ) ) ),
			box( 'mdat', text( 'media' ) ),
		] );
		const output = stripIsoMedia( file, MP4_BRANDS )!;

		expect( output.length ).toBe( file.length );
		for ( const secret of [ 'xmp-packet', 'top-meta', GPS, 'trak-meta', 'xmp-in-mdia' ] ) {
			expect( output.includes( secret ) ).toBe( false );
		}
		expect( output.includes( 'media' ) ).toBe( true );
		expect( output.includes( 'mvhd' ) ).toBe( true );
	} );

	it( 'returns the same buffer when there is nothing to strip', () => {
		const file = Buffer.concat( [ ftyp( 'isom' ), box( 'moov', box( 'mvhd', Buffer.alloc( 4 ) ) ), box( 'mdat', text( 'media' ) ) ] );

		expect( stripIsoMedia( file, MP4_BRANDS ) ).toBe( file );
	} );

	it( 'accepts a compatible brand and a size-0 final box', () => {
		const last = Buffer.concat( [ Buffer.alloc( 4 ), text( 'mdat' ), text( 'media' ) ] );
		const file = Buffer.concat( [ ftyp( 'zzzz', 'mp42' ), box( 'moov' ), last ] );

		expect( stripIsoMedia( file, MP4_BRANDS ) ).not.toBeNull();
	} );

	it( 'accepts a 64-bit box size', () => {
		const large = Buffer.alloc( 16 );
		large.writeUInt32BE( 1 );
		large.write( 'mdat', 4, 'latin1' );
		large.writeBigUInt64BE( 21n, 8 );
		const file = Buffer.concat( [ ftyp( 'isom' ), box( 'moov' ), large, text( 'media' ) ] );

		expect( stripIsoMedia( file, MP4_BRANDS ) ).not.toBeNull();
	} );

	it( 'rejects a truncated box', () => {
		const file = fixture( 'video-gps.mp4' );

		expect( stripIsoMedia( file.subarray( 0, file.length - 10 ), MP4_BRANDS ) ).toBeNull();
		expect( stripIsoMedia( file.subarray( 0, 5 ), MP4_BRANDS ) ).toBeNull();
		expect( stripIsoMedia( Buffer.alloc( 0 ), MP4_BRANDS ) ).toBeNull();
	} );

	it( 'rejects a box whose size runs past the end of the file', () => {
		const oversized = box( 'mdat', text( 'media' ) );
		oversized.writeUInt32BE( 1000 );

		expect( stripIsoMedia( Buffer.concat( [ ftyp( 'isom' ), box( 'moov' ), oversized ] ), MP4_BRANDS ) ).toBeNull();
	} );

	it( 'rejects a nested box that runs past its parent', () => {
		const inner = box( 'udta', text( GPS ) );
		inner.writeUInt32BE( 500 );

		expect( stripIsoMedia( Buffer.concat( [ ftyp( 'isom' ), box( 'moov', inner ), box( 'mdat' ) ] ), MP4_BRANDS ) ).toBeNull();
	} );

	it( 'rejects a file without moov and a file with two', () => {
		expect( stripIsoMedia( Buffer.concat( [ ftyp( 'isom' ), box( 'mdat', text( 'media' ) ) ] ), MP4_BRANDS ) ).toBeNull();
		expect( stripIsoMedia( Buffer.concat( [ ftyp( 'isom' ), box( 'moov' ), box( 'moov' ) ] ), MP4_BRANDS ) ).toBeNull();
	} );

	it( 'rejects a file naming none of the accepted brands', () => {
		const file = Buffer.concat( [ ftyp( 'heic', 'mif1' ), box( 'moov' ) ] );

		expect( stripIsoMedia( file, MP4_BRANDS ) ).toBeNull();
		expect( stripIsoMedia( Buffer.concat( [ box( 'moov' ) ] ), MP4_BRANDS ) ).toBeNull();
	} );

	it( 'accepts a mov without ftyp when it starts with a known box', () => {
		for ( const first of [ 'wide', 'mdat', 'free', 'skip', 'pnot' ] ) {
			expect( stripIsoMedia( Buffer.concat( [ box( first ), box( 'moov' ), box( 'mdat' ) ] ), null ) ).not.toBeNull();
		}
		expect( stripIsoMedia( Buffer.concat( [ box( 'moov' ), box( 'mdat' ) ] ), null ) ).not.toBeNull();
	} );

	it( 'rejects a mov starting with an unknown box or an ftyp that is not QuickTime', () => {
		expect( stripIsoMedia( Buffer.concat( [ box( 'junk' ), box( 'moov' ) ] ), null ) ).toBeNull();
		expect( stripIsoMedia( Buffer.concat( [ ftyp( 'isom', 'mp42' ), box( 'moov' ) ] ), null ) ).toBeNull();
		expect( stripIsoMedia( Buffer.concat( [ ftyp( 'qt  ' ), box( 'moov' ) ] ), null ) ).not.toBeNull();
	} );

	it( 'rejects boxes nested deeper than the limit and files with too many boxes', () => {
		let nested = box( 'udta', text( GPS ) );
		for ( let level = 0; level < 20; level++ ) {
			nested = box( 'trak', nested );
		}
		const many = Buffer.concat( Array.from( { length: 10_001 }, () => box( 'free' ) ) );

		expect( stripIsoMedia( Buffer.concat( [ ftyp( 'isom' ), box( 'moov', nested ) ] ), MP4_BRANDS ) ).toBeNull();
		expect( stripIsoMedia( Buffer.concat( [ ftyp( 'isom' ), box( 'moov' ), many ] ), MP4_BRANDS ) ).toBeNull();
	} );
} );

function vint( value: number, width: number ): Buffer {
	const bytes = Buffer.alloc( width );
	bytes.writeUIntBE( value, 0, width );
	bytes[ 0 ] |= 0x80 >> ( width - 1 );
	return bytes;
}

const UNKNOWN_SIZE = Buffer.from( [ 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff ] );

function element( id: string, ...content: Buffer[] ): Buffer {
	const body = Buffer.concat( content );
	return Buffer.concat( [ Buffer.from( id, 'hex' ), vint( body.length, 1 ), body ] );
}

function ebmlHeader( docType: string ): Buffer {
	return element( '1a45dfa3', element( '4282', text( docType ) ) );
}

function webm( segmentChildren: Buffer[], docType = 'webm', segmentSize: Buffer | null = null ): Buffer {
	const body = Buffer.concat( segmentChildren );
	return Buffer.concat( [ ebmlHeader( docType ), Buffer.from( '18538067', 'hex' ), segmentSize ?? vint( body.length, 4 ), body ] );
}

const INFO = element( '1549a966', element( '4d80', text( 'Lavf' ) ) );
const TRACKS = element( '1654ae6b', element( 'ae', element( 'd7', Buffer.from( [ 1 ] ) ) ) );
const CLUSTER = element( '1f43b675', element( 'e7', Buffer.from( [ 0 ] ) ), element( 'a3', text( 'framedata' ) ) );

describe( 'stripWebm', () => {
	it( 'removes title and tags from a real file without changing its size or clusters', () => {
		const input = fixture( 'video-gps.webm' );
		const inputCopy = Buffer.from( input );
		const output = stripWebm( input );

		expect( input.includes( TITLE ) ).toBe( true );
		expect( output ).not.toBeNull();
		expect( input.equals( inputCopy ) ).toBe( true );
		expect( output!.length ).toBe( input.length );
		expect( output!.includes( TITLE ) ).toBe( false );
		expect( output!.includes( 'SecretComment' ) ).toBe( false );
		const clusterStart = input.indexOf( Buffer.from( '1f43b675', 'hex' ) );
		expect( output!.subarray( clusterStart ).equals( input.subarray( clusterStart ) ) ).toBe( true );
		expect( stripWebm( output! ) ).toBe( output );
	} );

	it( 'replaces Tags, Attachments and Title with Void elements of the same length', () => {
		const tags = element( '1254c367', element( '7373', text( 'SecretTag' ) ) );
		const attachments = element( '1941a469', element( '61a7', text( 'cover-image' ) ) );
		const info = element( '1549a966', element( '7ba9', text( TITLE ) ), element( '4d80', text( 'Lavf' ) ) );
		const file = webm( [ info, TRACKS, attachments, CLUSTER, tags ] );
		const output = stripWebm( file )!;

		expect( output.length ).toBe( file.length );
		for ( const secret of [ 'SecretTag', 'cover-image', TITLE ] ) {
			expect( output.includes( secret ) ).toBe( false );
		}
		expect( output.includes( 'Lavf' ) ).toBe( true );
		expect( output.includes( 'framedata' ) ).toBe( true );
		expect( stripWebm( output ) ).toBe( output );
	} );

	it( 'fills large elements with a Void whose size field is wide enough', () => {
		const attachments = element( '1941a469', Buffer.alloc( 100 ) );
		const big = Buffer.concat( [ Buffer.from( '1941a469', 'hex' ), vint( 70_000, 4 ), Buffer.alloc( 70_000, 7 ) ] );
		const file = webm( [ INFO, TRACKS, attachments, big, CLUSTER ] );
		const output = stripWebm( file )!;

		expect( output.length ).toBe( file.length );
		expect( output.includes( Buffer.alloc( 8, 7 ) ) ).toBe( false );
		expect( output.subarray( output.length - CLUSTER.length ).equals( CLUSTER ) ).toBe( true );
	} );

	it( 'accepts a segment of unknown size', () => {
		const file = webm( [ INFO, TRACKS, CLUSTER ], 'webm', UNKNOWN_SIZE );

		expect( stripWebm( file ) ).toBe( file );
	} );

	it( 'accepts clusters of unknown size, ending at the next top-level element', () => {
		const live = Buffer.concat( [ Buffer.from( '1f43b675', 'hex' ), UNKNOWN_SIZE, element( 'e7', Buffer.from( [ 0 ] ) ), element( 'a3', text( 'framedata' ) ) ] );
		const tags = element( '1254c367', element( '7373', text( 'SecretTag' ) ) );
		const file = webm( [ INFO, TRACKS, live, live, tags ], 'webm', UNKNOWN_SIZE );
		const output = stripWebm( file )!;

		expect( output ).not.toBeNull();
		expect( output.includes( 'SecretTag' ) ).toBe( false );
		expect( output.length ).toBe( file.length );
	} );

	it( 'returns the same buffer when there is nothing to strip', () => {
		const file = webm( [ INFO, TRACKS, CLUSTER ] );

		expect( stripWebm( file ) ).toBe( file );
	} );

	it( 'rejects Matroska and other doc types', () => {
		expect( stripWebm( webm( [ INFO, TRACKS, CLUSTER ], 'matroska' ) ) ).toBeNull();
		expect( stripWebm( webm( [ INFO, TRACKS, CLUSTER ], 'mp4x' ) ) ).toBeNull();
	} );

	it( 'rejects a file missing Info or Tracks', () => {
		expect( stripWebm( webm( [ TRACKS, CLUSTER ] ) ) ).toBeNull();
		expect( stripWebm( webm( [ INFO, CLUSTER ] ) ) ).toBeNull();
	} );

	it( 'rejects truncated files and elements running past the end', () => {
		const file = fixture( 'video-gps.webm' );
		const oversized = webm( [ INFO, TRACKS, CLUSTER ] );
		oversized[ oversized.length - CLUSTER.length + 4 ] = 0xff - 1;

		expect( stripWebm( file.subarray( 0, file.length - 5 ) ) ).toBeNull();
		expect( stripWebm( file.subarray( 0, 3 ) ) ).toBeNull();
		expect( stripWebm( Buffer.alloc( 0 ) ) ).toBeNull();
		expect( stripWebm( oversized ) ).toBeNull();
	} );

	it( 'rejects data after a segment of known size and unknown-size elements other than clusters', () => {
		const file = webm( [ INFO, TRACKS, CLUSTER ] );
		const unknownInfo = webm( [ Buffer.from( '1549a966', 'hex' ), UNKNOWN_SIZE, TRACKS ] );

		expect( stripWebm( Buffer.concat( [ file, text( 'trailing' ) ] ) ) ).toBeNull();
		expect( stripWebm( unknownInfo ) ).toBeNull();
	} );

	it( 'rejects non-WebM bytes', () => {
		expect( stripWebm( fixture( 'video-gps.mp4' ) ) ).toBeNull();
		expect( stripWebm( Buffer.alloc( 64 ) ) ).toBeNull();
	} );
} );
