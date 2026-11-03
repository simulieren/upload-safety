/**
 * Checks that an RTF upload holds no active content. Word's RTF reader is lenient and attackers
 * obfuscate heavily, so this refuses on the presence of dangerous control words and DDE fields
 * instead of trying to understand the document.
 */

// Word opens a file as RTF when it starts with `{\rt`, whatever follows (`{\rtf1` is only the usual form).
const RTF_SIGNATURE = '{\\rt';
const MAX_GROUP_DEPTH = 1000;
const DEFAULT_UNICODE_SKIP = 1;
// Word runs the command of a DDE field (with a prompt); QUOTE with character codes can spell one out.
const DDE_FIELD = /\bDDE(?:AUTO)?\b|\bQUOTE\s+\d/i;
/**
 * Control words that carry or load active content:
 * - `obj*` starts an embedded or linked OLE object (`\object`, `\objdata`, `\objemb`, `\objautlink`, `\objupdate`, ...),
 *   the carrier of Equation Editor exploits (CVE-2017-11882) and auto-loading links (CVE-2017-0199).
 * - `template` attaches a template, which can be a remote one that Word loads and runs macros from.
 * - `datastore` holds a custom XML data store, a way to smuggle an object past a reader that only looks for `obj*`.
 */
const ACTIVE_CONTROL_WORD_PREFIXES = [ 'obj', 'template', 'datastore' ];
const FIELD_INSTRUCTION_WORD = 'fldinst';
const BIN_WORD = 'bin';
const UNICODE_WORD = 'u';
const UNICODE_SKIP_WORD = 'uc';

const CHAR_OPEN_GROUP = 0x7b;
const CHAR_CLOSE_GROUP = 0x7d;
const CHAR_BACKSLASH = 0x5c;
const CHAR_QUOTE = 0x27;
const CHAR_TILDE = 0x7e;
const CHAR_SPACE = 0x20;
const CHAR_CR = 0x0d;
const CHAR_LF = 0x0a;
const CHAR_MINUS = 0x2d;
const CHAR_ZERO = 0x30;
const CHAR_NINE = 0x39;
const MAX_UNICODE_PARAMETER = 0xffff;
const UNICODE_RANGE = 0x10000;

const isLetter = ( byte: number ) => ( byte >= 0x41 && byte <= 0x5a ) || ( byte >= 0x61 && byte <= 0x7a );
const isDigit = ( byte: number ) => byte >= CHAR_ZERO && byte <= CHAR_NINE;

/** The value of a hex digit byte, or -1. */
function hexValue( byte: number | undefined ): number {
	if ( byte === undefined ) {
		return -1;
	}
	if ( isDigit( byte ) ) {
		return byte - CHAR_ZERO;
	}
	const lower = byte | 0x20;
	return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

function isActiveControlWord( word: string ): boolean {
	return ACTIVE_CONTROL_WORD_PREFIXES.some( ( prefix ) => word.startsWith( prefix ) );
}

/**
 * Scans RTF the way a reader tokenizes it: groups, control words, control symbols, `\bin` data and text.
 * Returns 'macros' for an active control word or a DDE field, 'mismatch' when the file is not RTF
 * or cannot be read to the end, else 'valid'.
 */
export function inspectRtf( content: Buffer ): 'valid' | 'macros' | 'mismatch' {
	if ( content.toString( 'latin1', 0, RTF_SIGNATURE.length ).toLowerCase() !== RTF_SIGNATURE ) {
		return 'mismatch';
	}

	// Word reads the instruction of a field from its `\fldinst` group, nested groups included.
	let instructions = '';
	let fieldDepth = -1;
	// `\uc` is scoped to its group.
	const unicodeSkips = [ DEFAULT_UNICODE_SKIP ];
	let depth = 0;
	let skipCount = 0;
	let position = 0;

	const addText = ( text: string ) => {
		if ( skipCount > 0 ) {
			skipCount--;
			return;
		}
		if ( fieldDepth >= 0 ) {
			instructions += text;
		}
	};

	while ( position < content.length ) {
		const byte = content[ position++ ]!;

		if ( byte === CHAR_OPEN_GROUP ) {
			depth++;
			if ( depth > MAX_GROUP_DEPTH ) {
				return 'mismatch';
			}
			unicodeSkips.push( unicodeSkips[ unicodeSkips.length - 1 ]! );
			skipCount = 0;
		} else if ( byte === CHAR_CLOSE_GROUP ) {
			if ( depth > 0 ) {
				if ( depth === fieldDepth ) {
					fieldDepth = -1;
				}
				depth--;
				unicodeSkips.pop();
			}
			skipCount = 0;
		} else if ( byte === CHAR_CR || byte === CHAR_LF ) {
			// Readers ignore raw line breaks, so `DD` and `E` on two lines still spell DDE.
			continue;
		} else if ( byte !== CHAR_BACKSLASH ) {
			addText( String.fromCharCode( byte ) );
		} else if ( position < content.length ) {
			const next = content[ position ]!;
			if ( !isLetter( next ) ) {
				position++;
				if ( next === CHAR_QUOTE ) {
					const high = hexValue( content[ position ] );
					const low = hexValue( content[ position + 1 ] );
					if ( high >= 0 && low >= 0 ) {
						position += 2;
						addText( String.fromCharCode( high * 16 + low ) );
					}
				} else if ( next === CHAR_TILDE ) {
					addText( String.fromCharCode( CHAR_SPACE ) );
				} else if ( next === CHAR_BACKSLASH || next === CHAR_OPEN_GROUP || next === CHAR_CLOSE_GROUP ) {
					addText( String.fromCharCode( next ) );
				}
				continue;
			}

			const wordStart = position;
			while ( position < content.length && isLetter( content[ position ]! ) ) {
				position++;
			}
			const word = content.toString( 'latin1', wordStart, position ).toLowerCase();

			let parameter: number | undefined;
			const parameterStart = position;
			if ( content[ position ] === CHAR_MINUS ) {
				position++;
			}
			const digitsStart = position;
			while ( position < content.length && isDigit( content[ position ]! ) ) {
				position++;
			}
			if ( position > digitsStart ) {
				parameter = Number( content.toString( 'latin1', parameterStart, position ) );
			} else {
				position = parameterStart;
			}
			if ( content[ position ] === CHAR_SPACE ) {
				position++;
			}

			if ( isActiveControlWord( word ) ) {
				return 'macros';
			}
			if ( word === FIELD_INSTRUCTION_WORD && fieldDepth < 0 ) {
				fieldDepth = depth;
			} else if ( word === BIN_WORD ) {
				const length = parameter ?? 0;
				if ( length < 0 || position + length > content.length ) {
					return 'mismatch';
				}
				position += length;
			} else if ( word === UNICODE_SKIP_WORD && parameter !== undefined && parameter >= 0 ) {
				unicodeSkips[ unicodeSkips.length - 1 ] = parameter;
			} else if ( word === UNICODE_WORD && parameter !== undefined ) {
				const codePoint = parameter < 0 ? parameter + UNICODE_RANGE : Math.min( parameter, MAX_UNICODE_PARAMETER );
				skipCount = 0;
				addText( String.fromCharCode( codePoint ) );
				skipCount = unicodeSkips[ unicodeSkips.length - 1 ]!;
			}
		}
	}

	return DDE_FIELD.test( instructions ) ? 'macros' : 'valid';
}
