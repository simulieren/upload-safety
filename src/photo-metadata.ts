/**
 * Removes what a photo tells about where, when and with what it was taken (EXIF with GPS,
 * XMP, IPTC, comments) without decoding it: JPEG segments and PNG and WebP chunks are dropped
 * whole, so the image data stays byte for byte. Only the orientation is written back, since
 * without it a portrait photo from a phone opens on its side. HEIF images are handled in
 * `heif-metadata.ts`.
 */

import { crc32 } from 'node:zlib';

import { stripHeif } from './heif-metadata.js';
import { checkBmp, checkIco, checkOgg, stripFlac, stripGif, stripMp3, stripWav } from './media-formats.js';
import { stripIsoMedia, stripWebm } from './video-formats.js';

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

const WEBP_HEADER_SIZE = 12;
const RIFF_CHUNK_HEADER_SIZE = 8;
// The chunks that draw the image, as for PNG; EXIF, XMP and any other chunk may carry metadata.
const WEBP_IMAGE_CHUNKS = new Set( [ 'VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP' ] );
const WEBP_BITSTREAM_CHUNKS = new Set( [ 'VP8 ', 'VP8L', 'ANMF' ] );
/** VP8X flags of the metadata chunks, in the first byte of its payload. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

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

function riffChunk( type: string, payload: Buffer ): Buffer {
	const chunk = Buffer.alloc( RIFF_CHUNK_HEADER_SIZE + payload.length + ( payload.length & 1 ) );
	chunk.write( type, 0, 'latin1' );
	chunk.writeUInt32LE( payload.length, 4 );
	payload.copy( chunk, RIFF_CHUNK_HEADER_SIZE );
	return chunk;
}

/**
 * The WebP without metadata chunks, or null when its chunks do not read or none draws the image.
 * Bytes after the RIFF size are cut off. The orientation needs the extended format (VP8X) to be
 * written back, as a simple WebP cannot hold EXIF at all.
 */
function stripWebp( bytes: Buffer ): Buffer | null {
	if ( bytes.length < WEBP_HEADER_SIZE || bytes.toString( 'latin1', 0, 4 ) !== 'RIFF' || bytes.toString( 'latin1', 8, 12 ) !== 'WEBP' ) {
		return null;
	}
	const end = RIFF_CHUNK_HEADER_SIZE + bytes.readUInt32LE( 4 );
	if ( end > bytes.length ) {
		return null;
	}
	const chunks: Buffer[] = [];
	let extended: { index: number; flags: Buffer } | undefined;
	let orientation: number | undefined;
	let drawn = false;
	for ( let offset = WEBP_HEADER_SIZE; offset < end; ) {
		const dataStart = offset + RIFF_CHUNK_HEADER_SIZE;
		const dataEnd = dataStart + ( dataStart <= end ? bytes.readUInt32LE( offset + 4 ) : 0 );
		if ( dataStart > end || dataEnd > end ) {
			return null;
		}
		const type = bytes.toString( 'latin1', offset, offset + 4 );
		const payload = bytes.subarray( dataStart, dataEnd );
		if ( type === 'EXIF' ) {
			// The format wants the TIFF block alone; some writers put the JPEG `Exif` header first.
			orientation ??= readOrientation( payload.subarray( 0, EXIF_HEADER.length ).equals( EXIF_HEADER ) ? payload.subarray( EXIF_HEADER.length ) : payload );
		}
		if ( WEBP_IMAGE_CHUNKS.has( type ) ) {
			if ( type === 'VP8X' ) {
				extended ??= { index: chunks.length, flags: Buffer.from( payload ) };
			}
			chunks.push( riffChunk( type, payload ) );
			drawn ||= WEBP_BITSTREAM_CHUNKS.has( type );
		}
		offset = dataEnd + ( ( dataEnd - dataStart ) & 1 );
	}
	if ( ! drawn ) {
		return null;
	}
	if ( extended?.flags.length ) {
		const { index, flags } = extended;
		const writesOrientation = orientation !== undefined && orientation !== UPRIGHT;
		flags[ 0 ] = ( flags[ 0 ] & ~( VP8X_EXIF | VP8X_XMP ) ) | ( writesOrientation ? VP8X_EXIF : 0 );
		chunks[ index ] = riffChunk( 'VP8X', flags );
		if ( writesOrientation ) {
			// EXIF goes after the image data.
			chunks.push( riffChunk( 'EXIF', orientationTiff( orientation! ) ) );
		}
	}
	const header = Buffer.alloc( WEBP_HEADER_SIZE );
	header.write( 'RIFF', 0, 'latin1' );
	header.writeUInt32LE( 4 + chunks.reduce( ( sum, chunk ) => sum + chunk.length, 0 ), 4 );
	header.write( 'WEBP', 8, 'latin1' );
	return Buffer.concat( [ header, ...chunks ] );
}

export const MP4_BRANDS = [ 'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'msdh', 'msix' ];
// A video renamed to .m4a passes as well; both are media and neither runs.
export const M4A_BRANDS = [ 'M4A ', 'M4B ', 'mp42', 'isom', 'iso2' ];

/**
 * The bytes to store for an upload: an image, audio or video file without its metadata, any
 * other file unchanged; null for a media file whose structure does not read.
 */
export function stripPhotoMetadata( extension: AllowedExtension, bytes: Uint8Array ): Uint8Array | null {
	const content = Buffer.from( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	switch ( extension ) {
		case 'jpg':
		case 'jpeg':
			return stripJpeg( content );
		case 'png':
			return stripPng( content );
		case 'webp':
			return stripWebp( content );
		case 'heic':
		case 'heif':
		case 'avif':
			return stripHeif( content );
		case 'gif':
			return stripGif( content );
		case 'bmp':
			return checkBmp( content );
		case 'ico':
			return checkIco( content );
		case 'mp3':
			return stripMp3( content );
		case 'wav':
			return stripWav( content );
		case 'flac':
			return stripFlac( content );
		case 'ogg':
			return checkOgg( content );
		case 'mp4':
			return stripIsoMedia( content, MP4_BRANDS );
		case 'm4a':
			return stripIsoMedia( content, M4A_BRANDS );
		case 'mov':
			return stripIsoMedia( content, null );
		case 'webm':
			return stripWebm( content );
		default:
			return bytes;
	}
}
