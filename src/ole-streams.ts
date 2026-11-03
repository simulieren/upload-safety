/**
 * Reads the directory and streams of an OLE compound file (the container of
 * legacy .doc/.xls/.ppt files) by following its sector chains.
 * Returns null for anything malformed, oversized or outside versions 3 and 4.
 */

export interface OleDirectory {
	/** Names of every storage and stream, at any depth. */
	names: string[];
	/** A stream right below the root, matched case-insensitively, or null when missing or malformed. */
	readStream( name: string ): Buffer | null;
}

/** Upper bounds that keep a crafted file from costing more than a real one. */
export const MAX_OLE_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_OLE_SECTORS = 1 << 20;

const SIGNATURE = Buffer.from( [ 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1 ] );
const HEADER_SIZE = 512;
const HEADER_FAT_SECTORS = 109;
const BYTE_ORDER = 0xfffe;
const MINI_SECTOR_SHIFT = 6;
const MINI_SECTOR_SIZE = 1 << MINI_SECTOR_SHIFT;
const MINI_STREAM_CUTOFF = 4096;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const NO_ENTRY = 0xffffffff;
const ENTRY_SIZE = 128;
const STORAGE = 1;
const STREAM = 2;
const ROOT = 5;

interface Entry {
	name: string;
	type: number;
	left: number;
	right: number;
	child: number;
	start: number;
	size: number;
}

/**
 * The first `count` sectors of a chain, or all up to its end without a count; null when one
 * is out of range or repeats. Some writers run a chain on past its stream, as Office tolerates.
 */
function followChain( next: ( sector: number ) => number, start: number, sectorCount: number, count?: number ): number[] | null {
	const visited = new Uint8Array( sectorCount );
	const sectors: number[] = [];
	let sector = start;
	while ( sector !== END_OF_CHAIN && sectors.length !== count ) {
		if ( sector >= sectorCount || visited[ sector ] ) {
			return null;
		}
		visited[ sector ] = 1;
		sectors.push( sector );
		sector = next( sector );
	}
	return count === undefined || sectors.length === count ? sectors : null;
}

type ChainReader = ( start: number, size?: number ) => Buffer | null;

/** Reads a stream of `size` bytes, or a chain to its end without one, through an allocation table. */
function chainReader( table: Buffer, sector: ( index: number ) => Buffer, sectorCount: number, sectorSize: number ): ChainReader {
	const next = ( index: number ) => ( index * 4 + 4 <= table.length ? table.readUInt32LE( index * 4 ) : FREE_SECTOR );
	return ( start, size ) => {
		if ( ( size ?? 0 ) > MAX_OLE_STREAM_BYTES ) {
			return null;
		}
		const count = size === undefined ? undefined : Math.ceil( size / sectorSize );
		const sectors = count === 0 ? [] : followChain( next, start, sectorCount, count );
		const data = sectors && Buffer.concat( sectors.map( sector ) );
		return data && data.length >= ( size ?? 0 ) ? data.subarray( 0, size ) : null;
	};
}

/** The directory's entries, null for unused ones, or null when an entry is malformed. */
function readEntries( directory: Buffer | null, version: number ): Array<Entry | null> | null {
	if ( ! directory ) {
		return null;
	}
	const entries: Array<Entry | null> = [];
	for ( let offset = 0; offset + ENTRY_SIZE <= directory.length; offset += ENTRY_SIZE ) {
		const nameLength = directory.readUInt16LE( offset + 0x40 );
		const type = directory[ offset + 0x42 ];
		// Version 3 writers may leave garbage in the upper half of the size.
		const size = directory.readUInt32LE( offset + 0x78 ) + ( version === 3 ? 0 : directory.readUInt32LE( offset + 0x7c ) * 2 ** 32 );
		if ( type !== STORAGE && type !== STREAM && type !== ROOT ) {
			entries.push( null );
			continue;
		}
		if ( nameLength < 2 || nameLength > 64 || nameLength % 2 ) {
			return null;
		}
		entries.push( {
			name: directory.toString( 'utf16le', offset, offset + nameLength - 2 ),
			type,
			left: directory.readUInt32LE( offset + 0x44 ),
			right: directory.readUInt32LE( offset + 0x48 ),
			child: directory.readUInt32LE( offset + 0x4c ),
			start: directory.readUInt32LE( offset + 0x74 ),
			size,
		} );
	}
	return entries[ 0 ]?.type === ROOT ? entries : null;
}

/**
 * The entries right below the root, walked through the sibling tree, or null for a broken
 * tree or two of the same name, of which a check could read another than Office.
 */
function readRootChildren( entries: Array<Entry | null>, root: Entry ): Entry[] | null {
	const children: Entry[] = [];
	const names = new Set<string>();
	const visited = new Set<number>();
	const pending = [ root.child ];
	while ( pending.length ) {
		const index = pending.pop()!;
		if ( index === NO_ENTRY ) {
			continue;
		}
		const entry = entries[ index ];
		if ( ! entry || entry.type === ROOT || visited.has( index ) || names.has( entry.name.toLowerCase() ) ) {
			return null;
		}
		visited.add( index );
		names.add( entry.name.toLowerCase() );
		children.push( entry );
		pending.push( entry.left, entry.right );
	}
	return children;
}

export function readOleDirectory( content: Buffer ): OleDirectory | null {
	if ( content.length < HEADER_SIZE || ! content.subarray( 0, SIGNATURE.length ).equals( SIGNATURE ) ||
		content.readUInt16LE( 0x1c ) !== BYTE_ORDER || content.readUInt16LE( 0x20 ) !== MINI_SECTOR_SHIFT ||
		content.readUInt32LE( 0x38 ) !== MINI_STREAM_CUTOFF ) {
		return null;
	}
	const version = content.readUInt16LE( 0x1a );
	const sectorShift = content.readUInt16LE( 0x1e );
	if ( ! ( version === 3 && sectorShift === 9 ) && ! ( version === 4 && sectorShift === 12 ) ) {
		return null;
	}
	const sectorSize = 1 << sectorShift;
	// Version 4 pads the header to a full sector; sector 0 follows it.
	const sectorCount = Math.ceil( ( content.length - sectorSize ) / sectorSize );
	if ( sectorCount <= 0 || sectorCount > MAX_OLE_SECTORS ) {
		return null;
	}
	const sector = ( index: number ) => content.subarray( ( index + 1 ) * sectorSize, ( index + 2 ) * sectorSize );

	// The FAT's sectors are listed in the header, then in the DIFAT chain.
	const fatSectorCount = content.readUInt32LE( 0x2c );
	const difatSectorCount = content.readUInt32LE( 0x48 );
	if ( fatSectorCount > sectorCount || difatSectorCount > sectorCount ) {
		return null;
	}
	const fatSectors: number[] = [];
	for ( let index = 0; index < Math.min( fatSectorCount, HEADER_FAT_SECTORS ); index++ ) {
		fatSectors.push( content.readUInt32LE( 0x4c + index * 4 ) );
	}
	// Writers end the DIFAT chain with either marker, so its length comes from the header.
	const difatSeen = new Set<number>();
	let difat = content.readUInt32LE( 0x44 );
	for ( let count = 0; count < difatSectorCount; count++ ) {
		if ( difat >= sectorCount || difatSeen.has( difat ) ) {
			return null;
		}
		difatSeen.add( difat );
		const entries = sector( difat );
		for ( let index = 0; index < sectorSize / 4 - 1 && fatSectors.length < fatSectorCount; index++ ) {
			fatSectors.push( entries.readUInt32LE( index * 4 ) );
		}
		difat = entries.readUInt32LE( sectorSize - 4 );
	}
	if ( fatSectors.length !== fatSectorCount || fatSectors.some( ( index ) => index >= sectorCount ) ) {
		return null;
	}
	const fat = Buffer.concat( fatSectors.map( sector ) );
	const readChain = chainReader( fat, sector, sectorCount, sectorSize );

	const directory = readEntries( readChain( content.readUInt32LE( 0x30 ) ), version );
	const root = directory?.[ 0 ];
	if ( ! directory || ! root ) {
		return null;
	}
	const children = readRootChildren( directory, root );
	if ( ! children ) {
		return null;
	}

	// Streams under the cutoff live in 64-byte sectors of the root's mini stream.
	let readMiniChain: ChainReader | undefined;
	const readSmallStream = ( start: number, size: number ): Buffer | null => {
		if ( ! readMiniChain ) {
			const miniFatSectors = content.readUInt32LE( 0x40 );
			const miniFat = miniFatSectors <= sectorCount ? readChain( content.readUInt32LE( 0x3c ), miniFatSectors * sectorSize ) : null;
			const miniStream = readChain( root.start, root.size );
			readMiniChain = miniFat && miniStream ?
				chainReader(
					miniFat,
					( index ) => miniStream.subarray( index * MINI_SECTOR_SIZE, ( index + 1 ) * MINI_SECTOR_SIZE ),
					Math.ceil( miniStream.length / MINI_SECTOR_SIZE ),
					MINI_SECTOR_SIZE
				) :
				() => null;
		}
		return readMiniChain( start, size );
	};

	return {
		names: directory.flatMap( ( entry ) => ( entry ? [ entry.name ] : [] ) ),
		readStream( name ) {
			const entry = children.find( ( child ) => child.type === STREAM && child.name.toLowerCase() === name.toLowerCase() );
			if ( ! entry ) {
				return null;
			}
			if ( entry.size === 0 ) {
				return Buffer.alloc( 0 );
			}
			return entry.size < MINI_STREAM_CUTOFF ? readSmallStream( entry.start, entry.size ) : readChain( entry.start, entry.size );
		},
	};
}
