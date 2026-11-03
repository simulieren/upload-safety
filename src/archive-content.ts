/**
 * Reads ZIP, TAR and gzip archives as containers and hands every regular file in them to a
 * caller-supplied check. Anything the reader cannot follow exactly (links, devices, unsafe names,
 * extensions it does not model, oversized content) fails closed as 'mismatch'.
 */

import { gunzipSync } from 'node:zlib';

import {
	hasEncryptedZipEntry, isSafeName, MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES, MAX_ZIP_UNCOMPRESSED_BYTES,
	readZipEntries, readZipEntryData
} from './zip-entries.js';

export type ArchiveVerdict = 'valid' | 'macros' | 'encrypted' | 'mismatch';

/** Checks one file inside an archive by its name and bytes. */
export type EntryCheck = ( name: string, bytes: Buffer ) => ArchiveVerdict;

const BLOCK_SIZE = 512;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_LENGTH = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_LENGTH = 8;
const TAR_TYPE_OFFSET = 156;
const TAR_MAGIC_OFFSET = 257;
const TAR_PREFIX_OFFSET = 345;
const TAR_PREFIX_LENGTH = 155;
const TAR_MAGICS = [ Buffer.from( 'ustar\x0000', 'latin1' ), Buffer.from( 'ustar  \0', 'latin1' ) ];
const TAR_MAGIC_LENGTH = 8;
/** Longest pax header or GNU long name accepted; real paths are far shorter. */
const MAX_TAR_NAME_DATA_BYTES = 64 * 1024;
const OCTAL = /^[0-7]+$/;
const PAX_RECORD_LENGTH = /^[1-9][0-9]*$/;

const GZIP_MAGIC = [ 0x1f, 0x8b ];
const GZIP_DEFLATE_METHOD = 8;
const GZIP_FIXED_HEADER_SIZE = 10;
const GZIP_FLAGS_OFFSET = 3;
const GZIP_FHCRC = 0x02;
const GZIP_FEXTRA = 0x04;
const GZIP_FNAME = 0x08;
const GZIP_FCOMMENT = 0x10;
const GZIP_RESERVED_FLAGS = 0xe0;

const APPLE_DOUBLE_MAGIC = Buffer.from( [ 0x00, 0x05, 0x16, 0x07 ] );
const DS_STORE_MAGIC = Buffer.from( '\0\0\0\x01Bud1', 'latin1' );
const APPLE_DOUBLE_DIRECTORY = '__MACOSX/';
const APPLE_DOUBLE_PREFIX = '._';
const DS_STORE_NAME = '.DS_Store';

function baseName( name: string ): string {
	return name.slice( name.search( /[^/\\]*$/ ) );
}

/** Whether a file is the macOS metadata Finder adds to archives and its bytes really are that metadata. */
function isMacJunk( name: string, bytes: Buffer ): boolean {
	const base = baseName( name );
	if ( base === DS_STORE_NAME ) {
		return bytes.subarray( 0, DS_STORE_MAGIC.length ).equals( DS_STORE_MAGIC );
	}
	return name.startsWith( APPLE_DOUBLE_DIRECTORY ) && base.startsWith( APPLE_DOUBLE_PREFIX ) &&
		bytes.subarray( 0, APPLE_DOUBLE_MAGIC.length ).equals( APPLE_DOUBLE_MAGIC );
}

/** Checks files one at a time, remembering whether any real file was seen and the first failure. */
class EntryRunner {
	files = 0;

	constructor( private readonly checkEntry: EntryCheck ) {}

	/** The verdict for one file, or null while the archive may still pass. */
	run( name: string, bytes: Buffer ): ArchiveVerdict | null {
		if ( isMacJunk( name, bytes ) ) {
			return null;
		}
		this.files++;
		const verdict = this.checkEntry( name, bytes );
		return verdict === 'valid' ? null : verdict;
	}

	/** The final verdict once every file has been run. */
	finish(): ArchiveVerdict {
		return this.files > 0 ? 'valid' : 'mismatch';
	}
}

/** Checks every regular file of a ZIP archive; password-protected entries give 'encrypted'. */
export function inspectZipArchive( content: Buffer, checkEntry: EntryCheck ): ArchiveVerdict {
	const entries = readZipEntries( content );
	if ( ! entries ) {
		return hasEncryptedZipEntry( content ) ? 'encrypted' : 'mismatch';
	}

	const runner = new EntryRunner( checkEntry );
	let budget = MAX_ZIP_UNCOMPRESSED_BYTES;
	for ( const entry of entries ) {
		if ( entry.symlink ) {
			return 'mismatch';
		}
		if ( entry.name.endsWith( '/' ) ) {
			continue;
		}
		const bytes = readZipEntryData( content, entry, Math.min( budget, MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES ) );
		if ( ! bytes ) {
			return 'mismatch';
		}
		budget -= bytes.length;
		const verdict = runner.run( entry.name, bytes );
		if ( verdict ) {
			return verdict;
		}
	}
	return runner.finish();
}

function isZeroBlock( block: Buffer ): boolean {
	return block.every( ( byte ) => byte === 0 );
}

/** The text up to the first NUL. */
function cString( bytes: Buffer ): string {
	const end = bytes.indexOf( 0 );
	return bytes.toString( 'utf8', 0, end < 0 ? bytes.length : end );
}

/** A number in a tar header field, or null unless it is plain octal (base-256 is not supported). */
function parseOctal( field: Buffer ): number | null {
	const text = field.toString( 'latin1' ).replace( /^ +/, '' ).replace( /[\0 ]+$/, '' );
	return OCTAL.test( text ) ? parseInt( text, 8 ) : null;
}

function hasValidChecksum( header: Buffer ): boolean {
	const stored = parseOctal( header.subarray( TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_LENGTH ) );
	if ( stored === null ) {
		return false;
	}
	let unsigned = 0;
	let signed = 0;
	for ( let index = 0; index < BLOCK_SIZE; index++ ) {
		const inChecksum = index >= TAR_CHECKSUM_OFFSET && index < TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_LENGTH;
		const byte = inChecksum ? 0x20 : header[ index ];
		unsigned += byte;
		signed += byte > 127 ? byte - 256 : byte;
	}
	return stored === unsigned || stored === signed;
}

function hasTarMagic( header: Buffer ): boolean {
	const magic = header.subarray( TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + TAR_MAGIC_LENGTH );
	return TAR_MAGICS.some( ( expected ) => expected.equals( magic ) );
}

/**
 * The `path` of a pax extended header (`<length> <key>=<value>\n` records), '' when it has none,
 * or null when the header is malformed or sets something this reader does not model.
 */
function parsePaxPath( data: Buffer ): string | null {
	let path = '';
	let position = 0;
	while ( position < data.length ) {
		const space = data.indexOf( 0x20, position );
		const lengthText = space < 0 ? '' : data.toString( 'latin1', position, space );
		if ( ! PAX_RECORD_LENGTH.test( lengthText ) ) {
			return null;
		}
		const end = position + Number( lengthText );
		if ( end > data.length || end <= space + 1 || data[ end - 1 ] !== 0x0a ) {
			return null;
		}
		const record = data.toString( 'utf8', space + 1, end - 1 );
		const equals = record.indexOf( '=' );
		if ( equals < 0 ) {
			return null;
		}
		const key = record.slice( 0, equals );
		// A pax size would change where the next header starts.
		if ( key === 'size' ) {
			return null;
		}
		if ( key === 'path' ) {
			path = record.slice( equals + 1 );
		}
		position = end;
	}
	return path;
}

/** Checks every regular file of a tar archive. */
export function inspectTarArchive( content: Buffer, checkEntry: EntryCheck ): ArchiveVerdict {
	const runner = new EntryRunner( checkEntry );
	let position = 0;
	let headers = 0;
	let totalBytes = 0;
	let nextName: string | null = null;
	for ( ;; ) {
		if ( position === content.length ) {
			return nextName === null ? runner.finish() : 'mismatch';
		}
		const header = content.subarray( position, position + BLOCK_SIZE );
		if ( header.length < BLOCK_SIZE ) {
			return 'mismatch';
		}
		if ( isZeroBlock( header ) ) {
			// Nothing but padding may follow the end marker.
			return nextName === null && content.subarray( position ).every( ( byte ) => byte === 0 ) ? runner.finish() : 'mismatch';
		}
		if ( ++headers > MAX_ZIP_ENTRIES || ! hasTarMagic( header ) || ! hasValidChecksum( header ) ) {
			return 'mismatch';
		}

		const size = parseOctal( header.subarray( TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_LENGTH ) );
		const type = String.fromCharCode( header[ TAR_TYPE_OFFSET ] );
		const dataStart = position + BLOCK_SIZE;
		const next = dataStart + Math.ceil( ( size ?? 0 ) / BLOCK_SIZE ) * BLOCK_SIZE;
		if ( size === null || size > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES || next > content.length ) {
			return 'mismatch';
		}
		const data = content.subarray( dataStart, dataStart + size );
		position = next;

		if ( type === 'g' ) {
			continue;
		}
		if ( type === 'x' || type === 'L' ) {
			const name = type === 'x' ? parsePaxPath( data ) : cString( data );
			if ( name === null || size > MAX_TAR_NAME_DATA_BYTES ) {
				return 'mismatch';
			}
			// An empty pax path leaves a pending long name in force.
			nextName = name || nextName;
			continue;
		}

		const prefix = cString( header.subarray( TAR_PREFIX_OFFSET, TAR_PREFIX_OFFSET + TAR_PREFIX_LENGTH ) );
		const ownName = cString( header.subarray( TAR_NAME_OFFSET, TAR_NAME_OFFSET + TAR_NAME_LENGTH ) );
		const name = nextName ?? ( prefix ? `${ prefix }/${ ownName }` : ownName );
		nextName = null;
		const isDirectory = type === '5' || ( ( type === '0' || type === '\0' ) && name.endsWith( '/' ) && size === 0 );
		if ( ! isSafeName( name ) ) {
			return 'mismatch';
		}
		if ( isDirectory ) {
			continue;
		}
		if ( type !== '0' && type !== '\0' ) {
			return 'mismatch';
		}
		totalBytes += size;
		if ( totalBytes > MAX_ZIP_UNCOMPRESSED_BYTES ) {
			return 'mismatch';
		}
		const verdict = runner.run( name, data );
		if ( verdict ) {
			return verdict;
		}
	}
}

/** The FNAME of a gzip header, '' when it has none, or null when the header is malformed. */
function readGzipName( content: Buffer ): string | null {
	if ( content.length < GZIP_FIXED_HEADER_SIZE || content[ 0 ] !== GZIP_MAGIC[ 0 ] || content[ 1 ] !== GZIP_MAGIC[ 1 ] ||
		content[ 2 ] !== GZIP_DEFLATE_METHOD ) {
		return null;
	}
	const flags = content[ GZIP_FLAGS_OFFSET ];
	if ( flags & GZIP_RESERVED_FLAGS ) {
		return null;
	}
	let position = GZIP_FIXED_HEADER_SIZE;
	if ( flags & GZIP_FEXTRA ) {
		if ( position + 2 > content.length ) {
			return null;
		}
		position += 2 + content.readUInt16LE( position );
	}
	if ( ! ( flags & GZIP_FNAME ) ) {
		return '';
	}
	const end = content.indexOf( 0, position );
	return position <= end ? content.toString( 'latin1', position, end ) : null;
}

/** Checks the contents of a gzip file: `tarOnly` for .tgz, else a .gz holding a tar or a single file named in its header. */
export function inspectGzip( content: Buffer, checkEntry: EntryCheck, tarOnly: boolean ): ArchiveVerdict {
	const name = readGzipName( content );
	if ( name === null ) {
		return 'mismatch';
	}
	let data: Buffer;
	try {
		data = gunzipSync( content, { maxOutputLength: MAX_ZIP_UNCOMPRESSED_BYTES } );
	} catch {
		return 'mismatch';
	}

	if ( data.length >= BLOCK_SIZE && hasTarMagic( data.subarray( 0, BLOCK_SIZE ) ) ) {
		return inspectTarArchive( data, checkEntry );
	}
	const file = baseName( name );
	if ( tarOnly || ! file || ! isSafeName( file ) ) {
		return 'mismatch';
	}
	return checkEntry( file, data );
}
