import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { checkUpload } from './check-upload.js';
import { ALLOWED_EXTENSIONS, FORMAT_RISK, type AllowedExtension } from './upload-allowlist.js';
import { buildZip } from './zip-fixture.js';

const fixture = ( name: string ) => new Uint8Array( readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) ) );
const MAX = 10 * 1024 * 1024;
const check = ( filename: string, bytes: Uint8Array, allowedExtensions?: readonly AllowedExtension[] ) =>
	checkUpload( { filename, mimeType: '', bytes }, { maxBytes: MAX, allowedExtensions } );
const binary = ( bytes: Uint8Array ) => ( { text: Buffer.from( bytes ).toString( 'latin1' ), encoding: 'latin1' as const } );
const MACRO_DOCX = buildZip( {
	'[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>', 'word/vbaProject.bin': 'x',
} );
const CLEAN_DOCX = buildZip( { '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' } );

describe( 'format risk', () => {
	it( 'accepts only formats of low risk by default', () => {
		expect( ALLOWED_EXTENSIONS ).toEqual( expect.arrayContaining( [ 'pdf', 'docx', 'jpg', 'gif', 'mp3', 'mp4', 'mov', 'webm' ] ) );
		for ( const extension of [ 'md', 'rtf', 'zip', 'tar', 'gz', 'tgz', 'rar', '7z' ] as const ) {
			expect( ALLOWED_EXTENSIONS ).not.toContain( extension );
			expect( check( `file.${ extension }`, new Uint8Array( 8 ) ) ).toEqual( { ok: false, reason: 'type-not-allowed' } );
		}
		expect( ALLOWED_EXTENSIONS.every( ( extension ) => FORMAT_RISK[ extension ] === 'low' ) ).toBe( true );
	} );

	it( 'rates each opt-in format', () => {
		expect( [ 'md', 'rtf', 'zip', 'tar', 'gz', 'tgz' ].map( ( extension ) => FORMAT_RISK[ extension as AllowedExtension ] ) ).toEqual( Array( 6 ).fill( 'elevated' ) );
		expect( [ FORMAT_RISK.rar, FORMAT_RISK[ '7z' ] ] ).toEqual( [ 'unchecked', 'unchecked' ] );
	} );
} );

describe( 'archives', () => {
	const allowed = [ 'zip', 'txt', 'docx' ] as const;

	it( 'passes an archive whose files all pass, and keeps its bytes', () => {
		const bytes = buildZip( { 'notes.txt': 'hello', 'cv.docx': binary( CLEAN_DOCX ) } );
		expect( check( 'files.zip', bytes, allowed ) ).toMatchObject( { ok: true, bytes } );
	} );

	it( 'refuses an archive holding active content with that reason', () => {
		expect( check( 'files.zip', buildZip( { 'report.docx': binary( MACRO_DOCX ) } ), allowed ) ).toEqual( { ok: false, reason: 'macros' } );
	} );

	it( 'refuses files of a format the caller did not allow, other archives and files without an extension', () => {
		for ( const files of [ { 'cv.pdf': '%PDF-1.7' } as Record<string, string | ReturnType<typeof binary>>, { 'inner.zip': binary( buildZip( { 'a.txt': 'a' } ) ) }, { 'README': 'hi' }, { 'run.exe': 'MZ' } ] ) {
			expect( check( 'files.zip', buildZip( files ), allowed ) ).toEqual( { ok: false, reason: 'content-mismatch' } );
		}
	} );

	it( 'refuses a file inside whose structure does not read, which alone would be refused too', () => {
		const truncatedGif = Buffer.from( 'GIF89a\x01\x00\x01\x00', 'latin1' );
		expect( check( 'files.zip', buildZip( { 'a.gif': binary( truncatedGif ) } ), [ 'zip', 'gif' ] ) ).toEqual( { ok: false, reason: 'content-mismatch' } );
	} );

	it( 'checks a tar inside gzip, and a single file named in the gzip header', () => {
		expect( check( 'files.tgz', fixture( 'archive.tgz' ), [ 'tgz', 'txt' ] ).ok ).toBe( true );
		expect( check( 'files.tgz', fixture( 'archive.tgz' ), [ 'tgz' ] ) ).toEqual( { ok: false, reason: 'content-mismatch' } );
		const header = Buffer.from( [ 0x1f, 0x8b, 8, 0x08, 0, 0, 0, 0, 0, 3, ...Buffer.from( 'notes.txt\0' ) ] );
		const gzip = gzipSync( 'hello' );
		const named = Buffer.concat( [ header, gzip.subarray( 10 ) ] );
		expect( check( 'notes.txt.gz', named, [ 'gz', 'txt' ] ).ok ).toBe( true );
		expect( check( 'notes.txt.gz', named, [ 'gz' ] ) ).toEqual( { ok: false, reason: 'content-mismatch' } );
	} );
} );

describe( 'opt-in formats', () => {
	it( 'refuses RTF with an embedded object', () => {
		expect( check( 'letter.rtf', Buffer.from( '{\\rtf1 Hello}' ), [ 'rtf' ] ).ok ).toBe( true );
		expect( check( 'letter.rtf', Buffer.from( '{\\rtf1{\\object\\objemb{\\*\\objdata 01050000}}}' ), [ 'rtf' ] ) ).toEqual( { ok: false, reason: 'macros' } );
	} );

	it( 'checks only the signature of RAR and 7z', () => {
		expect( check( 'a.rar', Buffer.from( 'Rar!\x1a\x07\x01\x00rest', 'latin1' ), [ 'rar' ] ).ok ).toBe( true );
		expect( check( 'a.7z', Buffer.from( '7z\xbc\xaf\x27\x1crest', 'latin1' ), [ '7z' ] ).ok ).toBe( true );
		expect( check( 'a.rar', Buffer.from( 'MZ\x90\x00', 'latin1' ), [ 'rar' ] ) ).toEqual( { ok: false, reason: 'content-mismatch' } );
	} );
} );

describe( 'audio and video', () => {
	it( 'removes the location from a phone video without changing its length', () => {
		const bytes = fixture( 'video-gps.mov' );
		const result = check( 'clip.mov', bytes );
		expect( result.ok ).toBe( true );
		const stored = Buffer.from( result.ok ? result.bytes : [] );
		expect( stored.length ).toBe( bytes.length );
		expect( stored.includes( '+47.2500' ) ).toBe( false );
	} );

	it( 'removes tags from audio and refuses a renamed file', () => {
		const result = check( 'song.mp3', fixture( 'media-tagged.mp3' ) );
		expect( result.ok && Buffer.from( result.bytes ).includes( 'SecretTitle' ) ).toBe( false );
		expect( result.ok ).toBe( true );
		expect( check( 'song.mp3', fixture( 'media-tagged.flac' ) ) ).toEqual( { ok: false, reason: 'content-mismatch' } );
		expect( check( 'clip.mp4', fixture( 'media-tagged.wav' ) ) ).toEqual( { ok: false, reason: 'content-mismatch' } );
	} );
} );
