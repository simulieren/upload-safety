/**
 * Checks the structure of MP4, MOV, M4A and WebM files and removes their metadata (GPS,
 * titles, cover art, XMP) without moving a byte, so sample offsets and cluster positions stay
 * valid and a large video is not re-encoded. Boxes and elements are overwritten in place:
 * ISOBMFF boxes become `free` boxes with a zeroed payload, WebM elements become `Void`
 * elements of the same length.
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
 * The WebM file with its Tags, Attachments and Title overwritten by `Void` elements of the same
 * length, the input itself when there was nothing to remove, or null when it is not a WebM
 * (`matroska` is refused) or its elements do not read. A cluster of unknown size, as live
 * recorders write, ends at the first element a cluster cannot hold.
 */
export function stripWebm( content: Buffer ): Buffer | null {
	const header = readElement( content, 0, content.length );
	if ( ! header || header.id !== EBML_HEADER || header.end === null ) {
		return null;
	}
	const headerChildren = readChildren( content, header );
	const docType = headerChildren?.find( ( child ) => child.id === DOC_TYPE );
	if ( ! docType || content.toString( 'latin1', docType.data, docType.end! ).replace( /\0+$/, '' ) !== WEBM_DOC_TYPE ) {
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
