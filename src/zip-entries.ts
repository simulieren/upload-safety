/**
 * Reads the entry list of a ZIP archive from its central directory and checks
 * each entry's local header against it, without decompressing anything.
 * Returns null for anything malformed, encrypted, oversized or outside the
 * plain (non-ZIP64, single-disk, stored or deflated) format Office files use.
 */

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
	name: string;
	/** Compression method: 0 stored, 8 deflated. */
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	/** Where the entry's (compressed) data starts, past its local header. */
	dataOffset: number;
}

/** Upper bounds that keep a crafted archive from passing as a document. */
export const MAX_ZIP_ENTRIES = 2000;
// Keep within clamd's MaxScanSize (total) and MaxFileSize (per entry): it reports
// anything past them as clean, so change these together with the clamd config.
export const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;
const ENCRYPTED_FLAG = 0x0001;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const DATA_DESCRIPTOR_SIZE = 12;
const UTF8_NAME_FLAG = 0x0800;
const STORED = 0;
const DEFLATED = 8;

function findEndOfCentralDirectory( content: Buffer ): number {
	const lowest = Math.max( 0, content.length - EOCD_SIZE - MAX_COMMENT_LENGTH );
	for ( let offset = content.length - EOCD_SIZE; offset >= lowest; offset-- ) {
		// The comment must run exactly to the end, so a stray signature in it does not count.
		if ( content.readUInt32LE( offset ) === EOCD_SIGNATURE &&
			offset + EOCD_SIZE + content.readUInt16LE( offset + 20 ) === content.length ) {
			return offset;
		}
	}
	return -1;
}

/** The central directory's view of an entry, which its local header must repeat. */
interface CentralHeader extends Omit<ZipEntry, 'dataOffset'> {
	flags: number;
	crc: number;
}

/**
 * Where an entry's data starts and its bytes end, or null unless its local
 * header (and data descriptor, with bit 3) agrees with the central one.
 */
function findEntrySpan( content: Buffer, entry: CentralHeader, nameBytes: Buffer, directoryOffset: number ): { dataStart: number; end: number } | null {
	const offset = entry.localHeaderOffset;
	if ( offset + LOCAL_HEADER_SIZE > directoryOffset || content.readUInt32LE( offset ) !== LOCAL_HEADER_SIGNATURE ||
		content.readUInt16LE( offset + 6 ) !== entry.flags || content.readUInt16LE( offset + 8 ) !== entry.method ) {
		return null;
	}
	const nameStart = offset + LOCAL_HEADER_SIZE;
	const nameLength = content.readUInt16LE( offset + 26 );
	const dataStart = nameStart + nameLength + content.readUInt16LE( offset + 28 );
	const dataEnd = dataStart + entry.compressedSize;
	if ( dataEnd > directoryOffset || ! content.subarray( nameStart, nameStart + nameLength ).equals( nameBytes ) ) {
		return null;
	}

	const central = [ entry.crc, entry.compressedSize, entry.uncompressedSize ];
	const local = [ content.readUInt32LE( offset + 14 ), content.readUInt32LE( offset + 18 ), content.readUInt32LE( offset + 22 ) ];
	if ( ! ( entry.flags & DATA_DESCRIPTOR_FLAG ) ) {
		return local.every( ( value, index ) => value === central[ index ] ) ? { dataStart, end: dataEnd } : null;
	}

	// With bit 3 the local fields may be zero; the descriptor after the data then carries them.
	if ( ! local.every( ( value, index ) => value === 0 || value === central[ index ] ) ) {
		return null;
	}
	const descriptor = dataEnd + 4 <= directoryOffset && content.readUInt32LE( dataEnd ) === DATA_DESCRIPTOR_SIGNATURE ? dataEnd + 4 : dataEnd;
	const end = descriptor + DATA_DESCRIPTOR_SIZE;
	if ( end > directoryOffset ||
		! central.every( ( value, index ) => content.readUInt32LE( descriptor + index * 4 ) === value ) ) {
		return null;
	}
	return { dataStart, end };
}

// Windows unpackers also take `\` for a separator and `C:` for a drive.
const ROOTED_NAME = /^(?:[/\\]|[a-z]:)/i;

function isSafeName( name: string ): boolean {
	return name.length > 0 && ! ROOTED_NAME.test( name ) && ! name.includes( '\0' ) && ! name.split( /[/\\]/ ).includes( '..' );
}

export function readZipEntries( content: Buffer ): ZipEntry[] | null {
	const eocd = findEndOfCentralDirectory( content );
	if ( eocd < 0 ) {
		return null;
	}

	const disk = content.readUInt16LE( eocd + 4 );
	const directoryDisk = content.readUInt16LE( eocd + 6 );
	const entriesOnDisk = content.readUInt16LE( eocd + 8 );
	const entryCount = content.readUInt16LE( eocd + 10 );
	const directorySize = content.readUInt32LE( eocd + 12 );
	const directoryOffset = content.readUInt32LE( eocd + 16 );
	// ZIP64 marks these fields with all ones; spanned archives use other disks.
	if ( disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff ||
		directorySize === 0xffffffff || directoryOffset === 0xffffffff ) {
		return null;
	}
	if ( entryCount === 0 || entryCount > MAX_ZIP_ENTRIES ) {
		return null;
	}
	const directoryEnd = directoryOffset + directorySize;
	if ( directoryEnd > eocd ) {
		return null;
	}

	const entries: ZipEntry[] = [];
	const spans: Array<{ start: number; end: number }> = [];
	const names = new Set<string>();
	let totalSize = 0;
	let position = directoryOffset;
	for ( let index = 0; index < entryCount; index++ ) {
		if ( position + CENTRAL_HEADER_SIZE > directoryEnd || content.readUInt32LE( position ) !== CENTRAL_HEADER_SIGNATURE ) {
			return null;
		}
		const flags = content.readUInt16LE( position + 8 );
		const method = content.readUInt16LE( position + 10 );
		const crc = content.readUInt32LE( position + 16 );
		const compressedSize = content.readUInt32LE( position + 20 );
		const uncompressedSize = content.readUInt32LE( position + 24 );
		const nameLength = content.readUInt16LE( position + 28 );
		const next = position + CENTRAL_HEADER_SIZE + nameLength + content.readUInt16LE( position + 30 ) + content.readUInt16LE( position + 32 );
		const localHeaderOffset = content.readUInt32LE( position + 42 );
		if ( next > directoryEnd || localHeaderOffset >= directoryOffset ||
			flags & ENCRYPTED_FLAG || ( method !== STORED && method !== DEFLATED ) ||
			compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff ) {
			return null;
		}

		const nameStart = position + CENTRAL_HEADER_SIZE;
		const nameBytes = content.subarray( nameStart, nameStart + nameLength );
		const name = nameBytes.toString( flags & UTF8_NAME_FLAG ? 'utf8' : 'latin1' );
		// A second entry of the same name could hide behind the one a check looked at.
		if ( ! isSafeName( name ) || names.has( name.toLowerCase() ) ) {
			return null;
		}
		totalSize += uncompressedSize;
		if ( uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES || totalSize > MAX_ZIP_UNCOMPRESSED_BYTES ) {
			return null;
		}

		const span = findEntrySpan( content, {
			name, method, compressedSize, uncompressedSize, localHeaderOffset, flags, crc,
		}, nameBytes, directoryOffset );
		if ( ! span ) {
			return null;
		}

		names.add( name.toLowerCase() );
		entries.push( {
			name, method, compressedSize, uncompressedSize, localHeaderOffset, dataOffset: span.dataStart,
		} );
		spans.push( { start: localHeaderOffset, end: span.end } );
		position = next;
	}
	if ( position !== directoryEnd ) {
		return null;
	}

	// Shared or unlisted bytes could show a check one thing and an unpacker another.
	spans.sort( ( a, b ) => a.start - b.start );
	let covered = 0;
	for ( const span of spans ) {
		if ( span.start !== covered ) {
			return null;
		}
		covered = span.end;
	}
	return covered === directoryOffset ? entries : null;
}

/**
 * The uncompressed bytes of an entry from {@link readZipEntries}, or null when
 * they do not inflate or exceed `maxBytes`.
 */
export function readZipEntryData( content: Buffer, entry: ZipEntry, maxBytes: number ): Buffer | null {
	if ( entry.uncompressedSize > maxBytes ) {
		return null;
	}
	const data = content.subarray( entry.dataOffset, entry.dataOffset + entry.compressedSize );
	if ( entry.method === STORED ) {
		return data.length <= maxBytes ? data : null;
	}
	try {
		return inflateRawSync( data, { maxOutputLength: maxBytes } );
	} catch {
		return null;
	}
}
