import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { inspectAsf } from './asf-media.js';

const TITLE = 'SecretTitle';
const ARTIST = 'TestArtist';

/** On-disk bytes of the GUIDs the tests build files from. */
const HEADER = Buffer.from( '3026b2758e66cf11a6d900aa0062ce6c', 'hex' );
const DATA = Buffer.from( '3626b2758e66cf11a6d900aa0062ce6c', 'hex' );
const FILE_PROPERTIES = Buffer.from( 'a1dcab8c47a9cf118ee400c00c205365', 'hex' );
const STREAM_PROPERTIES = Buffer.from( '9107dcb7b7a9cf118ee600c00c205365', 'hex' );
const HEADER_EXTENSION = Buffer.from( 'b503bf5f2ea9cf118ee300c00c205365', 'hex' );
const CONTENT_DESCRIPTION = Buffer.from( '3326b2758e66cf11a6d900aa0062ce6c', 'hex' );
const AUDIO_MEDIA = Buffer.from( '409e69f84d5bcf11a8fd00805f5c442b', 'hex' );
const VIDEO_MEDIA = Buffer.from( 'c0ef19bc4d5bcf11a8fd00805f5c442b', 'hex' );
const SCRIPT_COMMAND = Buffer.from( '301afb1e620bd011a39b00a0c90348f6', 'hex' );
const CONTENT_ENCRYPTION = Buffer.from( 'fbb3112223bdd211b4b700a0c955fc6e', 'hex' );
const EXTENDED_CONTENT_ENCRYPTION = Buffer.from( '14e68a292226174cb935dae07ee9289c', 'hex' );
const DIGITAL_SIGNATURE = Buffer.from( 'fcb3112223bdd211b4b700a0c955fc6e', 'hex' );
const ADVANCED_CONTENT_ENCRYPTION = Buffer.from( '338505438169e6499b74ad12cb86d58c', 'hex' );
const METADATA = Buffer.from( 'eacbf8c5af5b77488467aa8c44fa4cca', 'hex' );

function fixture( name: string ): Buffer {
	return readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) );
}

function object( id: Buffer, payload: Buffer = Buffer.alloc( 0 ) ): Buffer {
	const size = Buffer.alloc( 8 );
	size.writeBigUInt64LE( BigInt( payload.length + 24 ) );
	return Buffer.concat( [ id, size, payload ] );
}

function streamProperties( type: Buffer ): Buffer {
	return object( STREAM_PROPERTIES, Buffer.concat( [ type, Buffer.alloc( 40 ) ] ) );
}

function headerExtension( ...children: Buffer[] ): Buffer {
	const body = Buffer.concat( children );
	const prefix = Buffer.alloc( 22 );
	prefix.writeUInt32LE( body.length, 18 );
	return object( HEADER_EXTENSION, Buffer.concat( [ prefix, body ] ) );
}

function headerObject( ...children: Buffer[] ): Buffer {
	const prefix = Buffer.from( [ children.length, 0, 0, 0, 1, 2 ] );
	return object( HEADER, Buffer.concat( [ prefix, ...children ] ) );
}

const dataObject = (): Buffer => object( DATA, Buffer.alloc( 26, 7 ) );
const fileProperties = (): Buffer => object( FILE_PROPERTIES, Buffer.alloc( 80 ) );

/** A minimal valid WMA whose header holds `extra`. */
function wma( ...extra: Buffer[] ): Buffer {
	return Buffer.concat( [ headerObject( fileProperties(), streamProperties( AUDIO_MEDIA ), ...extra ), dataObject() ] );
}

/** The payload of the first top-level object with the id `id`. */
function topLevel( bytes: Buffer, id: Buffer ): Buffer | undefined {
	for ( let offset = 0; offset + 24 <= bytes.length; ) {
		const size = Number( bytes.readBigUInt64LE( offset + 16 ) );
		if ( bytes.subarray( offset, offset + 16 ).equals( id ) ) {
			return bytes.subarray( offset + 24, offset + size );
		}
		offset += size;
	}
	return undefined;
}

const utf16 = ( value: string ): Buffer => Buffer.from( value, 'utf16le' );

describe( 'inspectAsf', () => {
	it.each( [
		[ 'media-tagged.wma', false ],
		[ 'video-tagged.wmv', true ],
	] )( 'removes the tags from %s without changing its size or media data', ( name, video ) => {
		const input = fixture( name );
		const inputCopy = Buffer.from( input );
		expect( input.includes( utf16( TITLE ) ) ).toBe( true );

		const { verdict, bytes } = inspectAsf( input, video );

		expect( verdict ).toBe( 'valid' );
		expect( input.equals( inputCopy ) ).toBe( true );
		expect( bytes!.length ).toBe( input.length );
		expect( bytes!.includes( utf16( TITLE ) ) ).toBe( false );
		expect( bytes!.includes( utf16( ARTIST ) ) ).toBe( false );
		expect( topLevel( bytes!, DATA )!.equals( topLevel( input, DATA )! ) ).toBe( true );
		expect( inspectAsf( bytes!, video ).bytes ).toBe( bytes );
	} );

	it( 'blanks the content description of a byte-built file', () => {
		const description = object( CONTENT_DESCRIPTION, Buffer.concat( [ Buffer.from( [ 24, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] ), utf16( TITLE ) ] ) );
		const input = wma( description );
		const { verdict, bytes } = inspectAsf( input, false );

		expect( verdict ).toBe( 'valid' );
		expect( bytes!.length ).toBe( input.length );
		expect( bytes!.includes( utf16( TITLE ) ) ).toBe( false );
	} );

	it( 'blanks a Metadata Object inside the header extension', () => {
		const input = wma( headerExtension( object( METADATA, utf16( TITLE ) ) ) );
		const { verdict, bytes } = inspectAsf( input, false );

		expect( verdict ).toBe( 'valid' );
		expect( bytes!.length ).toBe( input.length );
		expect( bytes!.includes( utf16( TITLE ) ) ).toBe( false );
	} );

	it( 'returns the input itself when there is nothing to remove', () => {
		const input = wma();
		expect( inspectAsf( input, false ).bytes ).toBe( input );
	} );

	it( 'refuses a wma that holds a video stream and a wmv without one', () => {
		expect( inspectAsf( fixture( 'video-tagged.wmv' ), false ).verdict ).toBe( 'mismatch' );
		expect( inspectAsf( fixture( 'media-tagged.wma' ), true ).verdict ).toBe( 'mismatch' );
	} );

	it( 'accepts a byte-built wmv', () => {
		const input = Buffer.concat( [ headerObject( fileProperties(), streamProperties( VIDEO_MEDIA ) ), dataObject() ] );
		expect( inspectAsf( input, true ).verdict ).toBe( 'valid' );
	} );

	it( 'refuses a Script Command Object in the header', () => {
		expect( inspectAsf( wma( object( SCRIPT_COMMAND, Buffer.alloc( 20 ) ) ), false ) ).toEqual( { verdict: 'macros', bytes: null } );
	} );

	it( 'refuses a Script Command Object inside the header extension', () => {
		expect( inspectAsf( wma( headerExtension( object( SCRIPT_COMMAND, Buffer.alloc( 20 ) ) ) ), false ).verdict ).toBe( 'macros' );
	} );

	it.each( [
		[ 'Content Encryption', CONTENT_ENCRYPTION ],
		[ 'Extended Content Encryption', EXTENDED_CONTENT_ENCRYPTION ],
		[ 'Digital Signature', DIGITAL_SIGNATURE ],
	] )( 'refuses a %s Object', ( _name, id ) => {
		expect( inspectAsf( wma( object( id, Buffer.alloc( 20 ) ) ), false ) ).toEqual( { verdict: 'encrypted', bytes: null } );
	} );

	it( 'refuses an Advanced Content Encryption Object inside the header extension', () => {
		expect( inspectAsf( wma( headerExtension( object( ADVANCED_CONTENT_ENCRYPTION, Buffer.alloc( 20 ) ) ) ), false ).verdict ).toBe( 'encrypted' );
	} );

	describe( 'mismatch', () => {
		const valid = wma();

		it.each( [
			[ 'not ASF', Buffer.from( 'RIFF....WAVEfmt ' ) ],
			[ 'empty', Buffer.alloc( 0 ) ],
			[ 'truncated object', valid.subarray( 0, valid.length - 5 ) ],
			[ 'trailing bytes', Buffer.concat( [ valid, Buffer.alloc( 5 ) ] ) ],
			[ 'no Data Object', headerObject( fileProperties(), streamProperties( AUDIO_MEDIA ) ) ],
			[ 'no File Properties Object', Buffer.concat( [ headerObject( streamProperties( AUDIO_MEDIA ) ), dataObject() ] ) ],
			[ 'no Stream Properties Object', Buffer.concat( [ headerObject( fileProperties() ), dataObject() ] ) ],
			[ 'unknown object after the Data Object', Buffer.concat( [ valid, object( CONTENT_DESCRIPTION ) ] ) ],
		] )( '%s', ( _name, input ) => {
			expect( inspectAsf( input, false ) ).toEqual( { verdict: 'mismatch', bytes: null } );
		} );

		it( 'an object size past the end of the file', () => {
			const input = Buffer.from( valid );
			input.writeBigUInt64LE( BigInt( input.length + 1 ), input.length - 26 - 24 + 16 );
			expect( inspectAsf( input, false ).verdict ).toBe( 'mismatch' );
		} );

		it( 'an object size below 24', () => {
			const input = Buffer.from( valid );
			input.writeBigUInt64LE( 23n, input.length - 26 - 24 + 16 );
			expect( inspectAsf( input, false ).verdict ).toBe( 'mismatch' );
		} );

		it( 'a header child that runs past the header', () => {
			const input = Buffer.from( valid );
			input.writeBigUInt64LE( 1000n, 30 + 16 );
			expect( inspectAsf( input, false ).verdict ).toBe( 'mismatch' );
		} );

		it( 'a header extension whose data size is wrong', () => {
			const input = wma( headerExtension( object( METADATA ) ) );
			const at = input.indexOf( HEADER_EXTENSION ) + 24 + 18;
			input.writeUInt32LE( 5, at );
			expect( inspectAsf( input, false ).verdict ).toBe( 'mismatch' );
		} );
	} );
} );
