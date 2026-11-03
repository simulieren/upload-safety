import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { inspectRtf } from './rtf-content.js';

const rtf = ( value: string ) => Buffer.from( value, 'latin1' );

describe( 'RTF', () => {
	it( 'accepts plain documents, also with the word DDE in the text', () => {
		expect( inspectRtf( rtf( '{\\rtf1\\ansi Hello DDE world}' ) ) ).toBe( 'valid' );
		expect( inspectRtf( rtf( '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\pard Caf\\\'e9 \\u8364? \\par}' ) ) ).toBe( 'valid' );
	} );

	it( 'accepts a normal hyperlink field', () => {
		expect( inspectRtf( rtf( '{\\rtf1{\\field{\\*\\fldinst HYPERLINK "https://example.com"}{\\fldrslt Example}}}' ) ) ).toBe( 'valid' );
	} );

	it( 'accepts a file that Word opens as RTF without the usual version', () => {
		expect( inspectRtf( rtf( '{\\rt Hello}' ) ) ).toBe( 'valid' );
	} );

	it( 'accepts a real file written by textutil', () => {
		const directory = mkdtempSync( join( tmpdir(), 'rtf-' ) );
		writeFileSync( join( directory, 'a.txt' ), 'Hello, Müller. DDE is only a word here.\n' );
		try {
			execFileSync( 'textutil', [ '-convert', 'rtf', join( directory, 'a.txt' ) ] );
		} catch {
			return;
		}
		expect( inspectRtf( readFileSync( join( directory, 'a.rtf' ) ) ) ).toBe( 'valid' );
	} );

	it.each( [
		'{\\rtf1{\\object\\objemb{\\*\\objdata 01050000020000000b0000004571756174696f6e2e33}}}',
		'{\\rtf1{\\object\\objupdate}}',
		'{\\rtf1{\\object\\objautlink{\\*\\objclass Word.Document.8}}}',
		'{\\rtf1{\\object\\objhtml}}',
		'{\\rtf1{\\object{\\*\\OBJDATA 0105}}}',
		'{\\rtf1{\\*\\objdata0105000002}}',
		'{\\rtf1{\\*\\objdataabcdef}}',
		'{\\rt{\\object\\objemb}}',
		'{\\rtf1{\\*\\template http://evil.example/x.dot}}',
		'{\\rtf1{\\*\\datastore 0100}}',
	] )( 'refuses embedded objects, templates and data stores: %s', ( value ) => {
		expect( inspectRtf( rtf( value ) ) ).toBe( 'macros' );
	} );

	it.each( [
		'{\\rtf1{\\field{\\*\\fldinst DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/c calc"}}}',
		'{\\rtf1{\\field{\\*\\fldinst {D}{DE}AUTO c:\\\\windows\\\\system32\\\\cmd.exe "/c calc"}}}',
		'{\\rtf1{\\field{\\*\\fldinst \\\'44\\\'44\\\'45 "cmd" "/c calc"}}}',
		'{\\rtf1{\\field{\\*\\fldinst \\u68?\\u68?\\u69?AUTO "cmd"}}}',
		'{\\rtf1{\\field{\\*\\fldinst DD\r\nE "cmd" "/c calc"}}}',
		'{\\rtf1{\\field{\\*\\fldinst \\uc0\\u68\\u68\\u69AUTO}}}',
		'{\\rtf1{\\field{\\*\\fldinst {\\v QUOTE} 68 68 69}}}',
		'{\\rtf1{\\field{\\*\\fldinst dde}}}',
	] )( 'refuses a DDE field however it is spelled: %s', ( value ) => {
		expect( inspectRtf( rtf( value ) ) ).toBe( 'macros' );
	} );

	it( 'reads \\bin data as data, not as markup', () => {
		expect( inspectRtf( rtf( '{\\rtf1\\bin14 {\\object\\objemb}x}' ) ) ).toBe( 'valid' );
		expect( inspectRtf( rtf( '{\\rtf1\\bin14 {\\object\\objemb}x{\\object}}' ) ) ).toBe( 'macros' );
	} );

	it( 'refuses what it cannot read to the end', () => {
		expect( inspectRtf( rtf( '{\\rtf1\\bin500 abc}' ) ) ).toBe( 'mismatch' );
		expect( inspectRtf( rtf( '{\\rtf1\\bin-1 abc}' ) ) ).toBe( 'mismatch' );
		expect( inspectRtf( rtf( `{\\rtf1${ '{'.repeat( 1001 ) }` ) ) ).toBe( 'mismatch' );
	} );

	it( 'accepts nesting up to the cap and unbalanced braces', () => {
		expect( inspectRtf( rtf( `{\\rtf1${ '{'.repeat( 990 ) }x` ) ) ).toBe( 'valid' );
		expect( inspectRtf( rtf( '{\\rtf1 Hello}}}' ) ) ).toBe( 'valid' );
	} );

	it( 'ignores NUL bytes and binary text', () => {
		expect( inspectRtf( Buffer.concat( [ rtf( '{\\rtf1 ' ), Buffer.from( [ 0, 1, 0xff, 0x80 ] ), rtf( '}' ) ] ) ) ).toBe( 'valid' );
	} );

	it( 'refuses files that do not start with {\\rt', () => {
		expect( inspectRtf( rtf( ' {\\rtf1 Hello}' ) ) ).toBe( 'mismatch' );
		expect( inspectRtf( Buffer.concat( [ Buffer.from( [ 0xef, 0xbb, 0xbf ] ), rtf( '{\\rtf1 Hello}' ) ] ) ) ).toBe( 'mismatch' );
		expect( inspectRtf( rtf( 'Hello' ) ) ).toBe( 'mismatch' );
		expect( inspectRtf( Buffer.alloc( 0 ) ) ).toBe( 'mismatch' );
	} );
} );
