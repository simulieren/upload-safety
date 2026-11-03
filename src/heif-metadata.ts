/**
 * Removes EXIF and XMP from a HEIF still image (HEIC, AVIF) without moving a byte. The item
 * locations are byte offsets that dropping data would shift, so the items are overwritten in
 * place instead: EXIF with an empty TIFF block, XMP with spaces. The orientation lives in the
 * `irot` and `imir` properties, which stay. Image sequences (`moov`) are refused.
 */

interface Box {
	type: string;
	/** Where the box's content starts, past its header. */
	start: number;
	end: number;
}

/** Bounds far above real files that keep a crafted one cheap. */
const MAX_BOXES = 10_000;
const MAX_ITEMS = 100_000;

const XMP_CONTENT_TYPE = 'application/rdf+xml';
/** An EXIF item: the offset of the TIFF header (0), then a big-endian TIFF block with an empty IFD0. */
const EMPTY_EXIF = Buffer.from( '00000000' + '4d4d002a00000008' + '0000' + '00000000', 'hex' );
const SPACE = 0x20;

/** The boxes in `[start, end)`, or null when one runs past it or there are too many. */
function readBoxes( bytes: Buffer, start: number, end: number ): Box[] | null {
	const boxes: Box[] = [];
	for ( let offset = start; offset < end; ) {
		if ( offset + 8 > end || boxes.length === MAX_BOXES ) {
			return null;
		}
		let size = bytes.readUInt32BE( offset );
		let header = 8;
		if ( size === 1 ) {
			const large = offset + 16 <= end ? bytes.readBigUInt64BE( offset + 8 ) : undefined;
			if ( large === undefined || large > BigInt( end - offset ) ) {
				return null;
			}
			size = Number( large );
			header = 16;
		} else if ( size === 0 ) {
			// Runs to the end of the file.
			size = end - offset;
		}
		const type = bytes.toString( 'latin1', offset + 4, offset + 8 );
		header += type === 'uuid' ? 16 : 0;
		if ( size < header || offset + size > end ) {
			return null;
		}
		boxes.push( { type, start: offset + header, end: offset + size } );
		offset += size;
	}
	return boxes;
}

/** Reads the fields of a box's content in order; any read past its end throws. */
class FieldReader {
	position: number;
	private readonly bytes: Buffer;
	private readonly end: number;

	constructor( bytes: Buffer, box: Box ) {
		this.bytes = bytes;
		this.position = box.start;
		this.end = box.end;
	}

	/** An unsigned big-endian integer of 0, 1, 2, 4 or 8 bytes. */
	uint( size: number ): number {
		if ( this.position + size > this.end ) {
			throw new RangeError( 'Box field past its end' );
		}
		const value = size === 8 ? Number( this.bytes.readBigUInt64BE( this.position ) ) : size === 0 ? 0 : this.bytes.readUIntBE( this.position, size );
		this.position += size;
		return value;
	}

	text( length: number ): string {
		if ( this.position + length > this.end ) {
			throw new RangeError( 'Box field past its end' );
		}
		this.position += length;
		return this.bytes.toString( 'latin1', this.position - length, this.position );
	}

	/** A NUL-terminated string, or the rest of the box when the NUL is missing. */
	string(): string {
		const nul = this.bytes.indexOf( 0, this.position );
		const stop = nul < 0 || nul >= this.end ? this.end : nul;
		const value = this.bytes.toString( 'utf8', this.position, stop );
		this.position = Math.min( this.end, stop + 1 );
		return value;
	}
}

/** The IDs of the EXIF and XMP items an `iinf` box lists; throws a RangeError when it does not read. */
function readMetadataItems( bytes: Buffer, iinf: Box ): { exif: Set<number>; xmp: Set<number> } {
	const reader = new FieldReader( bytes, iinf );
	const version = reader.uint( 1 );
	reader.uint( 3 );
	reader.uint( version === 0 ? 2 : 4 );
	const exif = new Set<number>();
	const xmp = new Set<number>();
	const entries = readBoxes( bytes, reader.position, iinf.end );
	if ( ! entries ) {
		throw new RangeError( 'Item entries do not read' );
	}
	for ( const infe of entries ) {
		if ( infe.type !== 'infe' ) {
			continue;
		}
		const entry = new FieldReader( bytes, infe );
		const entryVersion = entry.uint( 1 );
		entry.uint( 3 );
		const id = entry.uint( entryVersion === 3 ? 4 : 2 );
		entry.uint( 2 );
		// Versions 0 and 1 describe a MIME item without naming its type.
		const type = entryVersion >= 2 ? entry.text( 4 ) : 'mime';
		entry.string();
		if ( type === 'Exif' ) {
			exif.add( id );
		} else if ( type === 'mime' && entry.string().toLowerCase() === XMP_CONTENT_TYPE ) {
			xmp.add( id );
		}
	}
	return { exif, xmp };
}

/**
 * Where the data of each item lies, as file offsets read from an `iloc` box, `[ -1, -1 ]` for an
 * extent that cannot be located; throws a RangeError when the box does not read.
 */
function readItemLocations( bytes: Buffer, iloc: Box, idat: Box | undefined ): Map<number, Array<[ number, number ]>> {
	const reader = new FieldReader( bytes, iloc );
	const version = reader.uint( 1 );
	reader.uint( 3 );
	const sizes = reader.uint( 2 );
	const offsetSize = sizes >> 12;
	const lengthSize = ( sizes >> 8 ) & 0xf;
	const baseOffsetSize = ( sizes >> 4 ) & 0xf;
	const indexSize = version === 0 ? 0 : sizes & 0xf;
	const itemCount = reader.uint( version < 2 ? 2 : 4 );
	if ( itemCount > MAX_ITEMS ) {
		throw new RangeError( 'Too many items' );
	}
	const locations = new Map<number, Array<[ number, number ]>>();
	for ( let item = 0; item < itemCount; item++ ) {
		const id = reader.uint( version < 2 ? 2 : 4 );
		const method = version === 0 ? 0 : reader.uint( 2 ) & 0xf;
		const dataReference = reader.uint( 2 );
		const baseOffset = reader.uint( baseOffsetSize );
		const extentCount = reader.uint( 2 );
		const extents: Array<[ number, number ]> = [];
		for ( let extent = 0; extent < extentCount; extent++ ) {
			reader.uint( indexSize );
			const offset = reader.uint( offsetSize );
			const length = reader.uint( lengthSize );
			// Method 0 points into the file, 1 into the `idat` box; 2 (other items) and other files are not read.
			const origin = method === 0 && dataReference === 0 ? 0 : method === 1 ? idat?.start : undefined;
			const start = origin === undefined ? -1 : origin + baseOffset + offset;
			const limit = method === 1 ? idat?.end ?? -1 : bytes.length;
			extents.push( start < 0 || length === 0 || start + length > limit ? [ -1, -1 ] : [ start, start + length ] );
		}
		locations.set( id, [ ...( locations.get( id ) ?? [] ), ...extents ] );
	}
	return locations;
}

/** Writes `data`, padded with `fill`, over the extents in order. */
function overwrite( bytes: Buffer, extents: Array<[ number, number ]>, data: Buffer, fill: number ): void {
	let written = 0;
	for ( const [ start, end ] of extents ) {
		bytes.fill( fill, start, end );
		written += data.copy( bytes, start, Math.min( written, data.length ), Math.min( data.length, written + end - start ) );
	}
}

/**
 * The HEIF image with its EXIF and XMP items overwritten, or null when its boxes do not read,
 * an item's data cannot be located, or it is an image sequence.
 */
export function stripHeif( content: Buffer ): Buffer | null {
	const boxes = readBoxes( content, 0, content.length );
	if ( ! boxes || boxes[ 0 ]?.type !== 'ftyp' || boxes.some( ( box ) => box.type === 'moov' ) ) {
		return null;
	}
	const metas = boxes.filter( ( box ) => box.type === 'meta' );
	// `meta` is a full box: version and flags come before its children.
	const children = metas.length === 1 ? readBoxes( content, metas[ 0 ].start + 4, metas[ 0 ].end ) : null;
	const iinf = children?.find( ( box ) => box.type === 'iinf' );
	const iloc = children?.find( ( box ) => box.type === 'iloc' );
	if ( ! iinf || ! iloc ) {
		return null;
	}
	const stripped = Buffer.from( content );
	try {
		const { exif, xmp } = readMetadataItems( content, iinf );
		const locations = readItemLocations( content, iloc, children!.find( ( box ) => box.type === 'idat' ) );
		for ( const [ ids, data, fill ] of [ [ exif, EMPTY_EXIF, 0 ], [ xmp, Buffer.alloc( 0 ), SPACE ] ] as const ) {
			for ( const id of ids ) {
				const extents = locations.get( id ) ?? [];
				if ( extents.some( ( [ start ] ) => start < 0 ) ) {
					return null;
				}
				overwrite( stripped, extents, data, fill );
			}
		}
	} catch ( error ) {
		if ( error instanceof RangeError ) {
			return null;
		}
		throw error;
	}
	// Top-level `uuid` boxes hold vendor data, such as XMP in some writers.
	for ( const box of boxes.filter( ( box ) => box.type === 'uuid' ) ) {
		stripped.fill( 0, box.start, box.end );
	}
	return stripped;
}

/** The major and compatible brands of a file's leading `ftyp` box, empty when there is none. */
export function readFtypBrands( content: Buffer ): string[] {
	const size = content.length >= 16 ? content.readUInt32BE( 0 ) : 0;
	if ( size < 16 || size > content.length || content.toString( 'latin1', 4, 8 ) !== 'ftyp' ) {
		return [];
	}
	// The minor version sits between the major brand and the compatible ones.
	const brands = [ content.toString( 'latin1', 8, 12 ) ];
	for ( let offset = 16; offset + 4 <= size; offset += 4 ) {
		brands.push( content.toString( 'latin1', offset, offset + 4 ) );
	}
	return brands;
}
