import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { stripPhotoMetadata } from './photo-metadata.js';

// Saved by ImageIO on macOS like a phone photo: JFIF, EXIF with GPS, make, user comment and
// orientation 6, a Photoshop/IPTC block and restart markers; the PNG with eXIf and XMP.
const fixture = ( name: string ) => readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) );
const PHOTO_JPEG = fixture( 'photo-gps.jpg' );
const PHOTO_PNG = fixture( 'photo-gps.png' );
const METADATA_TEXT = [ 'TestPhone', 'Zeugnis Test', 'Photoshop', 'http://ns.adobe.com/xap' ];

const SOI = Buffer.from( [ 0xff, 0xd8 ] );
const EOI = Buffer.from( [ 0xff, 0xd9 ] );

function segment( marker: number, payload: Buffer | string ): Buffer {
	const body = Buffer.isBuffer( payload ) ? payload : Buffer.from( payload, 'latin1' );
	const header = Buffer.from( [ 0xff, marker, 0, 0 ] );
	header.writeUInt16BE( body.length + 2, 2 );
	return Buffer.concat( [ header, body ] );
}

/** Entropy-coded data with a stuffed 0xFF and a restart marker, which are no segments. */
const SCAN = Buffer.concat( [ segment( 0xda, Buffer.from( [ 1, 1, 0, 0, 0x3f, 0 ] ) ), Buffer.from( [ 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56 ] ) ] );

function jpeg( ...segments: Buffer[] ): Buffer {
	return Buffer.concat( [ SOI, ...segments, SCAN, EOI ] );
}

/** A TIFF header and IFD0 with the given SHORT entries, in either byte order. */
function tiff( order: 'II' | 'MM', entries: Array<[ number, number ]> ): Buffer {
	const little = order === 'II';
	const buffer = Buffer.alloc( 8 + 2 + entries.length * 12 + 4 );
	const u16 = ( value: number, offset: number ) => ( little ? buffer.writeUInt16LE( value, offset ) : buffer.writeUInt16BE( value, offset ) );
	const u32 = ( value: number, offset: number ) => ( little ? buffer.writeUInt32LE( value, offset ) : buffer.writeUInt32BE( value, offset ) );
	buffer.write( order, 0, 'latin1' );
	u16( 42, 2 );
	u32( 8, 4 );
	u16( entries.length, 8 );
	entries.forEach( ( [ tag, value ], index ) => {
		const offset = 10 + index * 12;
		u16( tag, offset );
		u16( 3, offset + 2 );
		u32( 1, offset + 4 );
		u16( value, offset + 8 );
	} );
	return buffer;
}

const exifSegment = ( body: Buffer ) => segment( 0xe1, Buffer.concat( [ Buffer.from( 'Exif\0\0', 'latin1' ), body ] ) );

/** The markers and payloads of the segments before the first scan. */
function headerSegments( bytes: Buffer ): Array<{ marker: number; payload: Buffer }> {
	const segments: Array<{ marker: number; payload: Buffer }> = [];
	for ( let offset = 2; bytes[ offset + 1 ] !== 0xda; ) {
		const length = bytes.readUInt16BE( offset + 2 );
		segments.push( { marker: bytes[ offset + 1 ], payload: bytes.subarray( offset + 4, offset + 2 + length ) } );
		offset += 2 + length;
	}
	return segments;
}

/** The tags of IFD0 and the orientation value, read from a TIFF block. */
function readTiff( block: Buffer ): { tags: number[]; orientation?: number } {
	const little = block.toString( 'latin1', 0, 2 ) === 'II';
	const u16 = ( offset: number ) => ( little ? block.readUInt16LE( offset ) : block.readUInt16BE( offset ) );
	const ifd = little ? block.readUInt32LE( 4 ) : block.readUInt32BE( 4 );
	const tags = Array.from( { length: u16( ifd ) }, ( _, index ) => u16( ifd + 2 + index * 12 ) );
	const index = tags.indexOf( 0x0112 );
	return { tags, orientation: index < 0 ? undefined : u16( ifd + 2 + index * 12 + 8 ) };
}

function jpegExif( bytes: Buffer ): Buffer | undefined {
	return headerSegments( bytes ).find( ( { marker, payload } ) => marker === 0xe1 && payload.toString( 'latin1', 0, 6 ) === 'Exif\0\0' )?.payload.subarray( 6 );
}

function pngChunks( bytes: Buffer ): Array<{ type: string; data: Buffer; crcValid: boolean }> {
	const chunks: Array<{ type: string; data: Buffer; crcValid: boolean }> = [];
	for ( let offset = 8; offset < bytes.length; ) {
		const length = bytes.readUInt32BE( offset );
		const typeAndData = bytes.subarray( offset + 4, offset + 8 + length );
		chunks.push( {
			type: typeAndData.toString( 'latin1', 0, 4 ),
			data: typeAndData.subarray( 4 ),
			crcValid: crc32( typeAndData ) === bytes.readUInt32BE( offset + 8 + length ),
		} );
		offset += 12 + length;
	}
	return chunks;
}

function pngChunk( type: string, data: Buffer | string ): Buffer {
	const typeAndData = Buffer.concat( [ Buffer.from( type, 'latin1' ), Buffer.isBuffer( data ) ? data : Buffer.from( data, 'latin1' ) ] );
	const length = Buffer.alloc( 4 );
	length.writeUInt32BE( typeAndData.length - 4 );
	const crc = Buffer.alloc( 4 );
	crc.writeUInt32BE( crc32( typeAndData ) );
	return Buffer.concat( [ length, typeAndData, crc ] );
}

const PNG_SIGNATURE = Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] );
const IHDR = pngChunk( 'IHDR', Buffer.from( [ 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0 ] ) );
const IDAT = pngChunk( 'IDAT', Buffer.from( [ 0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1 ] ) );
const IEND = pngChunk( 'IEND', '' );

function png( ...chunks: Buffer[] ): Buffer {
	return Buffer.concat( [ PNG_SIGNATURE, IHDR, ...chunks, IDAT, IEND ] );
}

const strip = ( extension: 'jpg' | 'png', bytes: Buffer ) => Buffer.from( stripPhotoMetadata( extension, bytes ) ?? [] );

describe( 'stripPhotoMetadata for JPEG', () => {
	it( 'removes GPS, camera and comment data from a phone photo and keeps only its orientation', () => {
		const stripped = strip( 'jpg', PHOTO_JPEG );

		for ( const text of METADATA_TEXT ) {
			expect( stripped.includes( text ) ).toBe( false );
		}
		expect( readTiff( jpegExif( stripped )! ) ).toEqual( { tags: [ 0x0112 ], orientation: 6 } );
	} );

	it( 'leaves the image data of the photo byte for byte as it was', () => {
		const stripped = strip( 'jpg', PHOTO_JPEG );
		const scan = ( bytes: Buffer ) => bytes.subarray( bytes.indexOf( Buffer.from( [ 0xff, 0xda ] ) ) );

		expect( scan( stripped ).equals( scan( PHOTO_JPEG ) ) ).toBe( true );
		expect( headerSegments( stripped ).filter( ( { marker } ) => marker < 0xe0 ) ).toEqual( headerSegments( PHOTO_JPEG ).filter( ( { marker } ) => marker < 0xe0 ) );
	} );

	it( 'keeps JFIF, the colour profile and the Adobe colour transform, and drops every other application segment', () => {
		const kept = [ segment( 0xe0, 'JFIF\0\x01\x01' ), segment( 0xe2, 'ICC_PROFILE\0\x01\x01profile' ), segment( 0xee, 'Adobe\0\x64' ) ];
		const dropped = [
			segment( 0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>' ),
			// Multi-picture data points at further images, which are cut off with it.
			segment( 0xe2, 'MPF\0data' ),
			segment( 0xe3, 'vendor' ),
			segment( 0xed, 'Photoshop 3.0\0iptc' ),
			segment( 0xef, 'vendor' ),
			segment( 0xfe, 'comment' ),
		];

		const stripped = strip( 'jpg', jpeg( ...kept, ...dropped, segment( 0xdb, Buffer.alloc( 65 ) ) ) );

		expect( headerSegments( stripped ).map( ( { marker } ) => marker ) ).toEqual( [ 0xe0, 0xe2, 0xee, 0xdb ] );
		expect( stripped.includes( 'ICC_PROFILE' ) ).toBe( true );
	} );

	it.each( [ 'II', 'MM' ] as const )( 'reads the orientation in %s byte order', ( order ) => {
		const stripped = strip( 'jpg', jpeg( exifSegment( tiff( order, [ [ 0x010f, 7 ], [ 0x0112, 8 ] ] ) ) ) );

		expect( readTiff( jpegExif( stripped )! ) ).toEqual( { tags: [ 0x0112 ], orientation: 8 } );
	} );

	it( 'writes no EXIF at all when the photo is upright or says nothing about it', () => {
		for ( const exif of [ tiff( 'II', [ [ 0x0112, 1 ] ] ), tiff( 'MM', [ [ 0x010f, 7 ] ] ) ] ) {
			expect( jpegExif( strip( 'jpg', jpeg( exifSegment( exif ) ) ) ) ).toBeUndefined();
		}
	} );

	it( 'drops EXIF it cannot read, or an orientation out of range, instead of refusing the photo', () => {
		const pointingPastTheEnd = tiff( 'II', [ [ 0x0112, 6 ] ] );
		pointingPastTheEnd.writeUInt32LE( 4000, 4 );

		for ( const exif of [ pointingPastTheEnd, tiff( 'II', [ [ 0x0112, 9 ] ] ), Buffer.from( 'XX' ) ] ) {
			const stripped = stripPhotoMetadata( 'jpg', jpeg( exifSegment( exif ) ) );
			expect( stripped ).not.toBeNull();
			expect( jpegExif( Buffer.from( stripped! ) ) ).toBeUndefined();
		}
	} );

	it( 'drops metadata between the scans of a progressive photo and keeps the stuffed bytes and restart markers in a scan', () => {
		const progressive = Buffer.concat( [ SOI, segment( 0xdb, Buffer.alloc( 65 ) ), SCAN, segment( 0xfe, 'comment' ), segment( 0xc4, Buffer.alloc( 17 ) ), SCAN, EOI ] );

		const stripped = strip( 'jpg', progressive );

		expect( stripped.includes( 'comment' ) ).toBe( false );
		expect( stripped ).toEqual( Buffer.concat( [ SOI, segment( 0xdb, Buffer.alloc( 65 ) ), SCAN, segment( 0xc4, Buffer.alloc( 17 ) ), SCAN, EOI ] ) );
	} );

	// Phones append further images, such as an HDR gain map with its own EXIF, after the first one.
	it( 'cuts off everything after the end of the image', () => {
		const appended = jpeg( exifSegment( tiff( 'II', [ [ 0x8825, 1 ] ] ) ) );

		expect( strip( 'jpg', Buffer.concat( [ jpeg(), appended ] ) ) ).toEqual( jpeg() );
	} );

	// Image viewers show these photos, and the upload took them before the metadata was stripped.
	it( 'keeps a photo cut off in its image data, as an interrupted transfer leaves it', () => {
		const cut = PHOTO_JPEG.subarray( 0, PHOTO_JPEG.length - 40 );

		const stripped = stripPhotoMetadata( 'jpg', cut );

		expect( stripped ).not.toBeNull();
		expect( Buffer.from( stripped! ).includes( 'TestPhone' ) ).toBe( false );
	} );

	it( 'skips stray bytes between segments', () => {
		const padded = Buffer.concat( [ SOI, segment( 0xfe, 'comment' ), Buffer.from( [ 0, 0, 0x20 ] ), segment( 0xdb, Buffer.alloc( 65 ) ), SCAN, EOI ] );

		expect( strip( 'jpg', padded ) ).toEqual( jpeg( segment( 0xdb, Buffer.alloc( 65 ) ) ) );
	} );

	it( 'keeps restart and TEM markers that stand between segments', () => {
		const standalone = Buffer.from( [ 0xff, 0xd0, 0xff, 0x01 ] );

		const stripped = strip( 'jpg', jpeg( segment( 0xdb, Buffer.alloc( 65 ) ), standalone, segment( 0xfe, 'comment' ) ) );

		expect( stripped ).toEqual( jpeg( segment( 0xdb, Buffer.alloc( 65 ) ), standalone ) );
	} );

	it( 'refuses a JPEG whose structure does not read', () => {
		const truncated = jpeg( segment( 0xe0, 'JFIF\0' ) ).subarray( 0, 8 );
		const lengthPastTheEnd = Buffer.concat( [ SOI, Buffer.from( [ 0xff, 0xe1, 0xff, 0xff ] ), Buffer.alloc( 8 ) ] );
		const noScan = Buffer.concat( [ SOI, segment( 0xdb, Buffer.alloc( 65 ) ), EOI ] );

		for ( const bytes of [ truncated, lengthPastTheEnd, noScan, Buffer.from( 'not a jpeg' ) ] ) {
			expect( stripPhotoMetadata( 'jpg', bytes ) ).toBeNull();
		}
	} );

	it( 'treats jpeg like jpg', () => {
		expect( stripPhotoMetadata( 'jpeg', PHOTO_JPEG ) ).toEqual( stripPhotoMetadata( 'jpg', PHOTO_JPEG ) );
	} );
} );

describe( 'stripPhotoMetadata for PNG', () => {
	it( 'removes GPS, camera and XMP data from a photo and keeps only its orientation', () => {
		const stripped = strip( 'png', PHOTO_PNG );
		const chunks = pngChunks( stripped );

		for ( const text of METADATA_TEXT ) {
			expect( stripped.includes( text ) ).toBe( false );
		}
		const exif = chunks.find( ( { type } ) => type === 'eXIf' );
		expect( readTiff( exif!.data ) ).toEqual( { tags: [ 0x0112 ], orientation: 6 } );
		expect( chunks.every( ( { crcValid } ) => crcValid ) ).toBe( true );
	} );

	it( 'leaves the image data of the photo byte for byte as it was', () => {
		const data = ( bytes: Buffer ) => pngChunks( bytes ).filter( ( { type } ) => type === 'IDAT' ).map( ( { data: idat } ) => idat );

		expect( data( strip( 'png', PHOTO_PNG ) ) ).toEqual( data( PHOTO_PNG ) );
	} );

	it( 'drops text, time and EXIF chunks and keeps the ones that describe the colours', () => {
		const kept = [ pngChunk( 'iCCP', 'icc\0\0profile' ), pngChunk( 'gAMA', Buffer.alloc( 4 ) ), pngChunk( 'pHYs', Buffer.alloc( 9 ) ) ];
		const dropped = [ pngChunk( 'tEXt', 'Author\0Me' ), pngChunk( 'zTXt', 'Comment\0\0x' ), pngChunk( 'iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<x/>' ), pngChunk( 'tIME', Buffer.alloc( 7 ) ), pngChunk( 'eXIf', tiff( 'MM', [ [ 0x010f, 7 ] ] ) ) ];

		const stripped = strip( 'png', png( ...kept, ...dropped ) );

		expect( pngChunks( stripped ).map( ( { type } ) => type ) ).toEqual( [ 'IHDR', 'iCCP', 'gAMA', 'pHYs', 'IDAT', 'IEND' ] );
	} );

	// Tools keep adding metadata chunks, such as C2PA provenance (`caBX`) that can hold a location.
	it( 'keeps only chunks that describe the image and drops any other', () => {
		const kept = [ 'tRNS', 'sBIT', 'cHRM', 'sRGB', 'cICP', 'bKGD', 'acTL', 'fcTL', 'fdAT' ].map( ( type ) => pngChunk( type, Buffer.alloc( 4 ) ) );
		const dropped = [ 'caBX', 'prVt', 'iDOT', 'vpAg' ].map( ( type ) => pngChunk( type, 'lat=47.42;lon=9.37' ) );

		const stripped = strip( 'png', png( ...dropped, ...kept ) );

		expect( pngChunks( stripped ).map( ( { type } ) => type ) ).toEqual( [ 'IHDR', 'tRNS', 'sBIT', 'cHRM', 'sRGB', 'cICP', 'bKGD', 'acTL', 'fcTL', 'fdAT', 'IDAT', 'IEND' ] );
		expect( stripped.includes( 'lat=' ) ).toBe( false );
	} );

	it( 'cuts off everything after the end of the image', () => {
		expect( strip( 'png', Buffer.concat( [ png(), pngChunk( 'tEXt', 'GPS\0here' ) ] ) ) ).toEqual( png() );
	} );

	it( 'refuses a PNG whose chunks do not read', () => {
		const noEnd = Buffer.concat( [ PNG_SIGNATURE, IHDR, IDAT ] );
		const lengthPastTheEnd = Buffer.concat( [ PNG_SIGNATURE, IHDR, Buffer.from( [ 0, 0, 0xff, 0xff ] ), Buffer.from( 'tEXt' ), Buffer.alloc( 8 ) ] );

		for ( const bytes of [ noEnd, lengthPastTheEnd, PNG_SIGNATURE, Buffer.from( 'not a png' ) ] ) {
			expect( stripPhotoMetadata( 'png', bytes ) ).toBeNull();
		}
	} );
} );

describe( 'stripPhotoMetadata for other files', () => {
	it( 'returns documents unchanged, since they are no photos', () => {
		const pdf = Buffer.from( '%PDF-1.7\n/Author (Me)' );

		expect( stripPhotoMetadata( 'pdf', pdf ) ).toBe( pdf );
	} );
} );
