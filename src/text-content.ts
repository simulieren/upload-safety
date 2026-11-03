/**
 * Checks that a text upload is text, and that a CSV file holds no formula that runs something
 * when Excel or another spreadsheet opens it (CSV injection).
 */

const UTF16LE_BOM = [ 0xff, 0xfe ];
const UTF16BE_BOM = [ 0xfe, 0xff ];
const UTF8_BOM = '﻿';
// Text has tabs, line breaks and form feeds, but no other control characters; NUL marks UTF-16 without a byte order mark or binary data.
const CONTROL_CHARACTER = /[\0-\x08\x0b\x0e-\x1f\x7f]/;
// Excel and others evaluate a cell that starts with one of these (after spaces, tabs or quotes).
const FORMULA_START = /^[\s"]*[=+\-@]/;
// A formula runs something through a function call (HYPERLINK, WEBSERVICE) or a DDE source (`cmd|'/c calc'!A1`).
// Excel allows no space between a function and its parenthesis, so numbers such as `-5`, `+49 (30) 1234` or
// `+66 2 550 6555; Counter (Gate A)` and plain arithmetic stay allowed.
const FUNCTION_CALL_OR_DDE = /[A-Za-z_][\w.]*\(|\|/;
// Splitting on every common delimiter at once only finds more cell starts than a spreadsheet would.
const CELL_DELIMITERS = /[,;\t\r\n]/g;

function startsWith( bytes: Uint8Array, signature: number[] ): boolean {
	return signature.every( ( byte, index ) => bytes[ index ] === byte );
}

/** The text of an upload: UTF-16 by its byte order mark, else UTF-8, else Latin-1 (as Windows code pages read). */
function decodeText( bytes: Uint8Array ): string {
	if ( startsWith( bytes, UTF16LE_BOM ) || startsWith( bytes, UTF16BE_BOM ) ) {
		const encoding = startsWith( bytes, UTF16LE_BOM ) ? 'utf-16le' : 'utf-16be';
		try {
			return new TextDecoder( encoding, { fatal: true } ).decode( bytes );
		} catch {
			return '\0';
		}
	}
	try {
		return new TextDecoder( 'utf-8', { fatal: true, ignoreBOM: true } ).decode( bytes ).replace( UTF8_BOM, '' );
	} catch {
		return Buffer.from( bytes.buffer, bytes.byteOffset, bytes.byteLength ).toString( 'latin1' );
	}
}

/** The cells of a CSV text, unquoted, split on any common delimiter; quoted cells may span lines. */
function* readCells( text: string ): Generator<string> {
	let position = 0;
	while ( position <= text.length ) {
		let cell = '';
		if ( text[ position ] === '"' ) {
			position++;
			for ( ;; ) {
				const close = text.indexOf( '"', position );
				if ( close < 0 ) {
					cell += text.slice( position );
					position = text.length;
					break;
				}
				cell += text.slice( position, close );
				position = close + 1;
				if ( text[ position ] !== '"' ) {
					break;
				}
				cell += '"';
				position++;
			}
		}
		CELL_DELIMITERS.lastIndex = position;
		const end = CELL_DELIMITERS.exec( text )?.index ?? text.length;
		yield cell + text.slice( position, end );
		position = end + 1;
	}
}

/** Whether a text upload is text, and for CSV free of formulas that call a function or DDE. */
export function inspectText( bytes: Uint8Array, csv: boolean ): 'valid' | 'macros' | 'mismatch' {
	const text = decodeText( bytes );
	if ( CONTROL_CHARACTER.test( text ) ) {
		return 'mismatch';
	}
	if ( csv ) {
		for ( const cell of readCells( text ) ) {
			if ( FORMULA_START.test( cell ) && FUNCTION_CALL_OR_DDE.test( cell ) ) {
				return 'macros';
			}
		}
	}
	return 'valid';
}
