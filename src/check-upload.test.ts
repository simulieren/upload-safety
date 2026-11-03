import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { checkUpload } from './check-upload.js';
import { buildZip } from './zip-fixture.js';

const fixture = ( name: string ) => new Uint8Array( readFileSync( new URL( `./__fixtures__/${ name }`, import.meta.url ) ) );
const options = { maxBytes: 10 * 1024 * 1024 };
const DOCX = { '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' };

describe( 'checkUpload', () => {
	it( 'returns the sanitized name, canonical MIME type and bytes of a valid file', () => {
		const bytes = buildZip( DOCX );
		expect( checkUpload( { filename: '../Brief.docx', mimeType: 'application/octet-stream', bytes }, options ) ).toEqual( {
			ok: true,
			extension: 'docx',
			filename: 'Brief.docx',
			mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			bytes,
		} );
	} );

	it( 'strips GPS metadata from a photo', () => {
		const photo = fixture( 'photo-gps.jpg' );
		const result = checkUpload( { filename: 'photo.jpg', mimeType: 'image/jpeg', bytes: photo }, options );
		expect( result.ok ).toBe( true );
		const stored = result.ok ? Buffer.from( result.bytes ) : Buffer.alloc( 0 );
		expect( stored.length ).toBeLessThan( photo.length );
		expect( stored.includes( 'GPS' ) ).toBe( false );
	} );

	it( 'names why a file is refused', () => {
		const check = ( filename: string, bytes: Uint8Array ) => checkUpload( { filename, mimeType: '', bytes }, options );
		expect( check( 'cv.pdf', new Uint8Array() ) ).toEqual( { ok: false, reason: 'empty' } );
		expect( check( 'run.exe', new Uint8Array( [ 0x4d, 0x5a ] ) ) ).toEqual( { ok: false, reason: 'type-not-allowed' } );
		expect( check( 'cv.pdf', buildZip( DOCX ) ) ).toEqual( { ok: false, reason: 'content-mismatch' } );
		expect( check( 'cv.docx', buildZip( { ...DOCX, 'word/vbaProject.bin': '' } ) ) ).toEqual( { ok: false, reason: 'macros' } );
		expect( check( 'cv.pdf', fixture( 'pdf-open-password.pdf' ) ) ).toEqual( { ok: false, reason: 'encrypted' } );
	} );

	it( 'refuses a type outside the allowed extensions', () => {
		const result = checkUpload(
			{ filename: 'cv.docx', mimeType: '', bytes: buildZip( DOCX ) },
			{ ...options, allowedExtensions: [ 'pdf' ] }
		);
		expect( result ).toEqual( { ok: false, reason: 'type-not-allowed' } );
	} );
} );
