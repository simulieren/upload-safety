/**
 * Finds what a PDF reader runs, submits or opens on its own: JavaScript, launch, form submit and
 * import actions, links to other files, multimedia, XFA forms and embedded files. Their names are
 * searched in the raw file and in every Flate-compressed object stream, where a writer may pack the
 * dictionaries that hold them.
 */
import { inflateSync } from 'node:zlib';

import { findEnclosingDictionary, findNames, hasEncryptName, isEncryptedPdf, type PdfDictionary } from './pdf-encryption.js';

// A name alone also turns up in strings, such as a link to `.../Web/JavaScript/`, so it only counts where
// a reader takes it for one: an action type after `/S`, a subtype or type after its key, or a key before
// its value. Only whitespace and comments may come between. Short keys such as `/JS` or `/EF` would turn
// up by chance in megabytes of compressed data, and need one of these names to do anything.
const SEPARATOR = '(?:[\\0\\t\\n\\f\\r ]|%[^\\r\\n]*[\\r\\n])*';
const ACTIVE_NAME = new RegExp( [
	`${ nameSource( [ 'S' ] ) }${ SEPARATOR }${ nameSource( [ 'JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'Rendition' ] ) }`,
	`${ nameSource( [ 'Subtype', 'Type' ] ) }${ SEPARATOR }${ nameSource( [ 'RichMedia', 'FileAttachment', 'EmbeddedFile' ] ) }`,
	`${ nameSource( [ 'JavaScript', 'XFA', 'EmbeddedFiles' ] ) }${ SEPARATOR }[0-9<[(]`,
].join( '|' ) );
// Readers need `/First` to find the objects in an object stream; outline items have the key too.
const FIRST_NAME = new RegExp( nameSource( [ 'First' ] ), 'g' );

/** Bounds far above real files that keep a crafted one cheap; past them the PDF counts as unreadable. */
const MAX_FIRST_NAMES = 50_000;
const MAX_PARSED_BYTES = 8 * 1024 * 1024;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

const STREAM_KEYWORD = 'stream';
const CR = 0x0d;
const LF = 0x0a;
const PDF_WHITESPACE = new Set( [ 0x00, 0x09, LF, 0x0c, CR, 0x20 ] );

/** One of `names` up to its delimiter, with any byte spelled as a `#xx` escape (`/Java#53cript` too). */
function nameSource( names: string[] ): string {
	const spelled = names.map( ( name ) => Array.from( name, ( character ) => {
		const [ high, low ] = character.charCodeAt( 0 ).toString( 16 );
		return `(?:${ character }|#${ high }[${ low.toLowerCase() }${ low.toUpperCase() }])`;
	} ).join( '' ) );
	return `/(?:${ spelled.join( '|' ) })(?![^\\0\\t\\n\\f\\r ()<>[\\]{}/%])`;
}

// Whole, not in windows as `/Encrypt` is searched: whitespace and comments between the names have no bound.
function hasActiveName( content: Buffer ): boolean {
	return ACTIVE_NAME.test( content.toString( 'latin1' ) );
}

/** Whether a stream's only filter is Flate without a predictor, null when it has none at all. */
function isPlainFlate( dictionary: PdfDictionary ): boolean | null {
	const filter = dictionary.entries.get( 'Filter' );
	if ( ! filter ) {
		return null;
	}
	const names = filter.kind === 'array' ? filter.items : [ filter ];
	if ( names.length !== 1 || names[ 0 ].kind !== 'name' || names[ 0 ].value !== 'FlateDecode' ) {
		return false;
	}
	const parameters = dictionary.entries.get( 'DecodeParms' );
	const single = parameters?.kind === 'array' && parameters.items.length === 1 ? parameters.items[ 0 ] : parameters;
	if ( ! single || single.kind === 'null' ) {
		return true;
	}
	const predictor = single.kind === 'dict' ? single.entries.get( 'Predictor' ) : undefined;
	return single.kind === 'dict' && ( ! predictor || ( predictor.kind === 'number' && predictor.value === 1 ) );
}

/** Where a stream's data starts when `stream` follows the dictionary ending at `end`, -1 otherwise. */
function findStreamData( content: Buffer, end: number ): number {
	let position = end;
	while ( PDF_WHITESPACE.has( content[ position ] ) ) {
		position++;
	}
	if ( content.toString( 'latin1', position, position + STREAM_KEYWORD.length ) !== STREAM_KEYWORD ) {
		return -1;
	}
	position += STREAM_KEYWORD.length;
	if ( content[ position ] === CR ) {
		position++;
	}
	return content[ position ] === LF ? position + 1 : position;
}

/**
 * Whether an object stream holds an active name, or undefined when one does not inflate, uses another
 * filter or there are more than the bounds allow. Readers find object streams through the xref, which
 * this check does not parse, so every dictionary with `/First` that a stream follows counts as one.
 */
function objectStreamsHaveActiveName( content: Buffer ): boolean | undefined {
	const positions = findNames( content, FIRST_NAME, MAX_FIRST_NAMES );
	if ( positions.length > MAX_FIRST_NAMES ) {
		return undefined;
	}
	const budget = { bytes: MAX_PARSED_BYTES };
	let inflated = 0;
	for ( const position of positions ) {
		const found = findEnclosingDictionary( content, 'First', position, budget );
		if ( ! found ) {
			return undefined;
		}
		const dataStart = findStreamData( content, found.end );
		const flate = dataStart < 0 ? null : isPlainFlate( found.dictionary );
		if ( flate === null ) {
			// An outline item, or a stream left uncompressed, which the raw search already covered.
			continue;
		}
		if ( ! flate ) {
			return undefined;
		}
		let data: Buffer;
		try {
			// zlib stops at the end of the compressed data and ignores what follows.
			data = inflateSync( content.subarray( dataStart ), { maxOutputLength: MAX_INFLATED_BYTES - inflated } );
		} catch {
			return undefined;
		}
		inflated += data.length;
		if ( hasActiveName( data ) ) {
			return true;
		}
	}
	return false;
}

/** The verdict on a PDF: encrypted behind a password, holding active content, unreadable or plain. */
export function inspectPdf( content: Buffer ): 'valid' | 'macros' | 'encrypted' | 'mismatch' {
	if ( isEncryptedPdf( content ) ) {
		return 'encrypted';
	}
	if ( hasActiveName( content ) ) {
		return 'macros';
	}
	const active = objectStreamsHaveActiveName( content );
	if ( active === undefined ) {
		// Object streams of a PDF that opens without a password are encrypted all the same.
		return hasEncryptName( content ) ? 'encrypted' : 'mismatch';
	}
	return active ? 'macros' : 'valid';
}
