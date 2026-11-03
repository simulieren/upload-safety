/**
 * Checks the structure of MP4, MOV, M4A, WebM, Matroska and AVI files and removes their metadata (GPS,
 * titles, cover art, XMP) without moving a byte, so sample offsets and cluster positions stay
 * valid and a large video is not re-encoded. Boxes and elements are overwritten in place:
 * ISOBMFF boxes become `free` boxes with a zeroed payload, WebM and Matroska elements become
 * `Void` elements of the same length and AVI chunks become zeroed `JUNK` chunks.
 *
 * Limitation: metadata stored as samples in a timed metadata track (GoPro GPMF, DJI, Apple
 * `mebx`) lives in `mdat` or in clusters, which are never touched, so it stays.
 */

import { readBoxes, readFtypBrands, type Box } from './heif-metadata.js';

/** Bounds far above real files that keep a crafted one cheap. */
const MAX_ELEMENTS = 10_000;
const MAX_DEPTH = 16;

const FTYP = 'ftyp';
const MOOV = 'moov';
const QUICKTIME_BRAND = 'qt  ';
/** Top-level boxes an old QuickTime movie without `ftyp` may start with. */
const QUICKTIME_FIRST_BOXES: ReadonlySet<string> = new Set( [ 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot' ] );
/** Boxes that only hold other boxes and may hide metadata further down. */
const CONTAINER_BOXES: ReadonlySet<string> = new Set( [ 'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf' ] );
const METADATA_BOXES: ReadonlySet<string> = new Set( [ 'udta', 'meta', 'uuid', 'XMP_' ] );
/** Top-level boxes holding metadata; `udta` and `XMP_` only occur inside `moov`. */
const TOP_LEVEL_METADATA_BOXES: ReadonlySet<string> = new Set( [ 'meta', 'uuid' ] );
const FREE_TYPE = Buffer.from( 'free', 'latin1' );
const LARGE_SIZE = 1;
const SMALL_HEADER = 8;
const LARGE_HEADER = 16;

/** The file offset of each box's header start, which `Box` does not record: boxes follow each other. */
function headerStarts( boxes: Box[], start: number ): number[] {
	return boxes.map( ( _box, index ) => ( index === 0 ? start : boxes[ index - 1 ].end ) );
}

/**
 * Collects the byte ranges to overwrite below `[start, end)`; each range is a box's type and
 * payload. Returns false when a box does not read, nesting is too deep or there are too many boxes.
 */
function collectMetadataBoxes( bytes: Buffer, start: number, end: number, depth: number, budget: { left: number }, found: Array<[ number, number ]> ): boolean {
	const boxes = readBoxes( bytes, start, end );
	if ( ! boxes || depth > MAX_DEPTH ) {
		return false;
	}
	budget.left -= boxes.length;
	if ( budget.left < 0 ) {
		return false;
	}
	const starts = headerStarts( boxes, start );
	for ( const [ index, box ] of boxes.entries() ) {
		if ( METADATA_BOXES.has( box.type ) ) {
			found.push( [ starts[ index ], box.end ] );
		} else if ( CONTAINER_BOXES.has( box.type ) ) {
			if ( ! collectMetadataBoxes( bytes, box.start, box.end, depth + 1, budget, found ) ) {
				return false;
			}
		}
	}
	return true;
}

/** Turns the box at `[start, end)` into a `free` box and zeroes its payload, keeping its size field. */
function freeBox( bytes: Buffer, start: number, end: number ): void {
	const header = bytes.readUInt32BE( start ) === LARGE_SIZE ? LARGE_HEADER : SMALL_HEADER;
	FREE_TYPE.copy( bytes, start + 4 );
	bytes.fill( 0, start + header, end );
}

/**
 * The ISO media file (MP4, MOV, M4A) with its metadata boxes overwritten, the input itself when
 * there was nothing to remove, or null when its boxes do not read, it has no single `moov` or it
 * names none of `brands`. `brands` null means a QuickTime movie, which may lack `ftyp`.
 */
export function stripIsoMedia( content: Buffer, brands: readonly string[] | null ): Buffer | null {
	const boxes = readBoxes( content, 0, content.length );
	if ( ! boxes || boxes.length === 0 ) {
		return null;
	}
	const first = boxes[ 0 ].type;
	if ( brands === null ) {
		const fileBrands = readFtypBrands( content );
		if ( first === FTYP ? ! fileBrands.includes( QUICKTIME_BRAND ) : ! QUICKTIME_FIRST_BOXES.has( first ) ) {
			return null;
		}
	} else if ( first !== FTYP || ! readFtypBrands( content ).some( ( brand ) => brands.includes( brand ) ) ) {
		return null;
	}
	if ( boxes.filter( ( box ) => box.type === MOOV ).length !== 1 ) {
		return null;
	}
	const found: Array<[ number, number ]> = [];
	const starts = headerStarts( boxes, 0 );
	const budget = { left: MAX_ELEMENTS - boxes.length };
	for ( const [ index, box ] of boxes.entries() ) {
		if ( TOP_LEVEL_METADATA_BOXES.has( box.type ) ) {
			found.push( [ starts[ index ], box.end ] );
		} else if ( CONTAINER_BOXES.has( box.type ) && ! collectMetadataBoxes( content, box.start, box.end, 1, budget, found ) ) {
			return null;
		}
	}
	if ( found.length === 0 ) {
		return content;
	}
	const stripped = Buffer.from( content );
	for ( const [ start, end ] of found ) {
		freeBox( stripped, start, end );
	}
	return stripped;
}

const EBML_HEADER = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const TAGS = 0x1254c367;
const ATTACHMENTS = 0x1941a469;
const CLUSTER = 0x1f43b675;
const TITLE = 0x7ba9;
const VOID = 0xec;
const WEBM_DOC_TYPE = 'webm';
const MATROSKA_DOC_TYPE = 'matroska';
/** The elements a cluster may hold; the first other ID ends a cluster of unknown size. */
const CLUSTER_CHILDREN: ReadonlySet<number> = new Set( [ 0xe7, 0x5854, 0xa7, 0xab, 0xa3, 0xa0, 0xaf, VOID, 0xbf ] );
const MAX_VINT_LENGTH = 8;

interface Element {
	id: number;
	/** Where the element's header starts. */
	start: number;
	/** Where its content starts. */
	data: number;
	/** Where it ends, or null when its size is unknown. */
	end: number | null;
}

/** The EBML element at `offset` within `[offset, limit)`, or null when its header or size does not read. */
function readElement( bytes: Buffer, offset: number, limit: number ): Element | null {
	if ( offset >= limit ) {
		return null;
	}
	const idLength = Math.clz32( bytes[ offset ] ) - 23;
	const sizeOffset = offset + idLength;
	if ( idLength < 1 || idLength > 4 || sizeOffset >= limit ) {
		return null;
	}
	const sizeLength = Math.clz32( bytes[ sizeOffset ] ) - 23;
	const data = sizeOffset + sizeLength;
	if ( sizeLength < 1 || sizeLength > MAX_VINT_LENGTH || data > limit ) {
		return null;
	}
	let size = BigInt( bytes[ sizeOffset ] & ( 0xff >> sizeLength ) );
	for ( let index = 1; index < sizeLength; index++ ) {
		size = ( size << 8n ) | BigInt( bytes[ sizeOffset + index ] );
	}
	const id = bytes.readUIntBE( offset, idLength );
	// All bits set means "unknown size".
	if ( size === ( 1n << BigInt( 7 * sizeLength ) ) - 1n ) {
		return { id, start: offset, data, end: null };
	}
	return size > BigInt( limit - data ) ? null : { id, start: offset, data, end: data + Number( size ) };
}

/** The children of a master element, all of known size, or null when they do not read. */
function readChildren( bytes: Buffer, parent: Element ): Element[] | null {
	const children: Element[] = [];
	for ( let offset = parent.data; offset < parent.end!; ) {
		const child = readElement( bytes, offset, parent.end! );
		if ( ! child || child.end === null || children.length === MAX_ELEMENTS ) {
			return null;
		}
		children.push( child );
		offset = child.end;
	}
	return children;
}

/** Where a cluster of unknown size ends: at the first element that is not a cluster child, or at `limit`. */
function findClusterEnd( bytes: Buffer, cluster: Element, limit: number ): number | null {
	let offset = cluster.data;
	while ( offset < limit ) {
		const child = readElement( bytes, offset, limit );
		if ( ! child ) {
			return null;
		}
		if ( ! CLUSTER_CHILDREN.has( child.id ) ) {
			return offset;
		}
		if ( child.end === null ) {
			return null;
		}
		offset = child.end;
	}
	return limit;
}

/** The smallest EBML size field that makes a `Void` element exactly `total` bytes, or null when none fits. */
function voidElement( total: number ): Buffer | null {
	for ( let width = 1; width <= MAX_VINT_LENGTH; width++ ) {
		const payload = total - 1 - width;
		// An all-ones size means "unknown", so the largest value of each width is not usable.
		if ( payload >= 0 && BigInt( payload ) < ( 1n << BigInt( 7 * width ) ) - 1n ) {
			return Buffer.concat( [ Buffer.from( [ VOID ] ), sizeBytes( payload, width ), Buffer.alloc( payload ) ] );
		}
	}
	return null;
}

/** An EBML size of `width` bytes holding `value`. */
function sizeBytes( value: number, width: number ): Buffer {
	const bytes = Buffer.alloc( width );
	let rest = BigInt( value ) | ( 1n << BigInt( 7 * width ) );
	for ( let index = width - 1; index >= 0; index-- ) {
		bytes[ index ] = Number( rest & 0xffn );
		rest >>= 8n;
	}
	return bytes;
}

/**
 * The WebM or Matroska file with its Tags, Attachments (in Matroska they can hold any file) and Title
 * overwritten by `Void` elements of the same length, the input itself when there was nothing to remove,
 * or null when its DocType is not allowed or its elements do not read. `webm` allows only WebM;
 * `matroska` allows both, as a WebM file is a Matroska file. A cluster of unknown size, as live
 * recorders write, ends at the first element a cluster cannot hold.
 */
export function stripMatroska( content: Buffer, docType: 'webm' | 'matroska' ): Buffer | null {
	const header = readElement( content, 0, content.length );
	if ( ! header || header.id !== EBML_HEADER || header.end === null ) {
		return null;
	}
	const headerChildren = readChildren( content, header );
	const docTypeElement = headerChildren?.find( ( child ) => child.id === DOC_TYPE );
	if ( ! docTypeElement ) {
		return null;
	}
	const found = content.toString( 'latin1', docTypeElement.data, docTypeElement.end! ).replace( /\0+$/, '' );
	if ( found !== WEBM_DOC_TYPE && ! ( docType === 'matroska' && found === MATROSKA_DOC_TYPE ) ) {
		return null;
	}
	const segment = readElement( content, header.end, content.length );
	if ( ! segment || segment.id !== SEGMENT || ( segment.end ?? content.length ) !== content.length ) {
		return null;
	}
	const segmentEnd = content.length;
	const voids: Array<[ number, number ]> = [];
	let hasInfo = false;
	let hasTracks = false;
	let count = 0;
	for ( let offset = segment.data; offset < segmentEnd; ) {
		const element = readElement( content, offset, segmentEnd );
		if ( ! element || ++count > MAX_ELEMENTS ) {
			return null;
		}
		let end = element.end;
		if ( end === null ) {
			end = element.id === CLUSTER ? findClusterEnd( content, element, segmentEnd ) : null;
			if ( end === null ) {
				return null;
			}
		}
		if ( element.id === TAGS || element.id === ATTACHMENTS ) {
			voids.push( [ element.start, end ] );
		} else if ( element.id === INFO ) {
			hasInfo = true;
			const children = readChildren( content, { ...element, end } );
			if ( ! children ) {
				return null;
			}
			voids.push( ...children.filter( ( child ) => child.id === TITLE ).map( ( child ): [ number, number ] => [ child.start, child.end! ] ) );
		} else if ( element.id === TRACKS ) {
			hasTracks = true;
		}
		offset = end;
	}
	if ( ! hasInfo || ! hasTracks ) {
		return null;
	}
	if ( voids.length === 0 ) {
		return content;
	}
	const stripped = Buffer.from( content );
	for ( const [ start, end ] of voids ) {
		const element = voidElement( end - start );
		if ( ! element ) {
			return null;
		}
		element.copy( stripped, start );
	}
	return stripped;
}

const RIFF_HEADER_SIZE = 12;
const RIFF_CHUNK_HEADER_SIZE = 8;
const MAX_AVI_CHUNKS = 100_000;
const MAX_AVI_DEPTH = 8;
const AVI_FORM = 'AVI ';
const AVI_EXTENSION_FORM = 'AVIX';
const JUNK = 'JUNK';
const LIST = 'LIST';
/** Chunks that hold text, XMP or vendor data; the `INFO` list is handled apart because it is a list. */
const AVI_METADATA_CHUNKS: ReadonlySet<string> = new Set( [ 'IDIT', 'ISMP', '_PMX', 'strd', 'strn' ] );

interface AviState {
	chunks: number;
	hasHeader: boolean;
	hasMovie: boolean;
	blanks: Array<[ number, number ]>;
}

/** Whether `[start, end)` of `bytes` is already a `JUNK` chunk of zeros, so blanking it changes nothing. */
function isBlankJunk( bytes: Buffer, start: number, end: number ): boolean {
	return bytes.toString( 'latin1', start, start + 4 ) === JUNK && ! bytes.subarray( start + RIFF_CHUNK_HEADER_SIZE, end ).some( ( byte ) => byte !== 0 );
}

/**
 * Walks the RIFF chunks tiling `[start, end)` and records the ones to blank. Returns false when a chunk runs
 * past its parent, bytes are left over, or the limits on chunks and depth are exceeded.
 */
function walkAvi( bytes: Buffer, start: number, end: number, depth: number, parent: string, firstRiff: boolean, state: AviState ): boolean {
	if ( depth > MAX_AVI_DEPTH ) {
		return false;
	}
	let offset = start;
	while ( offset < end ) {
		if ( ++state.chunks > MAX_AVI_CHUNKS || offset + RIFF_CHUNK_HEADER_SIZE > end ) {
			return false;
		}
		const type = bytes.toString( 'latin1', offset, offset + 4 );
		const size = bytes.readUInt32LE( offset + 4 );
		const dataStart = offset + RIFF_CHUNK_HEADER_SIZE;
		if ( size > end - dataStart ) {
			return false;
		}
		const next = Math.min( dataStart + size + ( size & 1 ), end );
		if ( type === LIST ) {
			if ( size < 4 ) {
				return false;
			}
			const listType = bytes.toString( 'latin1', dataStart, dataStart + 4 );
			if ( listType === 'INFO' ) {
				state.blanks.push( [ offset, next ] );
			} else if ( listType === 'movi' ) {
				state.hasMovie ||= firstRiff;
			} else if ( ! walkAvi( bytes, dataStart + 4, dataStart + size, depth + 1, listType, firstRiff, state ) ) {
				return false;
			}
		} else if ( AVI_METADATA_CHUNKS.has( type ) || type === JUNK ) {
			state.blanks.push( [ offset, next ] );
		} else if ( type === 'avih' && parent === 'hdrl' ) {
			state.hasHeader ||= firstRiff;
		}
		offset = next;
	}
	return true;
}

/**
 * The AVI with its `INFO` lists and its `IDIT`, `ISMP`, `_PMX` (XMP), `strd` (vendor data) and `strn`
 * chunks, and the contents of `JUNK` chunks, overwritten by zeroed `JUNK` chunks of the same size, the input
 * itself when there was nothing to remove, or null when the chunks do not read, the first RIFF lacks `hdrl`
 * with `avih` or `movi`, or bytes follow the last RIFF. OpenDML `AVIX` RIFFs after the first are read the
 * same way. No byte moves, so the `idx1` offsets stay valid; `movi` and `idx1` are never touched.
 */
export function stripAvi( content: Buffer ): Buffer | null {
	const state: AviState = { chunks: 0, hasHeader: false, hasMovie: false, blanks: [] };
	let offset = 0;
	for ( let riffs = 0; offset < content.length; riffs++ ) {
		if ( offset + RIFF_HEADER_SIZE > content.length || content.toString( 'latin1', offset, offset + 4 ) !== 'RIFF' ) {
			return null;
		}
		const form = content.toString( 'latin1', offset + 8, offset + 12 );
		if ( form !== ( riffs === 0 ? AVI_FORM : AVI_EXTENSION_FORM ) ) {
			return null;
		}
		const size = content.readUInt32LE( offset + 4 );
		const end = offset + RIFF_CHUNK_HEADER_SIZE + size;
		if ( size < 4 || end > content.length || ! walkAvi( content, offset + RIFF_HEADER_SIZE, end, 0, form, riffs === 0, state ) ) {
			return null;
		}
		offset = Math.min( end + ( size & 1 ), content.length );
	}
	if ( ! state.hasHeader || ! state.hasMovie ) {
		return null;
	}
	const changes = state.blanks.filter( ( [ start, end ] ) => ! isBlankJunk( content, start, end ) );
	if ( changes.length === 0 ) {
		return content;
	}
	const stripped = Buffer.from( content );
	for ( const [ start, end ] of changes ) {
		stripped.write( JUNK, start, 'latin1' );
		stripped.fill( 0, start + RIFF_CHUNK_HEADER_SIZE, end );
	}
	return stripped;
}
