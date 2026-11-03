/**
 * Test helpers: a version 3 compound file with real FAT, mini FAT and
 * directory, and the streams of a minimal PowerPoint document.
 */

export const OLE_SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const MINI_STREAM_CUTOFF = 4096;
const HEADER_FAT_SECTORS = 109;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const NO_ENTRY = 0xffffffff;

interface FixtureNode {
	name: string;
	/** Stream bytes; storages have none. */
	data?: Buffer;
	children: FixtureNode[];
	start: number;
}

function uint32s( values: number[] ): Buffer {
	const buffer = Buffer.alloc( values.length * 4 );
	values.forEach( ( value, index ) => buffer.writeUInt32LE( value, index * 4 ) );
	return buffer;
}

/** Appends `data` as a chain of blocks and returns its first block, or END_OF_CHAIN when empty. */
function allocate( table: number[], blocks: Buffer[], data: Buffer, blockSize: number ): number {
	if ( ! data.length ) {
		return END_OF_CHAIN;
	}
	const start = blocks.length;
	for ( let offset = 0; offset < data.length; offset += blockSize ) {
		const block = Buffer.alloc( blockSize );
		data.copy( block, 0, offset, offset + blockSize );
		blocks.push( block );
		table.push( offset + blockSize < data.length ? blocks.length : END_OF_CHAIN );
	}
	return start;
}

function directoryEntry( node: FixtureNode, type: number, right: number, child: number, size: number ): Buffer {
	const entry = Buffer.alloc( 128 );
	const name = Buffer.from( `${ node.name }\0`, 'utf16le' );
	name.copy( entry );
	entry.writeUInt16LE( name.length, 0x40 );
	entry[ 0x42 ] = type;
	entry[ 0x43 ] = 1;
	entry.writeUInt32LE( NO_ENTRY, 0x44 );
	entry.writeUInt32LE( right, 0x48 );
	entry.writeUInt32LE( child, 0x4c );
	entry.writeUInt32LE( node.start, 0x74 );
	entry.writeUInt32LE( size, 0x78 );
	return entry;
}

/**
 * A compound file holding `files`, keyed by path (`Macros/VBA/dir` creates the
 * storages). Data sectors come first, then the FAT and any DIFAT sectors.
 */
export function buildOle( files: Record<string, Buffer | string> ): Buffer {
	const root: FixtureNode = { name: 'Root Entry', children: [], start: END_OF_CHAIN };
	for ( const [ path, value ] of Object.entries( files ) ) {
		const parts = path.split( '/' );
		let parent = root;
		for ( const part of parts.slice( 0, -1 ) ) {
			let storage = parent.children.find( ( child ) => child.name === part && ! child.data );
			if ( ! storage ) {
				storage = { name: part, children: [], start: 0 };
				parent.children.push( storage );
			}
			parent = storage;
		}
		parent.children.push( { name: parts[ parts.length - 1 ], data: Buffer.from( value ), children: [], start: END_OF_CHAIN } );
	}
	const nodes: FixtureNode[] = [];
	const visit = ( node: FixtureNode ) => {
		nodes.push( node );
		node.children.forEach( visit );
	};
	visit( root );

	const fat: number[] = [];
	const sectors: Buffer[] = [];
	const miniFat: number[] = [];
	const miniSectors: Buffer[] = [];
	for ( const node of nodes ) {
		if ( node.data ) {
			node.start = node.data.length < MINI_STREAM_CUTOFF ?
				allocate( miniFat, miniSectors, node.data, MINI_SECTOR_SIZE ) :
				allocate( fat, sectors, node.data, OLE_SECTOR_SIZE );
		}
	}
	const miniStream = Buffer.concat( miniSectors );
	root.start = allocate( fat, sectors, miniStream, OLE_SECTOR_SIZE );
	const miniFatStart = allocate( fat, sectors, uint32s( miniFat ), OLE_SECTOR_SIZE );

	const entries = nodes.map( ( node ) => {
		const siblings = nodes.find( ( parent ) => parent.children.includes( node ) )?.children ?? [];
		const next = siblings[ siblings.indexOf( node ) + 1 ];
		const type = node === root ? 5 : node.data ? 2 : 1;
		const size = node === root ? miniStream.length : node.data?.length ?? 0;
		return directoryEntry( node, type, next ? nodes.indexOf( next ) : NO_ENTRY, node.children.length ? nodes.indexOf( node.children[ 0 ] ) : NO_ENTRY, size );
	} );
	const directoryStart = allocate( fat, sectors, Buffer.concat( entries ), OLE_SECTOR_SIZE );

	// The FAT also covers its own sectors and those of the DIFAT listing it.
	const perSector = OLE_SECTOR_SIZE / 4;
	let fatSectors = 1;
	let difatSectors = 0;
	while ( fatSectors * perSector < sectors.length + fatSectors + difatSectors ) {
		fatSectors++;
		difatSectors = Math.max( 0, Math.ceil( ( fatSectors - HEADER_FAT_SECTORS ) / ( perSector - 1 ) ) );
	}
	const fatStart = sectors.length;
	const difatStart = fatStart + fatSectors;
	fat.push( ...Array<number>( fatSectors ).fill( FAT_SECTOR ), ...Array<number>( difatSectors ).fill( DIFAT_SECTOR ) );
	fat.push( ...Array<number>( fatSectors * perSector - fat.length ).fill( FREE_SECTOR ) );
	const fatSectorIndexes = Array.from( { length: fatSectors }, ( _, index ) => fatStart + index );
	const difat = Array.from( { length: difatSectors }, ( _, index ) => {
		const listed = fatSectorIndexes.slice( HEADER_FAT_SECTORS + index * ( perSector - 1 ), HEADER_FAT_SECTORS + ( index + 1 ) * ( perSector - 1 ) );
		const next = index + 1 < difatSectors ? difatStart + index + 1 : END_OF_CHAIN;
		return uint32s( [ ...listed, ...Array<number>( perSector - 1 - listed.length ).fill( FREE_SECTOR ), next ] );
	} );

	const header = Buffer.alloc( OLE_SECTOR_SIZE );
	Buffer.from( [ 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1 ] ).copy( header );
	header.writeUInt16LE( 0x3e, 0x18 );
	header.writeUInt16LE( 3, 0x1a );
	header.writeUInt16LE( 0xfffe, 0x1c );
	header.writeUInt16LE( 9, 0x1e );
	header.writeUInt16LE( 6, 0x20 );
	header.writeUInt32LE( fatSectors, 0x2c );
	header.writeUInt32LE( directoryStart, 0x30 );
	header.writeUInt32LE( MINI_STREAM_CUTOFF, 0x38 );
	header.writeUInt32LE( miniFatStart, 0x3c );
	header.writeUInt32LE( Math.ceil( miniFat.length * 4 / OLE_SECTOR_SIZE ), 0x40 );
	header.writeUInt32LE( difatSectors ? difatStart : END_OF_CHAIN, 0x44 );
	header.writeUInt32LE( difatSectors, 0x48 );
	for ( let index = 0; index < HEADER_FAT_SECTORS; index++ ) {
		header.writeUInt32LE( fatSectorIndexes[ index ] ?? FREE_SECTOR, 0x4c + index * 4 );
	}
	return Buffer.concat( [ header, ...sectors, uint32s( fat ), ...difat ] );
}

/** Where a sector starts in a file from {@link buildOle}. */
export function oleSectorOffset( sector: number ): number {
	return ( sector + 1 ) * OLE_SECTOR_SIZE;
}

/** BoundSheet8 `dt`: what kind of sheet the workbook lists. */
export const SHEET_TYPE = {
	worksheet: 0, macro: 1, chart: 2, module: 6,
} as const;

export interface WorkbookSheet {
	type: number;
	/** BoundSheet8 `hsState`: 0 visible, 1 hidden, 2 very hidden. */
	state?: number;
}

function biffRecord( type: number, body: Buffer ): Buffer {
	const header = Buffer.alloc( 4 );
	header.writeUInt16LE( type, 0 );
	header.writeUInt16LE( body.length, 2 );
	return Buffer.concat( [ header, body ] );
}

/** A SupBook record: `ctab` sheets, then the path length (or a self or add-in marker) and the path. */
export function supBook( sheetCount: number, pathLength: number, path = '' ): Buffer {
	const body = Buffer.alloc( 5 + path.length );
	body.writeUInt16LE( sheetCount, 0 );
	body.writeUInt16LE( pathLength, 2 );
	body.write( path, 5, 'latin1' );
	return biffRecord( 0x01ae, path ? body : body.subarray( 0, 4 ) );
}

/** The globals of a BIFF8 Workbook stream: BOF, one BoundSheet8 per sheet, further records, EOF. */
export function buildWorkbook( sheets: WorkbookSheet[], records: Buffer[] = [] ): Buffer {
	const bof = Buffer.alloc( 16 );
	bof.writeUInt16LE( 0x0600, 0 );
	bof.writeUInt16LE( 0x0005, 2 );
	const boundSheets = sheets.map( ( { type, state = 0 }, index ) => {
		const name = Buffer.from( `Sheet${ index + 1 }`, 'latin1' );
		const body = Buffer.alloc( 8 + name.length );
		body[ 4 ] = state;
		body[ 5 ] = type;
		body[ 6 ] = name.length;
		name.copy( body, 8 );
		return biffRecord( 0x0085, body );
	} );
	return Buffer.concat( [ biffRecord( 0x0809, bof ), ...boundSheets, ...records, biffRecord( 0x000a, Buffer.alloc( 0 ) ) ] );
}

function record( type: number, body: Buffer, version = 0, instance = 0 ): Buffer {
	const header = Buffer.alloc( 8 );
	header.writeUInt16LE( version | ( instance << 4 ), 0 );
	header.writeUInt16LE( type, 2 );
	header.writeUInt32LE( body.length, 4 );
	return Buffer.concat( [ header, body ] );
}

const container = ( type: number, children: Buffer[], instance = 0 ) => record( type, Buffer.concat( children ), 0xf, instance );

export interface PowerPointFixture {
	/** VBAInfoAtom `fHasMacros`; no VBAInfoContainer at all when undefined. */
	hasMacros?: number;
	/** VBAInfoAtom `persistIdRef`, the persist object holding the VBA project storage. */
	vbaProjectRef?: number;
	/** Bytes no persist entry points at, before the DocumentContainer. */
	prefix?: Buffer;
	/** Length written to the DocumentContainer's header instead of the real one. */
	documentLength?: number;
	/** CurrentUserAtom header token; PowerPoint writes another one for encrypted files. */
	token?: number;
	/** Further persist objects, such as ExOleObjStg records, after the DocumentContainer. */
	objects?: Buffer[];
}

/** The streams of a PowerPoint file: one user edit whose persist directory points at the document. */
export function buildPowerPoint( {
	hasMacros, vbaProjectRef = 0, prefix = Buffer.alloc( 0 ), documentLength, token = 0xe391c05f, objects = [],
}: PowerPointFixture = {} ): Record<string, Buffer> {
	const vbaInfo = hasMacros === undefined ? [] : [ container( 0x03ff, [ record( 0x0400, uint32s( [ vbaProjectRef, hasMacros, 2 ] ), 2 ) ], 1 ) ];
	const document = container( 0x03e8, [ record( 0x03e9, Buffer.alloc( 40 ), 1 ), container( 0x07d0, vbaInfo ) ] );
	if ( documentLength !== undefined ) {
		document.writeUInt32LE( documentLength, 4 );
	}
	const offsets = [ prefix.length ];
	for ( const object of [ document, ...objects.slice( 0, -1 ) ] ) {
		offsets.push( offsets[ offsets.length - 1 ] + object.length );
	}
	const directoryOffset = prefix.length + document.length + objects.reduce( ( sum, object ) => sum + object.length, 0 );
	const directory = record( 0x1772, uint32s( [ 1 | ( offsets.length << 20 ), ...offsets ] ) );
	const editOffset = directoryOffset + directory.length;
	const edit = record( 0x0ff5, uint32s( [ 0, 0x03000000, 0, directoryOffset, 1, 1, 0 ] ) );
	const currentUser = record( 0x0ff6, uint32s( [ 0x14, token, editOffset, 0x03f40000, 0x0003 ] ) );
	return {
		'PowerPoint Document': Buffer.concat( [ prefix, document, ...objects, directory, edit ] ),
		'Current User': currentUser,
	};
}
