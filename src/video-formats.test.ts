import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stripAvi, stripIsoMedia, stripMatroska } from './video-formats.js';

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

describe( 'stripMatroska with webm', () => {
	it( 'removes title and tags from a real file without changing its size or clusters', () => {
		const input = fixture( 'video-gps.webm' );
		const inputCopy = Buffer.from( input );
		const output = stripMatroska( input, 'webm' );

		expect( input.includes( TITLE ) ).toBe( true );
		expect( output ).not.toBeNull();
		expect( input.equals( inputCopy ) ).toBe( true );
		expect( output!.length ).toBe( input.length );
		expect( output!.includes( TITLE ) ).toBe( false );
		expect( output!.includes( 'SecretComment' ) ).toBe( false );
		const clusterStart = input.indexOf( Buffer.from( '1f43b675', 'hex' ) );
		expect( output!.subarray( clusterStart ).equals( input.subarray( clusterStart ) ) ).toBe( true );
		expect( stripMatroska( output!, 'webm' ) ).toBe( output );
	} );

	it( 'replaces Tags, Attachments and Title with Void elements of the same length', () => {
		const tags = element( '1254c367', element( '7373', text( 'SecretTag' ) ) );
		const attachments = element( '1941a469', element( '61a7', text( 'cover-image' ) ) );
		const info = element( '1549a966', element( '7ba9', text( TITLE ) ), element( '4d80', text( 'Lavf' ) ) );
		const file = webm( [ info, TRACKS, attachments, CLUSTER, tags ] );
		const output = stripMatroska( file, 'webm' )!;

		expect( output.length ).toBe( file.length );
		for ( const secret of [ 'SecretTag', 'cover-image', TITLE ] ) {
			expect( output.includes( secret ) ).toBe( false );
		}
		expect( output.includes( 'Lavf' ) ).toBe( true );
		expect( output.includes( 'framedata' ) ).toBe( true );
		expect( stripMatroska( output, 'webm' ) ).toBe( output );
	} );

	it( 'fills large elements with a Void whose size field is wide enough', () => {
		const attachments = element( '1941a469', Buffer.alloc( 100 ) );
		const big = Buffer.concat( [ Buffer.from( '1941a469', 'hex' ), vint( 70_000, 4 ), Buffer.alloc( 70_000, 7 ) ] );
		const file = webm( [ INFO, TRACKS, attachments, big, CLUSTER ] );
		const output = stripMatroska( file, 'webm' )!;

		expect( output.length ).toBe( file.length );
		expect( output.includes( Buffer.alloc( 8, 7 ) ) ).toBe( false );
		expect( output.subarray( output.length - CLUSTER.length ).equals( CLUSTER ) ).toBe( true );
	} );

	it( 'accepts a segment of unknown size', () => {
		const file = webm( [ INFO, TRACKS, CLUSTER ], 'webm', UNKNOWN_SIZE );

		expect( stripMatroska( file, 'webm' ) ).toBe( file );
	} );

	it( 'accepts clusters of unknown size, ending at the next top-level element', () => {
		const live = Buffer.concat( [ Buffer.from( '1f43b675', 'hex' ), UNKNOWN_SIZE, element( 'e7', Buffer.from( [ 0 ] ) ), element( 'a3', text( 'framedata' ) ) ] );
		const tags = element( '1254c367', element( '7373', text( 'SecretTag' ) ) );
		const file = webm( [ INFO, TRACKS, live, live, tags ], 'webm', UNKNOWN_SIZE );
		const output = stripMatroska( file, 'webm' )!;

		expect( output ).not.toBeNull();
		expect( output.includes( 'SecretTag' ) ).toBe( false );
		expect( output.length ).toBe( file.length );
	} );

	it( 'returns the same buffer when there is nothing to strip', () => {
		const file = webm( [ INFO, TRACKS, CLUSTER ] );

		expect( stripMatroska( file, 'webm' ) ).toBe( file );
	} );

	it( 'rejects Matroska and other doc types when only WebM is allowed', () => {
		expect( stripMatroska( webm( [ INFO, TRACKS, CLUSTER ], 'matroska' ), 'webm' ) ).toBeNull();
		expect( stripMatroska( webm( [ INFO, TRACKS, CLUSTER ], 'mp4x' ), 'webm' ) ).toBeNull();
	} );

	it( 'rejects a file missing Info or Tracks', () => {
		expect( stripMatroska( webm( [ TRACKS, CLUSTER ] ), 'webm' ) ).toBeNull();
		expect( stripMatroska( webm( [ INFO, CLUSTER ] ), 'webm' ) ).toBeNull();
	} );

	it( 'rejects truncated files and elements running past the end', () => {
		const file = fixture( 'video-gps.webm' );
		const oversized = webm( [ INFO, TRACKS, CLUSTER ] );
		oversized[ oversized.length - CLUSTER.length + 4 ] = 0xff - 1;

		expect( stripMatroska( file.subarray( 0, file.length - 5 ), 'webm' ) ).toBeNull();
		expect( stripMatroska( file.subarray( 0, 3 ), 'webm' ) ).toBeNull();
		expect( stripMatroska( Buffer.alloc( 0 ), 'webm' ) ).toBeNull();
		expect( stripMatroska( oversized, 'webm' ) ).toBeNull();
	} );

	it( 'rejects data after a segment of known size and unknown-size elements other than clusters', () => {
		const file = webm( [ INFO, TRACKS, CLUSTER ] );
		const unknownInfo = webm( [ Buffer.from( '1549a966', 'hex' ), UNKNOWN_SIZE, TRACKS ] );

		expect( stripMatroska( Buffer.concat( [ file, text( 'trailing' ) ] ), 'webm' ) ).toBeNull();
		expect( stripMatroska( unknownInfo, 'webm' ) ).toBeNull();
	} );

	it( 'rejects non-WebM bytes', () => {
		expect( stripMatroska( fixture( 'video-gps.mp4' ), 'webm' ) ).toBeNull();
		expect( stripMatroska( Buffer.alloc( 64 ), 'webm' ) ).toBeNull();
	} );
} );

describe( 'stripMatroska with matroska', () => {
	const ATTACHMENT_TYPE = '1941a469';
	const executable = text( 'MZ\x90\x00SecretExecutable' );

	it( 'removes title, tags and location from a real MKV without changing its size or clusters', () => {
		const input = fixture( 'video-gps.mkv' );
		const output = stripMatroska( input, 'matroska' )!;

		expect( input.includes( TITLE ) && input.includes( GPS ) ).toBe( true );
		expect( output ).not.toBeNull();
		expect( output.length ).toBe( input.length );
		for ( const secret of [ TITLE, 'TestArtist', GPS ] ) {
			expect( output.includes( secret ) ).toBe( false );
		}
		const clusterStart = input.indexOf( Buffer.from( '1f43b675', 'hex' ) );
		expect( output.subarray( clusterStart ).equals( input.subarray( clusterStart ) ) ).toBe( true );
		expect( stripMatroska( output, 'matroska' ) ).toBe( output );
	} );

	it( 'voids an attachment holding an executable', () => {
		const attachments = element( ATTACHMENT_TYPE, element( '61a7', element( '466e', text( 'run.exe' ) ), element( '465c', executable ) ) );
		const file = webm( [ INFO, TRACKS, attachments, CLUSTER ], 'matroska' );
		const output = stripMatroska( file, 'matroska' )!;

		expect( output.length ).toBe( file.length );
		expect( output.includes( 'MZ' ) ).toBe( false );
		expect( output.includes( 'run.exe' ) ).toBe( false );
		expect( output.includes( 'framedata' ) ).toBe( true );
	} );

	it( 'accepts a Matroska file only when Matroska is allowed', () => {
		const file = webm( [ INFO, TRACKS, CLUSTER ], 'matroska' );

		expect( stripMatroska( file, 'matroska' ) ).toBe( file );
		expect( stripMatroska( file, 'webm' ) ).toBeNull();
	} );

	it( 'accepts a WebM file when Matroska is allowed, and refuses other doc types', () => {
		const file = webm( [ INFO, TRACKS, CLUSTER ], 'webm' );

		expect( stripMatroska( file, 'matroska' ) ).toBe( file );
		expect( stripMatroska( webm( [ INFO, TRACKS, CLUSTER ], 'mp4x' ), 'matroska' ) ).toBeNull();
	} );

	it( 'rejects truncated files and non-Matroska bytes', () => {
		const file = fixture( 'video-gps.mkv' );

		expect( stripMatroska( file.subarray( 0, file.length - 5 ), 'matroska' ) ).toBeNull();
		expect( stripMatroska( fixture( 'video-gps.mp4' ), 'matroska' ) ).toBeNull();
	} );
} );

const u32 = ( value: number ): Buffer => {
	const buffer = Buffer.alloc( 4 );
	buffer.writeUInt32LE( value );
	return buffer;
};

function riffChunk( type: string, ...content: Buffer[] ): Buffer {
	const body = Buffer.concat( content );
	return Buffer.concat( [ text( type ), u32( body.length ), body, Buffer.alloc( body.length & 1 ) ] );
}

function riffList( listType: string, ...content: Buffer[] ): Buffer {
	return riffChunk( 'LIST', text( listType ), ...content );
}

function avi( children: Buffer[], form = 'AVI ' ): Buffer {
	const body = Buffer.concat( [ text( form ), ...children ] );
	return Buffer.concat( [ text( 'RIFF' ), u32( body.length ), body ] );
}

const AVIH = riffChunk( 'avih', Buffer.alloc( 56, 1 ) );
const HDRL = riffList( 'hdrl', AVIH );
const MOVI = riffList( 'movi', riffChunk( '00dc', text( 'framedata' ) ) );
const IDX1 = riffChunk( 'idx1', Buffer.alloc( 16, 2 ) );

describe( 'stripAvi', () => {
	it( 'removes title and artist from a real file without changing its size, movi or index', () => {
		const input = fixture( 'video-gps.avi' );
		const output = stripAvi( input )!;

		expect( input.includes( TITLE ) ).toBe( true );
		expect( output ).not.toBeNull();
		expect( output.length ).toBe( input.length );
		expect( output.includes( TITLE ) ).toBe( false );
		expect( output.includes( 'TestArtist' ) ).toBe( false );
		const moviStart = input.indexOf( text( 'movi' ) ) - 8;
		expect( output.subarray( moviStart ).equals( input.subarray( moviStart ) ) ).toBe( true );
		expect( stripAvi( output ) ).toBe( output );
	} );

	it( 'blanks INFO, IDIT, ISMP, XMP and vendor data into JUNK chunks of the same size', () => {
		const info = riffList( 'INFO', riffChunk( 'INAM', text( 'SecretName' ) ) );
		const strl = riffList( 'strl', riffChunk( 'strh', Buffer.alloc( 8, 3 ) ), riffChunk( 'strd', text( 'SecretSerial' ) ) );
		const file = avi( [ riffList( 'hdrl', AVIH, strl ), info, riffChunk( 'IDIT', text( 'SecretDate' ) ), riffChunk( 'ISMP', text( 'SecretTime' ) ), riffChunk( '_PMX', text( '<x:xmpmeta>SecretXmp' ) ), MOVI, IDX1 ] );
		const output = stripAvi( file )!;

		expect( output.length ).toBe( file.length );
		expect( output.includes( 'Secret' ) ).toBe( false );
		expect( output.includes( 'INFO' ) ).toBe( false );
		expect( output.includes( 'strh' ) ).toBe( true );
		expect( output.subarray( output.length - MOVI.length - IDX1.length ).equals( Buffer.concat( [ MOVI, IDX1 ] ) ) ).toBe( true );
		expect( stripAvi( output ) ).toBe( output );
	} );

	it( 'returns the same buffer when there is nothing to strip', () => {
		const file = avi( [ HDRL, MOVI, IDX1 ] );

		expect( stripAvi( file ) ).toBe( file );
	} );

	it( 'zeroes data hidden in JUNK chunks', () => {
		const file = avi( [ HDRL, riffChunk( 'JUNK', text( 'SecretPadding' ) ), MOVI ] );

		expect( stripAvi( file )!.includes( 'Secret' ) ).toBe( false );
	} );

	it( 'reads OpenDML RIFF AVIX chunks after the first and blanks metadata in them', () => {
		const extension = avi( [ riffChunk( '_PMX', text( 'SecretXmp' ) ), MOVI ], 'AVIX' );
		const file = Buffer.concat( [ avi( [ HDRL, MOVI ] ), extension ] );
		const output = stripAvi( file )!;

		expect( output.length ).toBe( file.length );
		expect( output.includes( 'SecretXmp' ) ).toBe( false );
		expect( stripAvi( Buffer.concat( [ avi( [ HDRL, MOVI ] ), avi( [ MOVI ] ) ] ) ) ).toBeNull();
	} );

	it( 'rejects an AVI without movi, hdrl or avih', () => {
		expect( stripAvi( avi( [ HDRL, IDX1 ] ) ) ).toBeNull();
		expect( stripAvi( avi( [ MOVI ] ) ) ).toBeNull();
		expect( stripAvi( avi( [ riffList( 'hdrl', riffChunk( 'strh', Buffer.alloc( 8 ) ) ), MOVI ] ) ) ).toBeNull();
		expect( stripAvi( avi( [ AVIH, MOVI ] ) ) ).toBeNull();
	} );

	it( 'rejects a chunk running past the end and a RIFF size larger than the file', () => {
		const file = avi( [ HDRL, MOVI ] );
		const longChunk = Buffer.from( file );
		longChunk.writeUInt32LE( 10_000, file.length - MOVI.length + 4 );

		expect( stripAvi( longChunk ) ).toBeNull();
		expect( stripAvi( file.subarray( 0, file.length - 3 ) ) ).toBeNull();
	} );

	it( 'rejects bytes after the last RIFF', () => {
		const file = avi( [ HDRL, MOVI ] );

		expect( stripAvi( Buffer.concat( [ file, text( 'trailing' ) ] ) ) ).toBeNull();
		expect( stripAvi( Buffer.concat( [ file, text( 'RIFF' ) ] ) ) ).toBeNull();
	} );

	it( 'rejects lists nested deeper than the limit', () => {
		let nested = riffChunk( '_PMX', text( 'x' ) );
		for ( let level = 0; level < 12; level++ ) {
			nested = riffList( 'strl', nested );
		}

		expect( stripAvi( avi( [ riffList( 'hdrl', AVIH, nested ), MOVI ] ) ) ).toBeNull();
	} );

	it( 'rejects other RIFF forms and non-RIFF bytes', () => {
		expect( stripAvi( avi( [ HDRL, MOVI ], 'WAVE' ) ) ).toBeNull();
		expect( stripAvi( fixture( 'media-tagged.wav' ) ) ).toBeNull();
		expect( stripAvi( Buffer.alloc( 0 ) ) ).toBeNull();
		expect( stripAvi( Buffer.alloc( 64 ) ) ).toBeNull();
	} );
} );
