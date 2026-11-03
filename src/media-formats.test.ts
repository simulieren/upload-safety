import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { checkBmp, checkIco, checkOgg, stripFlac, stripGif, stripMp3, stripWav } from './media-formats.js';

// The audio fixtures are made by ffmpeg from a 0.2 s sine with the title `SecretTitle` and the artist `TestArtist`.
const fixture = ( name: string ) => readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) );
const METADATA_TEXT = [ 'SecretTitle', 'TestArtist' ];
const holdsMetadata = ( bytes: Buffer ) => METADATA_TEXT.some( ( text ) => bytes.includes( text ) );
const bytesOf = ( ...values: number[] ) => Buffer.from( values );
const text = ( value: string ) => Buffer.from( value, 'latin1' );
const u16 = ( value: number ) => {
	const buffer = Buffer.alloc( 2 );
	buffer.writeUInt16LE( value );
	return buffer;
};
const u32 = ( value: number ) => {
	const buffer = Buffer.alloc( 4 );
	buffer.writeUInt32LE( value );
	return buffer;
};
const indexOfBytes = ( haystack: Buffer, needle: Buffer ) => haystack.indexOf( needle );

describe( 'GIF', () => {
	const LZW = bytesOf( 0x02, 0x04, 0x01, 0x4c, 0x7a, 0x05, 0x00 ); // minimum code size 2, two sub-blocks
	const image = Buffer.concat( [ bytesOf( 0x2c ), u16( 0 ), u16( 0 ), u16( 1 ), u16( 1 ), bytesOf( 0 ), LZW.subarray( 0, 1 ), bytesOf( 0x03, 0x4c, 0x7a, 0x05, 0x00 ) ] );
	const imageData = image.subarray( 10 );
	const subBlocks = ( ...blocks: Buffer[] ) => Buffer.concat( [ ...blocks.map( ( block ) => Buffer.concat( [ bytesOf( block.length ), block ] ) ), bytesOf( 0 ) ] );
	const extension = ( label: number, ...blocks: Buffer[] ) => Buffer.concat( [ bytesOf( 0x21, label ), subBlocks( ...blocks ) ] );
	const application = ( id: string, ...blocks: Buffer[] ) => extension( 0xff, text( id ), ...blocks );
	const gce = extension( 0xf9, bytesOf( 0x04, 0x0a, 0x00, 0x00 ) );
	const screen = ( version = 'GIF89a' ) => Buffer.concat( [ text( version ), u16( 1 ), u16( 1 ), bytesOf( 0x80, 0, 0 ), Buffer.alloc( 6 ) ] );
	const gif = ( ...blocks: Buffer[] ) => Buffer.concat( [ screen(), ...blocks, bytesOf( 0x3b ) ] );

	it( 'passes a plain GIF unchanged', () => {
		const file = gif( gce, image );
		expect( stripGif( file ) ).toEqual( file );
	} );

	it( 'accepts GIF87a', () => {
		const file = Buffer.concat( [ screen( 'GIF87a' ), image, bytesOf( 0x3b ) ] );
		expect( stripGif( file ) ).toEqual( file );
	} );

	it( 'drops comments, plain text and XMP and keeps the image data and looping', () => {
		const comment = extension( 0xfe, text( 'SecretComment' ) );
		const plainText = extension( 0x01, Buffer.alloc( 12 ), text( 'SecretText' ) );
		const xmp = application( 'XMP DataXMP', text( '<x:xmpmeta>SecretXmp</x:xmpmeta>' ) );
		const loop = application( 'NETSCAPE2.0', bytesOf( 0x01, 0x00, 0x00 ) );
		const output = stripGif( gif( comment, loop, plainText, gce, xmp, image ) )!;
		expect( output ).toEqual( gif( loop, gce, image ) );
		expect( output.includes( 'Secret' ) ).toBe( false );
		expect( indexOfBytes( output, imageData ) ).toBeGreaterThan( 0 );
	} );

	it( 'keeps ANIMEXTS1.0 and the ICC profile extension', () => {
		const animation = application( 'ANIMEXTS1.0', bytesOf( 0x01, 0x00, 0x00 ) );
		const profile = application( 'ICCRGBG1012', Buffer.alloc( 20, 7 ) );
		const file = gif( animation, profile, image );
		expect( stripGif( file ) ).toEqual( file );
	} );

	it( 'keeps several frames and a local colour table', () => {
		const local = Buffer.concat( [ bytesOf( 0x2c ), u16( 0 ), u16( 0 ), u16( 1 ), u16( 1 ), bytesOf( 0x80 ), Buffer.alloc( 6, 3 ), imageData.subarray( 0, 1 ), bytesOf( 0 ) ] );
		const file = gif( gce, image, gce, local );
		expect( stripGif( file ) ).toEqual( file );
	} );

	it( 'cuts bytes after the trailer', () => {
		const file = Buffer.concat( [ gif( image ), text( 'PK\x03\x04 hidden archive' ) ] );
		expect( stripGif( file ) ).toEqual( gif( image ) );
	} );

	it( 'adds a missing trailer after a complete block', () => {
		const file = Buffer.concat( [ screen(), image ] );
		expect( stripGif( file ) ).toEqual( gif( image ) );
	} );

	it( 'refuses what does not read', () => {
		const whole = gif( image );
		expect( stripGif( whole.subarray( 0, whole.length - 3 ) ) ).toBeNull(); // cut inside the image data
		expect( stripGif( Buffer.concat( [ screen(), gce ] ) ) ).toBeNull(); // no image
		expect( stripGif( gif() ) ).toBeNull();
		expect( stripGif( gif( bytesOf( 0x99 ), image ) ) ).toBeNull(); // unknown block
		expect( stripGif( Buffer.concat( [ text( 'GIF89b' ), whole.subarray( 6 ) ] ) ) ).toBeNull();
		expect( stripGif( Buffer.alloc( 40, 0x41 ) ) ).toBeNull();
		expect( stripGif( Buffer.alloc( 0 ) ) ).toBeNull();
		const tooLong = Buffer.from( whole );
		tooLong[ screen().length + 10 + 1 ] = 0xf0; // a sub-block longer than the file
		expect( stripGif( tooLong ) ).toBeNull();
	} );

	it( 'does not change its input', () => {
		const file = gif( extension( 0xfe, text( 'SecretComment' ) ), image );
		const copy = Buffer.from( file );
		stripGif( file );
		expect( file ).toEqual( copy );
	} );
} );

describe( 'BMP', () => {
	const bmp = ( { dib = 40, offset = 54 + 4, width = 1, height = 1, planes = 1, bits = 24, total = 62 } = {} ) => {
		const file = Buffer.alloc( total );
		file.write( 'BM', 0, 'latin1' );
		file.writeUInt32LE( total, 2 );
		file.writeUInt32LE( offset, 10 );
		file.writeUInt32LE( dib, 14 );
		if ( dib === 12 ) {
			file.writeUInt16LE( width, 18 );
			file.writeUInt16LE( height, 20 );
			file.writeUInt16LE( planes, 22 );
			file.writeUInt16LE( bits, 24 );
		} else {
			file.writeInt32LE( width, 18 );
			file.writeInt32LE( height, 22 );
			file.writeUInt16LE( planes, 26 );
			file.writeUInt16LE( bits, 28 );
		}
		return file;
	};

	it( 'passes valid BMPs unchanged', () => {
		const file = bmp();
		expect( checkBmp( file ) ).toBe( file );
		expect( checkBmp( bmp( { dib: 12, offset: 26, total: 30 } ) ) ).not.toBeNull();
		expect( checkBmp( bmp( { dib: 124, offset: 138, total: 142 } ) ) ).not.toBeNull();
		expect( checkBmp( bmp( { height: -1 } ) ) ).not.toBeNull(); // top-down
	} );

	it( 'refuses what does not read', () => {
		expect( checkBmp( bmp( { dib: 41 } ) ) ).toBeNull();
		expect( checkBmp( bmp( { offset: 60, total: 60 } ) ) ).toBeNull(); // pixel data outside the file
		expect( checkBmp( bmp( { offset: 20 } ) ) ).toBeNull(); // inside the headers
		expect( checkBmp( bmp( { width: 0 } ) ) ).toBeNull();
		expect( checkBmp( bmp( { height: 0 } ) ) ).toBeNull();
		expect( checkBmp( bmp( { bits: 12 } ) ) ).toBeNull();
		expect( checkBmp( bmp( { planes: 2 } ) ) ).toBeNull();
		expect( checkBmp( Buffer.concat( [ text( 'MZ' ), bmp().subarray( 2 ) ] ) ) ).toBeNull();
		expect( checkBmp( bmp().subarray( 0, 20 ) ) ).toBeNull();
		expect( checkBmp( Buffer.alloc( 0 ) ) ).toBeNull();
	} );
} );

describe( 'ICO', () => {
	const bitmapImage = Buffer.concat( [ u32( 40 ), Buffer.alloc( 40 ) ] );
	const pngImage = Buffer.concat( [ bytesOf( 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ), Buffer.alloc( 20 ) ] );
	const ico = ( images: Buffer[], { type = 1, count = images.length } = {} ) => {
		const directorySize = 6 + images.length * 16;
		let offset = directorySize;
		const entries = images.map( ( data ) => {
			const entry = Buffer.concat( [ bytesOf( 16, 16, 0, 0 ), u16( 1 ), u16( 32 ), u32( data.length ), u32( offset ) ] );
			offset += data.length;
			return entry;
		} );
		return Buffer.concat( [ u16( 0 ), u16( type ), u16( count ), ...entries, ...images ] );
	};

	it( 'passes bitmap and PNG icons unchanged', () => {
		const file = ico( [ bitmapImage, pngImage ] );
		expect( checkIco( file ) ).toBe( file );
	} );

	it( 'refuses cursors', () => {
		expect( checkIco( ico( [ bitmapImage ], { type: 2 } ) ) ).toBeNull();
	} );

	it( 'refuses what does not read', () => {
		const file = ico( [ bitmapImage ] );
		expect( checkIco( file.subarray( 0, file.length - 1 ) ) ).toBeNull(); // image past the end
		expect( checkIco( ico( [ bitmapImage ], { count: 0 } ) ) ).toBeNull();
		expect( checkIco( ico( [ bitmapImage ], { count: 257 } ) ) ).toBeNull();
		expect( checkIco( ico( [ bitmapImage ], { count: 2 } ) ) ).toBeNull(); // directory past the end
		expect( checkIco( ico( [ Buffer.alloc( 60, 0x41 ) ] ) ) ).toBeNull(); // neither PNG nor bitmap
		expect( checkIco( ico( [ Buffer.alloc( 0 ) ] ) ) ).toBeNull(); // empty image
		const overlapping = Buffer.from( file );
		overlapping.writeUInt32LE( 0, 6 + 12 ); // image offset inside the directory
		expect( checkIco( overlapping ) ).toBeNull();
		expect( checkIco( bytesOf( 0, 0, 1, 0 ) ) ).toBeNull();
		expect( checkIco( Buffer.alloc( 0 ) ) ).toBeNull();
	} );
} );

describe( 'MP3', () => {
	// MPEG 1 layer III, 128 kbit/s, 44.1 kHz, no padding: 417 bytes per frame.
	const FRAME_HEADER = bytesOf( 0xff, 0xfb, 0x90, 0x00 );
	const frame = ( fill: number ) => Buffer.concat( [ FRAME_HEADER, Buffer.alloc( 413, fill ) ] );
	const audio = Buffer.concat( [ frame( 1 ), frame( 2 ), frame( 3 ) ] );
	const syncsafe = ( value: number ) => bytesOf( ( value >> 21 ) & 0x7f, ( value >> 14 ) & 0x7f, ( value >> 7 ) & 0x7f, value & 0x7f );
	const id3v2 = ( body: string, flags = 0 ) => Buffer.concat( [ text( 'ID3' ), bytesOf( 3, 0, flags ), syncsafe( body.length ), text( body ), flags & 0x10 ? text( '3DI\x03\x00\x10\x00\x00\x00\x00' ) : Buffer.alloc( 0 ) ] );
	const id3v1 = Buffer.concat( [ text( 'TAG' ), text( 'SecretTitle'.padEnd( 125, '\0' ) ) ] );

	it( 'passes bare audio unchanged', () => {
		expect( stripMp3( audio ) ).toEqual( audio );
	} );

	it( 'drops ID3v2 and ID3v1 and keeps the frames byte for byte', () => {
		const output = stripMp3( Buffer.concat( [ id3v2( 'TIT2 SecretTitle TPE1 TestArtist' ), audio, id3v1 ] ) )!;
		expect( output ).toEqual( audio );
	} );

	it( 'drops an ID3v2 tag with a footer', () => {
		expect( stripMp3( Buffer.concat( [ id3v2( 'SecretTitle', 0x10 ), audio ] ) ) ).toEqual( audio );
	} );

	it( 'drops APEv2 with a header and Lyrics3', () => {
		const items = text( 'Title\0SecretTitle' );
		const ape = ( flags: number ) => Buffer.concat( [ text( 'APETAGEX' ), u32( 2000 ), u32( items.length + 32 ), u32( 1 ), u32( flags ), Buffer.alloc( 8 ) ] );
		const withHeader = Buffer.concat( [ ape( 0xa0000000 ), items, ape( 0x80000000 ) ] );
		const lyrics = Buffer.concat( [ text( 'LYRICSBEGININD0000000SecretLyrics' ), text( '000033' ), text( 'LYRICS200' ) ] );
		expect( stripMp3( Buffer.concat( [ audio, withHeader ] ) ) ).toEqual( audio );
		expect( stripMp3( Buffer.concat( [ audio, lyrics, id3v1 ] ) ) ).toEqual( audio );
		expect( stripMp3( Buffer.concat( [ audio, withHeader, id3v1 ] ) ) ).toEqual( audio );
	} );

	it( 'cleans a real file made by ffmpeg', () => {
		const file = fixture( 'media-tagged.mp3' );
		expect( holdsMetadata( file ) ).toBe( true );
		const output = stripMp3( file )!;
		expect( holdsMetadata( output ) ).toBe( false );
		expect( output.length ).toBeLessThan( file.length );
		// ffmpeg writes ID3v2 first and ID3v1 last; what is left is the frames in between.
		const tagLength = file.indexOf( bytesOf( 0xff, 0xfb ) );
		expect( file.subarray( tagLength, tagLength + output.length ).equals( output ) ).toBe( true );
		expect( stripMp3( output ) ).toEqual( output );
	} );

	it( 'accepts a single frame and other MPEG versions', () => {
		expect( stripMp3( frame( 5 ) ) ).toEqual( frame( 5 ) );
		// MPEG 2 layer III, 64 kbit/s, 22.05 kHz: 72 * 64000 / 22050 = 208 bytes.
		const v2 = Buffer.concat( [ bytesOf( 0xff, 0xf3, 0x80, 0x00 ), Buffer.alloc( 204 ) ] );
		expect( stripMp3( v2 ) ).toEqual( v2 );
	} );

	it( 'refuses what does not read', () => {
		expect( stripMp3( audio.subarray( 0, 300 ) ) ).toBeNull(); // first frame cut
		expect( stripMp3( Buffer.concat( [ frame( 1 ), Buffer.alloc( 50, 0x41 ) ] ) ) ).toBeNull(); // junk instead of a second frame
		expect( stripMp3( Buffer.concat( [ id3v2( 'x' ), Buffer.alloc( 500, 0x41 ) ] ) ) ).toBeNull();
		expect( stripMp3( Buffer.concat( [ bytesOf( 0xff, 0xfb, 0xf0, 0 ), Buffer.alloc( 500 ) ] ) ) ).toBeNull(); // bitrate index 15
		expect( stripMp3( Buffer.concat( [ bytesOf( 0xff, 0xfb, 0x9c, 0 ), Buffer.alloc( 500 ) ] ) ) ).toBeNull(); // sample rate index 3
		expect( stripMp3( Buffer.concat( [ bytesOf( 0xff, 0xe9, 0x90, 0 ), Buffer.alloc( 500 ) ] ) ) ).toBeNull(); // reserved version
		expect( stripMp3( Buffer.concat( [ bytesOf( 0xff, 0xf9, 0x90, 0 ), Buffer.alloc( 500 ) ] ) ) ).toBeNull(); // reserved layer
		const tagPastEnd = Buffer.concat( [ text( 'ID3' ), bytesOf( 3, 0, 0 ), syncsafe( 100000 ), audio ] );
		expect( stripMp3( tagPastEnd ) ).toBeNull();
		expect( stripMp3( Buffer.alloc( 0 ) ) ).toBeNull();
		expect( stripMp3( text( 'RIFF....WAVE' ) ) ).toBeNull();
	} );

	it( 'does not change its input', () => {
		const file = Buffer.concat( [ id3v2( 'SecretTitle' ), audio, id3v1 ] );
		const copy = Buffer.from( file );
		stripMp3( file );
		expect( file ).toEqual( copy );
	} );
} );

describe( 'WAV', () => {
	const chunk = ( type: string, payload: Buffer ) => Buffer.concat( [ text( type ), u32( payload.length ), payload, payload.length & 1 ? bytesOf( 0 ) : Buffer.alloc( 0 ) ] );
	const riff = ( ...chunks: Buffer[] ) => {
		const body = Buffer.concat( [ text( 'WAVE' ), ...chunks ] );
		return Buffer.concat( [ text( 'RIFF' ), u32( body.length ), body ] );
	};
	const format = chunk( 'fmt ', Buffer.concat( [ u16( 1 ), u16( 1 ), u32( 8000 ), u32( 16000 ), u16( 2 ), u16( 16 ) ] ) );
	const samples = chunk( 'data', Buffer.from( [ 1, 2, 3, 4, 5, 6, 7, 8, 9 ] ) ); // odd size, so padded

	it( 'passes a plain WAV unchanged', () => {
		const file = riff( format, samples );
		expect( stripWav( file ) ).toEqual( file );
	} );

	it( 'drops metadata chunks and keeps fmt, fact and data byte for byte', () => {
		const fact = chunk( 'fact', u32( 4 ) );
		const info = chunk( 'LIST', Buffer.concat( [ text( 'INFO' ), chunk( 'INAM', text( 'SecretTitle' ) ) ] ) );
		const output = stripWav( riff( info, format, fact, chunk( 'bext', text( 'SecretOrigin' ) ), samples, chunk( 'iXML', text( 'SecretXml' ) ), chunk( '_PMX', text( 'SecretXmp' ) ), chunk( 'id3 ', text( 'SecretTag' ) ) ) )!;
		expect( output ).toEqual( riff( format, fact, samples ) );
		expect( output.includes( 'Secret' ) ).toBe( false );
	} );

	it( 'cuts bytes after the RIFF size', () => {
		const file = riff( format, samples );
		expect( stripWav( Buffer.concat( [ file, text( 'SecretTrailer' ) ] ) ) ).toEqual( file );
	} );

	it( 'cleans a real file made by ffmpeg', () => {
		const file = fixture( 'media-tagged.wav' );
		expect( holdsMetadata( file ) ).toBe( true );
		const output = stripWav( file )!;
		expect( holdsMetadata( output ) ).toBe( false );
		expect( output.includes( 'LIST' ) ).toBe( false );
		const dataAt = file.indexOf( 'data' );
		expect( output.subarray( output.indexOf( 'data' ) ).equals( file.subarray( dataAt ) ) ).toBe( true );
		expect( output.readUInt32LE( 4 ) + 8 ).toBe( output.length );
	} );

	it( 'refuses what does not read', () => {
		const file = riff( format, samples );
		expect( stripWav( file.subarray( 0, file.length - 4 ) ) ).toBeNull(); // RIFF size past the end
		expect( stripWav( riff( samples, format ) ) ).toBeNull(); // data before fmt
		expect( stripWav( riff( format ) ) ).toBeNull(); // no data
		expect( stripWav( riff( samples ) ) ).toBeNull();
		const oversized = Buffer.from( file );
		oversized.writeUInt32LE( 0xffffff, 40 ); // data chunk size past the end
		expect( stripWav( oversized ) ).toBeNull();
		expect( stripWav( Buffer.concat( [ text( 'RIFX' ), file.subarray( 4 ) ] ) ) ).toBeNull();
		expect( stripWav( Buffer.concat( [ file.subarray( 0, 8 ), text( 'AVI ' ), file.subarray( 12 ) ] ) ) ).toBeNull();
		expect( stripWav( Buffer.alloc( 0 ) ) ).toBeNull();
	} );

	it( 'does not change its input', () => {
		const file = riff( chunk( 'LIST', text( 'INFOSecret' ) ), format, samples );
		const copy = Buffer.from( file );
		stripWav( file );
		expect( file ).toEqual( copy );
	} );
} );

describe( 'FLAC', () => {
	const block = ( type: number, payload: Buffer, last = false ) => Buffer.concat( [ bytesOf( type | ( last ? 0x80 : 0 ), ( payload.length >> 16 ) & 0xff, ( payload.length >> 8 ) & 0xff, payload.length & 0xff ), payload ] );
	const streamInfo = ( last = false ) => block( 0, Buffer.alloc( 34, 9 ), last );
	const frames = Buffer.concat( [ bytesOf( 0xff, 0xf8 ), Buffer.alloc( 40, 0x55 ) ] );
	const flac = ( blocks: Buffer[] ) => Buffer.concat( [ text( 'fLaC' ), ...blocks, frames ] );
	const seekTable = ( last = false ) => block( 3, Buffer.alloc( 18, 4 ), last );

	it( 'passes a minimal FLAC unchanged', () => {
		const file = flac( [ streamInfo( true ) ] );
		expect( stripFlac( file ) ).toEqual( file );
	} );

	it( 'drops comments, pictures, applications, padding and unknown blocks and fixes the last flag', () => {
		const vorbis = block( 4, text( 'TITLE=SecretTitle' ) );
		const picture = block( 6, text( 'SecretPicture' ) );
		const application = block( 2, text( 'SecretApp' ) );
		const unknown = block( 100, text( 'SecretUnknown' ) );
		const padding = block( 1, Buffer.alloc( 64 ), true );
		const output = stripFlac( flac( [ streamInfo(), vorbis, seekTable(), picture, application, unknown, padding ] ) )!;
		expect( output ).toEqual( flac( [ streamInfo(), seekTable( true ) ] ) );
		expect( output.includes( 'Secret' ) ).toBe( false );
	} );

	it( 'keeps a cue sheet', () => {
		const cues = block( 5, Buffer.alloc( 396 ) );
		expect( stripFlac( flac( [ streamInfo(), cues, block( 1, Buffer.alloc( 8 ), true ) ] ) ) ).toEqual( flac( [ streamInfo(), block( 5, Buffer.alloc( 396 ), true ) ] ) );
	} );

	it( 'cleans a real file made by ffmpeg', () => {
		const file = fixture( 'media-tagged.flac' );
		expect( holdsMetadata( file ) ).toBe( true );
		const output = stripFlac( file )!;
		expect( holdsMetadata( output ) ).toBe( false );
		// Walk the metadata blocks to find where the frames begin.
		const frameStart = ( bytes: Buffer ) => {
			let at = 4;
			while ( ! ( bytes[ at ] & 0x80 ) ) {
				at += 4 + bytes.readUIntBE( at + 1, 3 );
			}
			return at + 4 + bytes.readUIntBE( at + 1, 3 );
		};
		expect( output.subarray( frameStart( output ) ).equals( file.subarray( frameStart( file ) ) ) ).toBe( true );
		expect( stripFlac( output ) ).toEqual( output );
	} );

	it( 'refuses what does not read', () => {
		expect( stripFlac( flac( [ block( 4, text( 'x' ) ), streamInfo( true ) ] ) ) ).toBeNull(); // STREAMINFO not first
		expect( stripFlac( flac( [ block( 0, Buffer.alloc( 30 ), true ) ] ) ) ).toBeNull(); // wrong STREAMINFO size
		expect( stripFlac( Buffer.concat( [ text( 'fLaC' ), streamInfo( true ), text( 'junk' ) ] ) ) ).toBeNull(); // no frame sync
		expect( stripFlac( Buffer.concat( [ text( 'fLaC' ), streamInfo( true ) ] ) ) ).toBeNull(); // no frames
		expect( stripFlac( Buffer.concat( [ text( 'fLaC' ), streamInfo(), seekTable() ] ) ) ).toBeNull(); // never a last block
		expect( stripFlac( flac( [ streamInfo(), block( 127, Buffer.alloc( 4 ), true ) ] ) ) ).toBeNull();
		const truncated = flac( [ streamInfo(), block( 4, Buffer.alloc( 100 ), true ) ] );
		expect( stripFlac( truncated.subarray( 0, 80 ) ) ).toBeNull(); // block past the end
		const huge = flac( [ streamInfo(), Buffer.concat( [ bytesOf( 0x84, 0xff, 0xff, 0xff ), Buffer.alloc( 4 ) ] ) ] );
		expect( stripFlac( huge ) ).toBeNull();
		const many = Buffer.concat( [ text( 'fLaC' ), streamInfo(), ...Array.from( { length: 100_001 }, () => block( 1, Buffer.alloc( 0 ) ) ), frames ] );
		expect( stripFlac( many ) ).toBeNull();
		expect( stripFlac( text( 'RIFF' ) ) ).toBeNull();
		expect( stripFlac( Buffer.alloc( 0 ) ) ).toBeNull();
	} );

	it( 'does not change its input', () => {
		const file = flac( [ streamInfo(), block( 4, text( 'SecretTitle' ) ), seekTable( true ) ] );
		const copy = Buffer.from( file );
		stripFlac( file );
		expect( file ).toEqual( copy );
	} );
} );

describe( 'Ogg', () => {
	const TABLE = Array.from( { length: 256 }, ( _, index ) => {
		let value = index << 24;
		for ( let bit = 0; bit < 8; bit++ ) {
			value = value & 0x80000000 ? ( value << 1 ) ^ 0x04c11db7 : value << 1;
		}
		return value >>> 0;
	} );
	const crc = ( bytes: Buffer ) => bytes.reduce( ( sum, byte ) => ( ( sum << 8 ) ^ TABLE[ ( ( sum >>> 24 ) ^ byte ) & 0xff ] ) >>> 0, 0 );
	const page = ( body: Buffer, { type = 0, sequence = 0, validCrc = true } = {} ) => {
		const header = Buffer.concat( [ text( 'OggS' ), bytesOf( 0, type ), Buffer.alloc( 8 ), u32( 1234 ), u32( sequence ), u32( 0 ), bytesOf( 1, body.length ) ] );
		const whole = Buffer.concat( [ header, body ] );
		whole.writeUInt32LE( validCrc ? crc( whole ) : 1, 22 );
		return whole;
	};
	const first = page( text( 'first packet' ), { type: 2 } );
	const second = page( text( 'second packet' ), { sequence: 1 } );
	const last = page( text( 'last packet' ), { type: 4, sequence: 2 } );

	it( 'passes valid files unchanged', () => {
		const file = Buffer.concat( [ first, second, last ] );
		expect( checkOgg( file ) ).toBe( file );
		expect( checkOgg( first ) ).toBe( first );
	} );

	it( 'passes a real file made by ffmpeg', () => {
		const file = fixture( 'media-tagged.ogg' );
		expect( checkOgg( file ) ).toBe( file );
	} );

	it( 'refuses a bad checksum', () => {
		expect( checkOgg( Buffer.concat( [ first, page( text( 'x' ), { sequence: 1, validCrc: false } ) ] ) ) ).toBeNull();
		const flipped = Buffer.from( Buffer.concat( [ first, second ] ) );
		flipped[ flipped.length - 1 ] ^= 1;
		expect( checkOgg( flipped ) ).toBeNull();
		const real = Buffer.from( fixture( 'media-tagged.ogg' ) );
		real[ Math.floor( real.length / 2 ) ] ^= 0xff;
		expect( checkOgg( real ) ).toBeNull();
	} );

	it( 'refuses what does not read', () => {
		expect( checkOgg( Buffer.concat( [ second, last ] ) ) ).toBeNull(); // no begin-of-stream page first
		expect( checkOgg( Buffer.concat( [ first, second ] ).subarray( 0, first.length + 20 ) ) ).toBeNull(); // header cut
		expect( checkOgg( Buffer.concat( [ first, second ] ).subarray( 0, first.length + second.length - 2 ) ) ).toBeNull(); // body cut
		expect( checkOgg( Buffer.concat( [ first, text( 'trailing junk' ) ] ) ) ).toBeNull();
		const version = Buffer.from( first );
		version[ 4 ] = 1;
		expect( checkOgg( version ) ).toBeNull();
		expect( checkOgg( Buffer.alloc( 100, 0x41 ) ) ).toBeNull();
		expect( checkOgg( Buffer.alloc( 0 ) ) ).toBeNull();
	} );
} );
