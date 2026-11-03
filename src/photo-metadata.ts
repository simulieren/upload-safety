/**
 * Removes what a photo tells about where, when and with what it was taken (EXIF with GPS,
 * XMP, IPTC, comments) without decoding it: JPEG segments and PNG chunks are dropped whole,
 * so the image data stays byte for byte. Only the orientation is written back, since without
 * it a portrait photo from a phone opens on its side.
 */

import { crc32 } from 'node:zlib';

import type { AllowedExtension } from './upload-allowlist.js';

const ORIENTATION_TAG = 0x0112;
const SHORT_TYPE = 3;
const UPRIGHT = 1;
const MAX_ORIENTATION = 8;

const JPEG_START = 0xd8;
const JPEG_END = 0xd9;
const START_OF_SCAN = 0xda;
// Markers without a length: TEM and the restart markers RST0 to RST7.
const TEMPORARY = 0x01;
const RESTART_FIRST = 0xd0;
const RESTART_LAST = 0xd7;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const APP15 = 0xef;
const COMMENT = 0xfe;
const EXIF_HEADER = Buffer.from( 'Exif\0\0', 'latin1' );
const JFIF_HEADERS = [ 'JFIF\0', 'JFXX\0' ];
const ICC_HEADER = 'ICC_PROFILE\0';

const PNG_SIGNATURE = Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] );
// The chunks that draw the image (also as APNG), as the JPEG side keeps only known segments; any other,
// standard or not, may carry metadata.
const PNG_IMAGE_CHUNKS = new Set( [
	'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI',
	'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT',
] );

/** The orientation (1 to 8) in IFD0 of a TIFF block, or undefined when there is none or it does not read. */
function readOrientation( tiff: Buffer ): number | undefined {
	const order = tiff.toString( 'latin1', 0, 2 );
	if ( tiff.length < 8 || ( order !== 'II' && order !== 'MM' ) ) {
		return undefined;
	}
	const little = order === 'II';
	const u16 = ( offset: number ) => ( little ? tiff.readUInt16LE( offset ) : tiff.readUInt16BE( offset ) );
	const ifd = little ? tiff.readUInt32LE( 4 ) : tiff.readUInt32BE( 4 );
	if ( u16( 2 ) !== 42 || ifd + 2 > tiff.length ) {
		return undefined;
	}
	for ( let index = 0; index < u16( ifd ); index++ ) {
		const entry = ifd + 2 + index * 12;
		if ( entry + 12 > tiff.length ) {
			return undefined;
		}
		if ( u16( entry ) === ORIENTATION_TAG && u16( entry + 2 ) === SHORT_TYPE ) {
			const orientation = u16( entry + 8 );
			return orientation >= UPRIGHT && orientation <= MAX_ORIENTATION ? orientation : undefined;
		}
	}
	return undefined;
}

/** A little-endian TIFF block whose IFD0 holds the orientation and nothing else. */
function orientationTiff( orientation: number ): Buffer {
	const tiff = Buffer.alloc( 26 );
	tiff.write( 'II', 0, 'latin1' );
	tiff.writeUInt16LE( 42, 2 );
	tiff.writeUInt32LE( 8, 4 );
	tiff.writeUInt16LE( 1, 8 );
	tiff.writeUInt16LE( ORIENTATION_TAG, 10 );
	tiff.writeUInt16LE( SHORT_TYPE, 12 );
	tiff.writeUInt32LE( 1, 14 );
	tiff.writeUInt16LE( orientation, 18 );
	return tiff;
}

/** JFIF, the colour profile and Adobe's colour transform (CMYK needs it); every other application segment carries metadata. */
function keepsJpegSegment( marker: number, payload: Buffer ): boolean {
	if ( marker === COMMENT ) {
		return false;
	}
	if ( marker < APP0 || marker > APP15 ) {
		return true;
	}
	if ( marker === APP0 ) {
		return JFIF_HEADERS.includes( payload.toString( 'latin1', 0, 5 ) );
	}
	return ( marker === APP2 && payload.toString( 'latin1', 0, ICC_HEADER.length ) === ICC_HEADER ) || marker === APP14;
}

/**
 * Where the entropy-coded data after a scan header ends: at the first marker, where a 0xFF
 * is neither stuffed (0xFF00), a restart marker (0xFFD0 to 0xFFD7) nor fill before a marker.
 */
function findScanEnd( bytes: Buffer, from: number ): number {
	for ( let offset = from; offset + 1 < bytes.length; offset++ ) {
		const next = bytes[ offset + 1 ];
		if ( bytes[ offset ] === 0xff && next !== 0x00 && next !== 0xff && ( next < RESTART_FIRST || next > RESTART_LAST ) ) {
			return offset;
		}
	}
	return bytes.length;
}

function jpegSegment( marker: number, payload: Buffer ): Buffer {
	const header = Buffer.from( [ 0xff, marker, 0, 0 ] );
	header.writeUInt16BE( payload.length + 2, 2 );
	return Buffer.concat( [ header, payload ] );
}

/**
 * The JPEG up to its end marker without metadata segments, or null when its structure does not read
 * before the image data. Past that it is as lenient as image viewers: a photo cut off in transfer keeps
 * what arrived, stray bytes between segments are skipped.
 */
function stripJpeg( bytes: Buffer ): Buffer | null {
	if ( bytes.length < 4 || bytes[ 0 ] !== 0xff || bytes[ 1 ] !== JPEG_START ) {
		return null;
	}
	const parts: Buffer[] = [ bytes.subarray( 0, 2 ) ];
	// EXIF follows JFIF when there is one, as JFIF must come first.
	let exifIndex = 1;
	let orientation: number | undefined;
	let scanned = false;
	const finish = () => {
		if ( orientation !== undefined && orientation !== UPRIGHT ) {
			parts.splice( exifIndex, 0, jpegSegment( APP1, Buffer.concat( [ EXIF_HEADER, orientationTiff( orientation ) ] ) ) );
		}
		return Buffer.concat( parts );
	};
	let offset = 2;
	while ( offset + 1 < bytes.length ) {
		const marker = bytes[ offset + 1 ];
		if ( bytes[ offset ] !== 0xff || marker === 0xff ) {
			offset++;
			continue;
		}
		if ( marker === JPEG_END ) {
			if ( ! scanned ) {
				return null;
			}
			parts.push( bytes.subarray( offset, offset + 2 ) );
			// Anything after the end, such as further images with their own EXIF, is cut off.
			return finish();
		}
		if ( marker === TEMPORARY || ( marker >= RESTART_FIRST && marker <= RESTART_LAST ) ) {
			parts.push( bytes.subarray( offset, offset + 2 ) );
			offset += 2;
			continue;
		}
		const length = offset + 4 <= bytes.length ? bytes.readUInt16BE( offset + 2 ) : 0;
		const end = offset + 2 + length;
		if ( length < 2 || end > bytes.length ) {
			return scanned ? finish() : null;
		}
		const payload = bytes.subarray( offset + 4, end );
		if ( marker === APP1 && payload.subarray( 0, EXIF_HEADER.length ).equals( EXIF_HEADER ) ) {
			orientation ??= readOrientation( payload.subarray( EXIF_HEADER.length ) );
		}
		if ( keepsJpegSegment( marker, payload ) ) {
			parts.push( bytes.subarray( offset, end ) );
			if ( marker === APP0 && parts.length === 2 ) {
				exifIndex = 2;
			}
		}
		offset = end;
		if ( marker === START_OF_SCAN ) {
			scanned = true;
			const scanEnd = findScanEnd( bytes, offset );
			parts.push( bytes.subarray( offset, scanEnd ) );
			offset = scanEnd;
		}
	}
	return scanned ? finish() : null;
}

function pngChunk( type: string, data: Buffer ): Buffer {
	const typeAndData = Buffer.concat( [ Buffer.from( type, 'latin1' ), data ] );
	const chunk = Buffer.alloc( typeAndData.length + 8 );
	chunk.writeUInt32BE( data.length, 0 );
	typeAndData.copy( chunk, 4 );
	chunk.writeUInt32BE( crc32( typeAndData ), chunk.length - 4 );
	return chunk;
}

/** The PNG up to its end chunk without metadata chunks, or null when its chunks do not read. */
function stripPng( bytes: Buffer ): Buffer | null {
	if ( ! bytes.subarray( 0, PNG_SIGNATURE.length ).equals( PNG_SIGNATURE ) ) {
		return null;
	}
	const parts: Buffer[] = [ PNG_SIGNATURE ];
	// eXIf must come before the image data; right after the header is always early enough.
	let exifIndex = 1;
	let orientation: number | undefined;
	for ( let offset = PNG_SIGNATURE.length; offset + 12 <= bytes.length; ) {
		const length = bytes.readUInt32BE( offset );
		const end = offset + 12 + length;
		if ( end > bytes.length ) {
			return null;
		}
		const type = bytes.toString( 'latin1', offset + 4, offset + 8 );
		if ( type === 'eXIf' ) {
			orientation ??= readOrientation( bytes.subarray( offset + 8, offset + 8 + length ) );
		}
		if ( PNG_IMAGE_CHUNKS.has( type ) ) {
			parts.push( bytes.subarray( offset, end ) );
		}
		if ( type === 'IHDR' ) {
			exifIndex = parts.length;
		}
		if ( type === 'IEND' ) {
			if ( orientation !== undefined && orientation !== UPRIGHT ) {
				parts.splice( exifIndex, 0, pngChunk( 'eXIf', orientationTiff( orientation ) ) );
			}
			return Buffer.concat( parts );
		}
		offset = end;
	}
	return null;
}

/**
 * The bytes to store for an upload: a JPEG or PNG without its metadata, any other file
 * unchanged; null for a photo whose structure does not read.
 */
export function stripPhotoMetadata( extension: AllowedExtension, bytes: Uint8Array ): Uint8Array | null {
	const content = Buffer.from( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	switch ( extension ) {
		case 'jpg':
		case 'jpeg':
			return stripJpeg( content );
		case 'png':
			return stripPng( content );
		default:
			return bytes;
	}
}
