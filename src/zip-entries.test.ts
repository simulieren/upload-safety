import { describe, expect, it } from 'vitest';

import {
	MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES, MAX_ZIP_UNCOMPRESSED_BYTES, readZipEntries, readZipEntryData
} from './zip-entries.js';
import { buildZip } from './zip-fixture.js';

const DOCX = { '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' };

function toBuffer( bytes: Uint8Array ): Buffer {
	return Buffer.from( bytes.buffer, bytes.byteOffset, bytes.byteLength );
}

/** Rewrites the central `compressedSize` of the entry at `index`. */
function setCompressedSize( zip: Buffer, index: number, size: number ): void {
	let position = zip.readUInt32LE( zip.length - 22 + 16 );
	for ( let skipped = 0; skipped < index; skipped++ ) {
		position += 46 + zip.readUInt16LE( position + 28 );
	}
	zip.writeUInt32LE( size, position + 20 );
}

/** The DOCX fixture with `comment` after its end record, declared as `declaredLength` bytes. */
function withComment( comment: Buffer, declaredLength = comment.length ): Buffer {
	const zip = toBuffer( buildZip( DOCX ) );
	zip.writeUInt16LE( declaredLength, zip.length - 2 );
	return Buffer.concat( [ zip, comment ] );
}

/** The DOCX fixture with `bytes` inserted at `offset`, its central directory moved along. */
function withGap( offset: number, bytes: Buffer ): Buffer {
	const zip = toBuffer( buildZip( DOCX ) );
	const eocd = zip.length - 22;
	const directoryOffset = zip.readUInt32LE( eocd + 16 );
	let position = directoryOffset;
	for ( let index = 0; index < zip.readUInt16LE( eocd + 10 ); index++ ) {
		const localHeaderOffset = zip.readUInt32LE( position + 42 );
		if ( localHeaderOffset >= offset ) {
			zip.writeUInt32LE( localHeaderOffset + bytes.length, position + 42 );
		}
		position += 46 + zip.readUInt16LE( position + 28 );
	}
	zip.writeUInt32LE( directoryOffset + bytes.length, eocd + 16 );
	return Buffer.concat( [ zip.subarray( 0, offset ), bytes, zip.subarray( offset ) ] );
}

/** The local header and data of an entry no central directory lists. */
function hiddenEntry(): Buffer {
	const zip = toBuffer( buildZip( { 'word/vbaProject.bin': 'vba' } ) );
	return zip.subarray( 0, zip.readUInt32LE( zip.length - 22 + 16 ) );
}

describe( 'readZipEntries', () => {
	it( 'reads stored and deflated entries', () => {
		const entries = readZipEntries( toBuffer( buildZip( {
			...DOCX, 'word/styles.xml': { text: '<w:styles>'.repeat( 50 ), deflate: true },
		} ) ) );

		expect( entries?.map( ( entry ) => [ entry.name, entry.method ] ) ).toEqual( [
			[ '[Content_Types].xml', 0 ], [ 'word/document.xml', 0 ], [ 'word/styles.xml', 8 ],
		] );
		expect( entries?.[ 2 ].compressedSize ).toBeLessThan( entries?.[ 2 ].uncompressedSize ?? 0 );
	} );

	it( 'accepts a data descriptor flag, taking the sizes from the central directory', () => {
		const zip = buildZip( { ...DOCX, 'word/styles.xml': { text: '<w:styles/>', centralFlags: 0x0808, localFlags: 0x0808 } } );

		expect( readZipEntries( toBuffer( zip ) ) ).toHaveLength( 3 );
	} );

	it( 'accepts a data descriptor without its optional signature', () => {
		const zip = buildZip( { ...DOCX, 'word/styles.xml': {
			text: '<w:styles/>', centralFlags: 0x0808, localFlags: 0x0808, descriptorSignature: false,
		} } );

		expect( readZipEntries( toBuffer( zip ) ) ).toHaveLength( 3 );
	} );

	it( 'rejects local sizes next to a data descriptor that differ from the central ones', () => {
		const descriptorFirst = () => toBuffer( buildZip( { 'a.xml': { text: '<a/>', centralFlags: 0x0808, localFlags: 0x0808 }, ...DOCX } ) );
		const matching = descriptorFirst();
		matching.writeUInt32LE( 4, 22 );
		const differing = descriptorFirst();
		differing.writeUInt32LE( 99, 22 );

		expect( readZipEntries( matching ) ).toHaveLength( 3 );
		expect( readZipEntries( differing ) ).toBeNull();
	} );

	it( 'rejects local fields that disagree with the central directory', () => {
		const otherFlags = buildZip( { ...DOCX, 'word/styles.xml': { text: '<w:styles/>', localFlags: 0x0002 } } );
		const otherSize = buildZip( { ...DOCX, 'word/styles.xml': { text: '<w:styles/>', localCompressedSize: 3 } } );
		const otherCrc = buildZip( { ...DOCX, 'word/styles.xml': { text: '<w:styles/>', localCrc: 1 } } );

		for ( const zip of [ otherFlags, otherSize, otherCrc ] ) {
			expect( readZipEntries( toBuffer( zip ) ) ).toBeNull();
		}
	} );

	it( 'rejects a data descriptor that disagrees with the central directory', () => {
		const otherSize = buildZip( { ...DOCX, 'word/styles.xml': {
			text: '<w:styles/>', centralFlags: 0x0808, localFlags: 0x0808, localCompressedSize: 3,
		} } );
		const otherCrc = buildZip( { ...DOCX, 'word/styles.xml': {
			text: '<w:styles/>', centralFlags: 0x0808, localFlags: 0x0808, localCrc: 1,
		} } );

		expect( readZipEntries( toBuffer( otherSize ) ) ).toBeNull();
		expect( readZipEntries( toBuffer( otherCrc ) ) ).toBeNull();
	} );

	it( 'rejects names that start at a root or a drive or climb out of the archive', () => {
		for ( const name of [ '/etc/passwd', '\\evil', 'C:\\evil', 'C:/evil', 'c:evil', '../evil.sh', '..\\evil.sh', 'a\\..\\b', 'a/../b', 'word/a\0.xml' ] ) {
			expect( readZipEntries( toBuffer( buildZip( { ...DOCX, [ name ]: '' } ) ) ) ).toBeNull();
		}
		expect( readZipEntries( toBuffer( buildZip( { ...DOCX, 'word/C:evil.xml': '', 'word/a..b.xml': '' } ) ) ) ).toHaveLength( 4 );
	} );

	it( 'rejects a local name that differs from the central one', () => {
		const zip = buildZip( { ...DOCX, 'word/styles.xml': { text: '', localName: 'word/vbaProject.bin' } } );

		expect( readZipEntries( toBuffer( zip ) ) ).toBeNull();
	} );

	it( 'rejects an entry encrypted in either header', () => {
		expect( readZipEntries( toBuffer( buildZip( { ...DOCX, 'word/a.xml': { text: '', centralFlags: 0x0801 } } ) ) ) ).toBeNull();
		expect( readZipEntries( toBuffer( buildZip( { ...DOCX, 'word/a.xml': { text: '', localFlags: 0x0801 } } ) ) ) ).toBeNull();
	} );

	it( 'rejects an unsupported or mismatched compression method', () => {
		expect( readZipEntries( toBuffer( buildZip( { ...DOCX, 'word/a.xml': { text: '', method: 99 } } ) ) ) ).toBeNull();

		const zip = toBuffer( buildZip( DOCX ) );
		zip.writeUInt16LE( 8, 8 );
		expect( readZipEntries( zip ) ).toBeNull();
	} );

	it( 'rejects a missing local header', () => {
		const zip = toBuffer( buildZip( DOCX ) );
		zip.writeUInt32LE( 0, 0 );

		expect( readZipEntries( zip ) ).toBeNull();
	} );

	it( 'rejects entry data that runs into the central directory', () => {
		const zip = toBuffer( buildZip( DOCX ) );
		setCompressedSize( zip, 1, 14 );

		expect( readZipEntries( zip ) ).toBeNull();
	} );

	it( 'rejects entries that overlap', () => {
		const zip = toBuffer( buildZip( DOCX ) );
		setCompressedSize( zip, 0, 9 );

		expect( readZipEntries( zip ) ).toBeNull();
	} );

	// A reader that walks the local headers from the start would find an entry the checks never saw.
	it( 'rejects bytes that belong to no entry, before, between or after the entries', () => {
		const zip = toBuffer( buildZip( DOCX ) );
		const second = readZipEntries( zip )![ 1 ].localHeaderOffset;
		const directoryOffset = zip.readUInt32LE( zip.length - 22 + 16 );

		expect( readZipEntries( withGap( 0, hiddenEntry() ) ) ).toBeNull();
		expect( readZipEntries( withGap( second, hiddenEntry() ) ) ).toBeNull();
		expect( readZipEntries( withGap( directoryOffset, hiddenEntry() ) ) ).toBeNull();
		expect( readZipEntries( withGap( second, Buffer.alloc( 1 ) ) ) ).toBeNull();
	} );

	it( 'accepts exactly the most entries it reads and refuses one more', () => {
		const files = ( count: number ) => Object.fromEntries( Array.from( { length: count }, ( _, index ) => [ `word/media/image${ index }.png`, '' ] ) );

		expect( readZipEntries( toBuffer( buildZip( files( MAX_ZIP_ENTRIES ) ) ) ) ).toHaveLength( MAX_ZIP_ENTRIES );
		expect( readZipEntries( toBuffer( buildZip( files( MAX_ZIP_ENTRIES + 1 ) ) ) ) ).toBeNull();
	} );

	it( 'refuses entries whose sizes only add up past the limit', () => {
		const entry = { text: '', declaredSize: Math.floor( MAX_ZIP_UNCOMPRESSED_BYTES / 3 ) + 1 };

		expect( readZipEntries( toBuffer( buildZip( { 'a.xml': entry, 'b.xml': entry } ) ) ) ).toHaveLength( 2 );
		expect( readZipEntries( toBuffer( buildZip( { 'a.xml': entry, 'b.xml': entry, 'c.xml': entry } ) ) ) ).toBeNull();
	} );

	it( 'accepts a total exactly at the limit and refuses one byte more', () => {
		const half = MAX_ZIP_UNCOMPRESSED_BYTES / 2;
		const zip = ( last: number ) => toBuffer( buildZip( { 'a.xml': { text: '', declaredSize: half }, 'b.xml': { text: '', declaredSize: last } } ) );

		expect( readZipEntries( zip( half ) ) ).toHaveLength( 2 );
		expect( readZipEntries( zip( half + 1 ) ) ).toBeNull();
	} );

	it( 'accepts an entry exactly at its limit and refuses one byte more', () => {
		const zip = ( size: number ) => toBuffer( buildZip( { 'a.xml': { text: '', declaredSize: size } } ) );

		expect( readZipEntries( zip( MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES ) ) ).toHaveLength( 1 );
		expect( readZipEntries( zip( MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1 ) ) ).toBeNull();
	} );

	it( 'finds the end record before a comment and ignores a signature inside it', () => {
		expect( readZipEntries( withComment( Buffer.from( 'Erstellt mit Word' ) ) ) ).toHaveLength( 2 );
		expect( readZipEntries( withComment( Buffer.from( `PK\x05\x06${ 'x'.repeat( 30 ) }`, 'latin1' ) ) ) ).toHaveLength( 2 );
	} );

	it( 'rejects a comment of another length than declared and bytes after the archive', () => {
		const comment = Buffer.from( 'Erstellt mit Word' );
		const trailing = toBuffer( buildZip( DOCX ) );

		expect( readZipEntries( withComment( comment, comment.length - 1 ) ) ).toBeNull();
		expect( readZipEntries( withComment( comment, comment.length + 1 ) ) ).toBeNull();
		expect( readZipEntries( Buffer.concat( [ trailing, Buffer.from( 'junk' ) ] ) ) ).toBeNull();
	} );

	it( 'rejects ZIP64 markers, another disk and an empty archive', () => {
		const withEnd = ( change: ( zip: Buffer, end: number ) => void ) => {
			const zip = toBuffer( buildZip( DOCX ) );
			change( zip, zip.length - 22 );
			return zip;
		};
		const zip64Count = withEnd( ( zip, end ) => {
			zip.writeUInt16LE( 0xffff, end + 8 );
			zip.writeUInt16LE( 0xffff, end + 10 );
		} );

		expect( readZipEntries( zip64Count ) ).toBeNull();
		expect( readZipEntries( withEnd( ( zip, end ) => zip.writeUInt32LE( 0xffffffff, end + 16 ) ) ) ).toBeNull();
		expect( readZipEntries( withEnd( ( zip, end ) => zip.writeUInt16LE( 1, end + 4 ) ) ) ).toBeNull();
		expect( readZipEntries( toBuffer( buildZip( {} ) ) ) ).toBeNull();
	} );
} );

describe( 'readZipEntryData', () => {
	const zip = toBuffer( buildZip( {
		'stored.xml': '<a/>', 'deflated.xml': { text: 'x'.repeat( 5000 ), deflate: true }, 'broken.xml': { text: '<Types/>', method: 8 },
	} ) );
	const [ stored, deflated, broken ] = readZipEntries( zip ) ?? [];

	it( 'returns stored and inflated bytes', () => {
		expect( readZipEntryData( zip, stored, 100 )?.toString() ).toBe( '<a/>' );
		expect( readZipEntryData( zip, deflated, 5000 )?.toString() ).toBe( 'x'.repeat( 5000 ) );
	} );

	it( 'returns null past the cap or for data that does not inflate', () => {
		expect( readZipEntryData( zip, stored, 3 ) ).toBeNull();
		expect( readZipEntryData( zip, deflated, 4999 ) ).toBeNull();
		expect( readZipEntryData( zip, { ...deflated, uncompressedSize: 10 }, 4999 ) ).toBeNull();
		expect( readZipEntryData( zip, broken, 100 ) ).toBeNull();
	} );
} );
