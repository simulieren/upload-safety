import { deflateRawSync } from 'node:zlib';

/** A fixture entry with the header fields a test wants to bend. */
export interface ZipFixtureEntry {
	text: string;
	deflate?: boolean;
	/** Method written to both headers instead of 0 or 8. */
	method?: number;
	centralFlags?: number;
	localFlags?: number;
	/** Name written to the local header instead of the central one. */
	localName?: string;
	/** Encoding of `text`, written with its byte order mark when `bom` is set. */
	encoding?: 'utf8' | 'latin1' | 'utf16le' | 'utf16be';
	bom?: boolean;
	/** Compressed size written to the local header (or data descriptor) instead of the real one. */
	localCompressedSize?: number;
	/** CRC written to the local header (or data descriptor); the central one stays 0. */
	localCrc?: number;
	/** Uncompressed size written to both headers instead of the real one. */
	declaredSize?: number;
	/** Whether a data descriptor starts with its optional signature (default true). */
	descriptorSignature?: boolean;
	/** Extra field written to the local header only. */
	extra?: Buffer;
}

const DATA_DESCRIPTOR_FLAG = 0x0008;

const BYTE_ORDER_MARKS = {
	utf8: [ 0xef, 0xbb, 0xbf ], latin1: [], utf16le: [ 0xff, 0xfe ], utf16be: [ 0xfe, 0xff ],
};

function encodeText( { text, encoding = 'utf8', bom = false }: ZipFixtureEntry ): Buffer {
	const encoded = Buffer.from( text, encoding === 'utf16be' ? 'utf16le' : encoding );
	if ( encoding === 'utf16be' ) {
		encoded.swap16();
	}
	return bom ? Buffer.concat( [ Buffer.from( BYTE_ORDER_MARKS[ encoding ] ), encoded ] ) : encoded;
}

/** Test helper: a ZIP with real headers, stored unless an entry asks to deflate. Central CRCs are left 0. */
export function buildZip( files: Record<string, string | ZipFixtureEntry> ): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for ( const [ name, file ] of Object.entries( files ) ) {
		const entry = typeof file === 'string' ? { text: file } : file;
		const nameBytes = Buffer.from( name, 'utf8' );
		const localNameBytes = Buffer.from( entry.localName ?? name, 'utf8' );
		const raw = encodeText( entry );
		const data = entry.deflate ? deflateRawSync( raw ) : raw;
		const method = entry.method ?? ( entry.deflate ? 8 : 0 );

		const localFlags = entry.localFlags ?? 0x0800;
		const uncompressedSize = entry.declaredSize ?? raw.length;
		const sizes = [ entry.localCrc ?? 0, entry.localCompressedSize ?? data.length, uncompressedSize ];
		const local = Buffer.alloc( 30 );
		local.writeUInt32LE( 0x04034b50, 0 );
		local.writeUInt16LE( 20, 4 );
		local.writeUInt16LE( localFlags, 6 );
		local.writeUInt16LE( method, 8 );
		local.writeUInt16LE( localNameBytes.length, 26 );
		const extra = entry.extra ?? Buffer.alloc( 0 );
		local.writeUInt16LE( extra.length, 28 );
		// With bit 3 the sizes follow the data in a descriptor, as streaming writers do.
		const signatureLength = entry.descriptorSignature === false ? 0 : 4;
		const descriptor = Buffer.alloc( localFlags & DATA_DESCRIPTOR_FLAG ? signatureLength + 12 : 0 );
		if ( descriptor.length ) {
			if ( signatureLength ) {
				descriptor.writeUInt32LE( 0x08074b50, 0 );
			}
			sizes.forEach( ( value, index ) => descriptor.writeUInt32LE( value, signatureLength + index * 4 ) );
		} else {
			sizes.forEach( ( value, index ) => local.writeUInt32LE( value, 14 + index * 4 ) );
		}
		locals.push( local, localNameBytes, extra, data, descriptor );

		const central = Buffer.alloc( 46 );
		central.writeUInt32LE( 0x02014b50, 0 );
		central.writeUInt16LE( 20, 4 );
		central.writeUInt16LE( 20, 6 );
		central.writeUInt16LE( entry.centralFlags ?? 0x0800, 8 );
		central.writeUInt16LE( method, 10 );
		central.writeUInt32LE( data.length, 20 );
		central.writeUInt32LE( uncompressedSize, 24 );
		central.writeUInt16LE( nameBytes.length, 28 );
		central.writeUInt32LE( offset, 42 );
		centrals.push( central, nameBytes );

		offset += local.length + localNameBytes.length + extra.length + data.length + descriptor.length;
	}

	const directory = Buffer.concat( centrals );
	const end = Buffer.alloc( 22 );
	end.writeUInt32LE( 0x06054b50, 0 );
	end.writeUInt16LE( Object.keys( files ).length, 8 );
	end.writeUInt16LE( Object.keys( files ).length, 10 );
	end.writeUInt32LE( directory.length, 12 );
	end.writeUInt32LE( offset, 16 );
	return new Uint8Array( Buffer.concat( [ ...locals, directory, end ] ) );
}
