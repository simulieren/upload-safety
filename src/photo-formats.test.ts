import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stripPhotoMetadata } from './photo-metadata.js';
import { inspectFileContent } from './upload-allowlist.js';

// Made from photo-gps.jpg (GPS, make `TestPhone`, orientation 6): the WebP by cwebp with EXIF and an
// XMP packet added by webpmux, the HEIC by macOS ImageIO, the AVIF by avifenc with EXIF and XMP.
const fixture = ( name: string ) => readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) );
const METADATA_TEXT = [ 'TestPhone', 'GPSLatitude', '47,25' ];
const holdsMetadata = ( bytes: Uint8Array ) => METADATA_TEXT.some( ( text ) => Buffer.from( bytes ).includes( text ) );

const box = ( type: string, ...payload: Buffer[] ) => {
	const body = Buffer.concat( payload );
	const header = Buffer.alloc( 8 );
	header.writeUInt32BE( 8 + body.length, 0 );
	header.write( type, 4, 'latin1' );
	return Buffer.concat( [ header, body ] );
};
const fullBox = ( type: string, version: number, ...payload: Buffer[] ) => box( type, Buffer.from( [ version, 0, 0, 0 ] ), ...payload );
const u16 = ( value: number ) => Buffer.from( [ value >> 8, value & 0xff ] );
const u32 = ( value: number ) => {
	const buffer = Buffer.alloc( 4 );
	buffer.writeUInt32BE( value );
	return buffer;
};

/** A HEIF file whose items lie in its `idat` box (construction method 1), or as `method` says. */
function heif( items: Array<{ type: string; data: string; contentType?: string }>, { method = 1, extra = [] as Buffer[] } = {} ) {
	const data = items.map( ( item ) => Buffer.from( item.data, 'latin1' ) );
	const entries = items.map( ( item, index ) => fullBox( 'infe', 2, u16( index + 1 ), u16( 0 ), Buffer.from( `${ item.type }\0${ item.contentType ? `${ item.contentType }\0` : '' }`, 'latin1' ) ) );
	let offset = 0;
	const locations = items.map( ( _, index ) => {
		const location = Buffer.concat( [ u16( index + 1 ), u16( method ), u16( 0 ), u16( 1 ), u32( offset ), u32( data[ index ].length ) ] );
		offset += data[ index ].length;
		return location;
	} );
	const meta = fullBox( 'meta', 0,
		fullBox( 'hdlr', 0, u32( 0 ), Buffer.from( 'pict' ), Buffer.alloc( 13 ) ),
		fullBox( 'iinf', 0, u16( items.length ), ...entries ),
		fullBox( 'iloc', 1, u16( 0x4400 ), u16( items.length ), ...locations ),
		box( 'idat', ...data ) );
	return Buffer.concat( [ box( 'ftyp', Buffer.from( 'heic\0\0\0\0mif1heic' ) ), meta, ...extra ] );
}

describe( 'WebP', () => {
	const photo = fixture( 'photo-gps.webp' );

	it( 'removes EXIF and XMP and keeps only the orientation, flagged in VP8X', () => {
		expect( holdsMetadata( photo ) ).toBe( true );
		const stripped = Buffer.from( stripPhotoMetadata( 'webp', photo )! );
		expect( holdsMetadata( stripped ) ).toBe( false );
		expect( stripped.includes( 'XMP ' ) ).toBe( false );
		const exif = stripped.indexOf( 'EXIF' );
		// The orientation tag (0x0112) with value 6 in a little-endian IFD0.
		expect( stripped.subarray( exif + 8 + 10, exif + 8 + 20 ).toString( 'hex' ) ).toBe( '12010300010000000600' );
		expect( stripped[ 20 ] & 0x0c ).toBe( 0x08 );
		expect( stripped.readUInt32LE( 4 ) ).toBe( stripped.length - 8 );
		expect( inspectFileContent( 'webp', stripped ) ).toBe( 'valid' );
	} );

	it( 'keeps the image data byte for byte', () => {
		const stripped = Buffer.from( stripPhotoMetadata( 'webp', photo )! );
		const image = photo.subarray( photo.indexOf( 'VP8 ' ), photo.indexOf( 'VP8 ' ) + 8 + photo.readUInt32LE( photo.indexOf( 'VP8 ' ) + 4 ) );
		expect( stripped.includes( image ) ).toBe( true );
	} );

	it( 'refuses a WebP whose chunks do not read or that draws nothing', () => {
		expect( stripPhotoMetadata( 'webp', photo.subarray( 0, photo.length - 10 ) ) ).toBeNull();
		const header = Buffer.from( 'RIFF\x04\x00\x00\x00WEBP', 'latin1' );
		expect( stripPhotoMetadata( 'webp', header ) ).toBeNull();
		expect( inspectFileContent( 'webp', fixture( 'photo-gps.png' ) ) ).toBe( 'mismatch' );
	} );
} );

describe( 'HEIF', () => {
	it.each( [ [ 'heic', 'photo-gps.heic' ], [ 'avif', 'photo-gps.avif' ] ] as const )( 'overwrites EXIF and XMP of %s in place', ( extension, name ) => {
		const photo = fixture( name );
		expect( holdsMetadata( photo ) ).toBe( true );
		expect( inspectFileContent( extension, photo ) ).toBe( 'valid' );
		const stripped = Buffer.from( stripPhotoMetadata( extension, photo )! );
		expect( stripped.length ).toBe( photo.length );
		expect( holdsMetadata( stripped ) ).toBe( false );
	} );

	it( 'finds the items in the idat box and by their MIME type', () => {
		const photo = heif( [
			{ type: 'Exif', data: '\0\0\0\0MM\0*\0\0\0\x08GPSLatitude' },
			{ type: 'mime', data: '<x:xmpmeta>47,25</x:xmpmeta>', contentType: 'application/rdf+xml' },
			{ type: 'mime', data: 'keep me', contentType: 'text/plain' },
		] );
		const stripped = Buffer.from( stripPhotoMetadata( 'heic', photo )! );
		expect( holdsMetadata( stripped ) ).toBe( false );
		expect( stripped.includes( 'keep me' ) ).toBe( true );
		expect( stripped.includes( Buffer.from( '000000004d4d002a000000080000', 'hex' ) ) ).toBe( true );
	} );

	it( 'refuses an image sequence, items it cannot locate and boxes that do not read', () => {
		const exif = [ { type: 'Exif', data: 'GPSLatitude' } ];
		expect( stripPhotoMetadata( 'heic', heif( exif ) ) ).not.toBeNull();
		expect( stripPhotoMetadata( 'heic', heif( exif, { extra: [ box( 'moov' ) ] } ) ) ).toBeNull();
		// Construction method 2 takes the data from other items.
		expect( stripPhotoMetadata( 'heic', heif( exif, { method: 2 } ) ) ).toBeNull();
		const photo = heif( exif );
		expect( stripPhotoMetadata( 'heic', photo.subarray( 0, photo.length - 4 ) ) ).toBeNull();
	} );

	it( 'takes a file by its brands, not only by its signature', () => {
		const avif = fixture( 'photo-gps.avif' );
		expect( inspectFileContent( 'avif', avif ) ).toBe( 'valid' );
		expect( inspectFileContent( 'heic', avif ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'avif', fixture( 'photo-gps.heic' ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'heif', fixture( 'photo-gps.heic' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'heic', Buffer.from( '\0\0\0\x10ftypisom\0\0\0\0', 'latin1' ) ) ).toBe( 'mismatch' );
	} );
} );
