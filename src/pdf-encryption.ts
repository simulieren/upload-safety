// A PDF is encrypted when a trailer or xref stream dictionary has `/Encrypt`. Updates can add trailers
// anywhere, so every `/Encrypt` name counts; the PDF is refused unless it opens with an empty password.
import { createCipheriv, createHash } from 'node:crypto';

const SLASH = 0x2f;
const HASH = 0x23;

// Bounds that keep a crafted file from making the check slow; past them it fails closed.
const MAX_ENCRYPT_NAMES = 64;
const MAX_OBJECT_LOOKUPS = 4;
const MAX_OBJECT_HEADERS = 100_000;
const MAX_DICTIONARY_BYTES = 16 * 1024;
const MAX_DICTIONARY_LOOKBACK = 4 * 1024;
const MAX_DICTIONARY_CANDIDATES = 16;
const MAX_PARSED_BYTES = 1024 * 1024;
const MAX_STRING_BYTES = 1024;
const MAX_DEPTH = 8;
// Algorithm 2.B stops once round >= 64 and its last byte (at most 255) is <= round - 32.
export const MAX_R6_ROUNDS = 288;

// PDF whitespace (NUL, TAB, LF, FF, CR, space) and delimiters `()<>[]{}/%` end a name.
const ENDS_NAME = new Uint8Array( 256 );
for ( const byte of Buffer.from( '\0\t\n\f\r ()<>[]{}/%', 'latin1' ) ) {
	ENDS_NAME[ byte ] = 1;
}
const WHITESPACE = new Uint8Array( 256 );
for ( const byte of Buffer.from( '\0\t\n\f\r ', 'latin1' ) ) {
	WHITESPACE[ byte ] = 1;
}
const ESCAPES = new Map( [ [ 0x6e, 0x0a ], [ 0x72, 0x0d ], [ 0x74, 0x09 ], [ 0x62, 0x08 ], [ 0x66, 0x0c ] ] );

// The 32-byte padding of Algorithm 2, which is also the padded empty password.
const PADDING = Buffer.from( '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex' );

function hexValue( byte: number ): number {
	if ( byte >= 0x30 && byte <= 0x39 ) {
		return byte - 0x30;
	}
	const lower = byte | 0x20;
	return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

// `/Encrypt` up to a delimiter, with any byte spelled as a `#xx` escape (so `/Encr#79pt` too). A native
// regex scans 20 MB in about 10 ms, and in under 40 ms when it is packed with near misses.
const ENCRYPT_NAME = /\/(?:E|#45)(?:n|#6[Ee])(?:c|#63)(?:r|#72)(?:y|#79)(?:p|#70)(?:t|#74)(?![^\0\t\n\f\r ()<>[\]{}/%])/g;
// The regex runs on text, which is copied a window at a time: most uploads have no `/Encrypt` at all
// and must not cost a second copy of the whole file.
const SEARCH_WINDOW = 1024 * 1024;
// Longer than the longest name searched for (`/` and fourteen `#xx`) and the byte after it, which ends the name.
const WINDOW_OVERLAP = 64;

/** Where each match of a global `pattern` starts, in file order and up to one past `limit`. */
export function findNames( content: Buffer, pattern: RegExp, limit: number ): number[] {
	const positions: number[] = [];
	for ( let from = 0; from < content.length && positions.length <= limit; from += SEARCH_WINDOW ) {
		const window = content.toString( 'latin1', from, Math.min( content.length, from + SEARCH_WINDOW + WINDOW_OVERLAP ) );
		for ( const match of window.matchAll( pattern ) ) {
			if ( match.index < SEARCH_WINDOW ) {
				positions.push( from + match.index );
			}
		}
	}
	return positions;
}

export function hasEncryptName( content: Buffer ): boolean {
	return findNames( content, ENCRYPT_NAME, 0 ).length > 0;
}

type PdfValue =
	| { kind: 'number'; value: number }
	| { kind: 'boolean'; value: boolean }
	| { kind: 'null' }
	| { kind: 'name'; value: string }
	| { kind: 'string'; value: Buffer }
	| { kind: 'ref'; object: number; generation: number }
	| { kind: 'array'; items: PdfValue[] }
	| PdfDictionary;

export type PdfDictionary = {
	kind: 'dict';
	entries: Map<string, PdfValue>;
	/** Where each key's `/` sits, to tell which dictionary an `/Encrypt` name belongs to. */
	keyOffsets: Map<string, number>;
};

class Unreadable extends Error {}

/** Reads the few PDF objects this check needs within a fixed window; anything odd throws `Unreadable`. */
export class PdfReader {
	position: number;
	private readonly content: Buffer;
	private readonly end: number;

	constructor( content: Buffer, start: number ) {
		this.content = content;
		this.position = start;
		this.end = Math.min( content.length, start + MAX_DICTIONARY_BYTES );
	}

	/** The value at the current position, or `undefined` when it cannot be read. */
	tryRead(): PdfValue | undefined {
		try {
			return this.readValue( 0 );
		} catch ( error ) {
			if ( error instanceof Unreadable ) {
				return undefined;
			}
			throw error;
		}
	}

	private peek( offset = 0 ): number {
		const position = this.position + offset;
		if ( position >= this.end ) {
			throw new Unreadable();
		}
		return this.content[ position ];
	}

	private skipSpace(): void {
		for ( ;; ) {
			const byte = this.peek();
			if ( WHITESPACE[ byte ] ) {
				this.position++;
			} else if ( byte === 0x25 ) {
				while ( this.peek() !== 0x0a && this.peek() !== 0x0d ) {
					this.position++;
				}
			} else {
				return;
			}
		}
	}

	private readRegular(): string {
		const start = this.position;
		while ( ! ENDS_NAME[ this.peek() ] ) {
			this.position++;
		}
		return this.content.toString( 'latin1', start, this.position );
	}

	private readValue( depth: number ): PdfValue {
		if ( depth > MAX_DEPTH ) {
			throw new Unreadable();
		}
		this.skipSpace();
		const byte = this.peek();
		if ( byte === 0x3c ) {
			return this.peek( 1 ) === 0x3c ? this.readDictionary( depth ) : { kind: 'string', value: this.readHexString() };
		}
		if ( byte === 0x28 ) {
			return { kind: 'string', value: this.readLiteralString() };
		}
		if ( byte === 0x5b ) {
			this.position++;
			const items: PdfValue[] = [];
			for ( this.skipSpace(); this.peek() !== 0x5d; this.skipSpace() ) {
				items.push( this.readValue( depth + 1 ) );
			}
			this.position++;
			return { kind: 'array', items };
		}
		if ( byte === SLASH ) {
			return { kind: 'name', value: this.readName() };
		}
		const word = this.readRegular();
		if ( word === 'true' || word === 'false' ) {
			return { kind: 'boolean', value: word === 'true' };
		}
		if ( word === 'null' ) {
			return { kind: 'null' };
		}
		if ( ! /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test( word ) ) {
			throw new Unreadable();
		}
		const value = Number( word );
		return ( /^\d{1,10}$/.test( word ) && this.readReference( value ) ) || { kind: 'number', value };
	}

	/** `N G R` once the object number `N` was read; leaves the position alone otherwise. */
	private readReference( object: number ): PdfValue | undefined {
		const start = this.position;
		try {
			this.skipSpace();
			const generation = this.readRegular();
			this.skipSpace();
			if ( /^\d{1,5}$/.test( generation ) && this.readRegular() === 'R' ) {
				return { kind: 'ref', object, generation: Number( generation ) };
			}
		} catch ( error ) {
			if ( ! ( error instanceof Unreadable ) ) {
				throw error;
			}
		}
		this.position = start;
		return undefined;
	}

	private readName(): string {
		this.position++;
		const bytes: number[] = [];
		for ( let byte = this.peek(); ! ENDS_NAME[ byte ]; byte = this.peek() ) {
			this.position++;
			if ( byte === HASH && hexValue( this.peek() ) >= 0 && hexValue( this.peek( 1 ) ) >= 0 ) {
				byte = hexValue( this.peek() ) * 16 + hexValue( this.peek( 1 ) );
				this.position += 2;
			}
			if ( bytes.push( byte ) > 127 ) {
				throw new Unreadable();
			}
		}
		return Buffer.from( bytes ).toString( 'latin1' );
	}

	private readDictionary( depth: number ): PdfDictionary {
		if ( this.peek() !== 0x3c || this.peek( 1 ) !== 0x3c ) {
			throw new Unreadable();
		}
		this.position += 2;
		const entries = new Map<string, PdfValue>();
		const keyOffsets = new Map<string, number>();
		for ( this.skipSpace(); this.peek() !== 0x3e; this.skipSpace() ) {
			if ( this.peek() !== SLASH ) {
				throw new Unreadable();
			}
			const keyOffset = this.position;
			const key = this.readName();
			entries.set( key, this.readValue( depth + 1 ) );
			keyOffsets.set( key, keyOffset );
		}
		if ( this.peek( 1 ) !== 0x3e ) {
			throw new Unreadable();
		}
		this.position += 2;
		return { kind: 'dict', entries, keyOffsets };
	}

	private readHexString(): Buffer {
		this.position++;
		const nibbles: number[] = [];
		for ( let byte = this.peek(); byte !== 0x3e; byte = this.peek() ) {
			this.position++;
			if ( WHITESPACE[ byte ] ) {
				continue;
			}
			const nibble = hexValue( byte );
			if ( nibble < 0 || nibbles.push( nibble ) > MAX_STRING_BYTES * 2 ) {
				throw new Unreadable();
			}
		}
		this.position++;
		// An odd last digit reads as if followed by 0.
		const bytes = Buffer.alloc( Math.ceil( nibbles.length / 2 ) );
		nibbles.forEach( ( nibble, index ) => {
			bytes[ index >> 1 ] |= index % 2 === 0 ? nibble << 4 : nibble;
		} );
		return bytes;
	}

	private readLiteralString(): Buffer {
		this.position++;
		const bytes: number[] = [];
		for ( let open = 1; bytes.length <= MAX_STRING_BYTES; ) {
			const byte = this.peek();
			this.position++;
			if ( byte === 0x5c ) {
				this.readEscape( bytes );
			} else if ( byte === 0x0d ) {
				// An unescaped CR or CRLF reads as LF.
				this.skipLineFeed();
				bytes.push( 0x0a );
			} else {
				open += byte === 0x28 ? 1 : byte === 0x29 ? -1 : 0;
				if ( open === 0 ) {
					return Buffer.from( bytes );
				}
				bytes.push( byte );
			}
		}
		throw new Unreadable();
	}

	private skipLineFeed(): void {
		if ( this.peek() === 0x0a ) {
			this.position++;
		}
	}

	private readEscape( bytes: number[] ): void {
		const byte = this.peek();
		this.position++;
		const escaped = ESCAPES.get( byte );
		if ( escaped !== undefined ) {
			bytes.push( escaped );
		} else if ( byte >= 0x30 && byte <= 0x37 ) {
			let value = byte - 0x30;
			for ( let digits = 1; digits < 3 && this.peek() >= 0x30 && this.peek() <= 0x37; digits++ ) {
				value = value * 8 + this.peek() - 0x30;
				this.position++;
			}
			bytes.push( value & 0xff );
		} else if ( byte === 0x0d ) {
			// A backslash at the end of a line continues the string on the next one.
			this.skipLineFeed();
		} else if ( byte !== 0x0a ) {
			// `\(`, `\)` and `\\` stand for themselves; other escapes drop the backslash.
			bytes.push( byte );
		}
	}
}

/**
 * The innermost dictionary whose own `key` starts at `keyOffset`, trying each earlier `<<`, and where it ends.
 */
export function findEnclosingDictionary( content: Buffer, key: string, keyOffset: number, budget: { bytes: number } ): { dictionary: PdfDictionary; end: number } | undefined {
	const floor = Math.max( 0, keyOffset - MAX_DICTIONARY_LOOKBACK );
	let candidates = 0;
	for ( let start = keyOffset - 2; start >= floor && candidates < MAX_DICTIONARY_CANDIDATES && budget.bytes > 0; start-- ) {
		if ( content[ start ] !== 0x3c || content[ start + 1 ] !== 0x3c ) {
			continue;
		}
		candidates++;
		const reader = new PdfReader( content, start );
		const value = reader.tryRead();
		budget.bytes -= reader.position - start + 1;
		if ( value?.kind === 'dict' && value.keyOffsets.get( key ) === keyOffset ) {
			return { dictionary: value, end: reader.position };
		}
	}
	return undefined;
}

/** A run of whitespace and comments read, from just after a token up to the next token. */
type SeparatorRun = { start: number; end: number };

/** The tokens of an object header after the object number: its generation number, then `obj`. */
const GENERATION = 0;
const KEYWORD = 1;

type HeaderToken = typeof GENERATION | typeof KEYWORD;

/**
 * Reads the tokens of `N G obj` headers that follow the occurrences of an object number, in linear time overall.
 *
 * Every occurrence starts a read, and occurrences inside comments lead into the same comments and tokens again
 * and again. So reads remember what they found: the separator runs they passed, and the token found at each
 * position. A line break or comment inside a remembered run was passed by that run, so a read reaching one jumps
 * to the run's end. Each token keeps its own furthest-reaching run, because the run after a generation number
 * starts where many runs after object numbers end and reaches further: sharing one slot, it would replace the
 * run those reads still jump through.
 */
class HeaderTokens {
	private readonly runs: [ SeparatorRun, SeparatorRun ] = [ { start: 0, end: 0 }, { start: 0, end: 0 } ];
	private readonly found: [ Map<number, number>, Map<number, number> ] = [ new Map(), new Map() ];
	private readonly lineBreak = /[\r\n]/g;
	private readonly text: string;
	private readonly patterns: [ RegExp, RegExp ];

	constructor( text: string, patterns: [ RegExp, RegExp ] ) {
		this.text = text;
		this.patterns = patterns;
	}

	/** Where `token` ends when it follows whitespace or comments at `from`, -1 when it doesn't. */
	read( from: number, token: HeaderToken ): number {
		const [ start, jumped ] = this.skipSeparator( from, token );
		if ( start === from ) {
			return -1;
		}
		// Only a jump leads several reads to the same token; remembering every token would cost more than it saves.
		const known = jumped ? this.found[ token ].get( start ) : undefined;
		if ( undefined !== known ) {
			return known;
		}
		const pattern = this.patterns[ token ];
		pattern.lastIndex = start;
		const end = pattern.test( this.text ) ? pattern.lastIndex : -1;
		if ( jumped ) {
			this.found[ token ].set( start, end );
		}
		return end;
	}

	/** Where the whitespace and comments at `from` end, and whether that came from a remembered run. */
	private skipSeparator( from: number, token: HeaderToken ): [ number, boolean ] {
		const { text, runs } = this;
		let position = from;
		let jumped = false;
		while ( position < text.length ) {
			const code = text.charCodeAt( position );
			// A run read from the same start, or a line break or comment a run passed, ends where that run ended.
			// Any other point inside a run may lie within one of its comments, where a read can stop earlier.
			const passed = code === 0x0a || code === 0x0d || code === 0x25;
			if ( passed || position === from ) {
				const known = this.runThrough( position, passed );
				if ( known ) {
					position = known.end;
					jumped = true;
					break;
				}
			}
			if ( WHITESPACE[ code ] ) {
				position++;
			} else if ( code === 0x25 ) {
				this.lineBreak.lastIndex = position;
				position = this.lineBreak.exec( text )?.index ?? text.length;
			} else {
				break;
			}
		}
		if ( position > runs[ token ].end ) {
			runs[ token ] = { start: from, end: position };
		}
		return [ position, jumped ];
	}

	private runThrough( position: number, passed: boolean ): SeparatorRun | undefined {
		for ( const run of this.runs ) {
			if ( ( passed ? run.start <= position : run.start === position ) && position < run.end ) {
				return run;
			}
		}
		return undefined;
	}
}

/**
 * Every `N G obj` dictionary in the file, or `undefined` when there is none or one does not read. Readers
 * take the one the xref table points at, which this check does not parse, so each copy has to pass.
 * The encryption dictionary may not sit in an object stream.
 */
function findObjectDictionaries( content: Buffer, text: string, object: number, generation: number, budget: { bytes: number } ): PdfDictionary[] | undefined {
	// `15 0 obj` also holds `5 0 obj`, so whitespace or the start has to come first. Readers allow leading zeros.
	const objectNumber = new RegExp( `(?<![^\\0\\t\\n\\f\\r ])0*${ object }(?![0-9])`, 'g' );
	const generationNumber = new RegExp( `0*${ generation }(?![0-9])`, 'y' );
	const keyword = /obj(?![^\0\t\n\f\r ()<>[\]{}/%])/y;
	const headerTokens = new HeaderTokens( text, [ generationNumber, keyword ] );
	const read = new Set<number>();
	const dictionaries: PdfDictionary[] = [];
	for ( const match of text.matchAll( objectNumber ) ) {
		const afterGeneration = headerTokens.read( match.index + match[ 0 ].length, GENERATION );
		const afterKeyword = afterGeneration < 0 ? -1 : headerTokens.read( afterGeneration, KEYWORD );
		// Object numbers in a header's comments lead to the same header again.
		if ( afterKeyword < 0 || read.has( afterKeyword ) ) {
			continue;
		}
		read.add( afterKeyword );
		// Headers in comments overlap, so their dictionaries are read again and again; the shared budget caps that.
		if ( budget.bytes <= 0 || dictionaries.length >= MAX_OBJECT_HEADERS ) {
			return undefined;
		}
		const reader = new PdfReader( content, afterKeyword );
		const value = reader.tryRead();
		budget.bytes -= reader.position - afterKeyword + 1;
		if ( value?.kind !== 'dict' ) {
			return undefined;
		}
		dictionaries.push( value );
	}
	return dictionaries.length ? dictionaries : undefined;
}

type EncryptionEntry = { dictionary: PdfDictionary; id: Buffer | undefined };

function numberEntry( dictionary: PdfDictionary, key: string ): number | undefined {
	const value = dictionary.entries.get( key );
	return value?.kind === 'number' && Number.isInteger( value.value ) ? value.value : undefined;
}

function stringEntry( dictionary: PdfDictionary, key: string ): Buffer | undefined {
	const value = dictionary.entries.get( key );
	return value?.kind === 'string' ? value.value : undefined;
}

function firstId( trailer: PdfDictionary ): Buffer | undefined {
	const id = trailer.entries.get( 'ID' );
	const first = id?.kind === 'array' ? id.items[ 0 ] : undefined;
	return first?.kind === 'string' ? first.value : undefined;
}

// Plain RC4, since OpenSSL 3 often ships without it.
function rc4( key: Uint8Array, data: Uint8Array ): Buffer {
	const state = new Uint8Array( 256 );
	for ( let index = 0; index < 256; index++ ) {
		state[ index ] = index;
	}
	for ( let index = 0, swap = 0; index < 256; index++ ) {
		swap = ( swap + state[ index ] + key[ index % key.length ] ) & 0xff;
		[ state[ index ], state[ swap ] ] = [ state[ swap ], state[ index ] ];
	}
	const output = Buffer.alloc( data.length );
	for ( let index = 0, i = 0, j = 0; index < data.length; index++ ) {
		i = ( i + 1 ) & 0xff;
		j = ( j + state[ i ] ) & 0xff;
		[ state[ i ], state[ j ] ] = [ state[ j ], state[ i ] ];
		output[ index ] = data[ index ] ^ state[ ( state[ i ] + state[ j ] ) & 0xff ];
	}
	return output;
}

const md5 = ( ...parts: Uint8Array[] ): Buffer => createHash( 'md5' ).update( Buffer.concat( parts ) ).digest();

/** Key length in bytes for revisions 3 and 4: `/Length`, or the stream crypt filter's for V4. */
function keyLength( dictionary: PdfDictionary, version: number ): number | undefined {
	let bits = numberEntry( dictionary, 'Length' );
	if ( bits === undefined && version === 4 ) {
		const filters = dictionary.entries.get( 'CF' );
		const streamFilter = dictionary.entries.get( 'StmF' );
		const filter = filters?.kind === 'dict' && streamFilter?.kind === 'name' ? filters.entries.get( streamFilter.value ) : undefined;
		bits = ( filter?.kind === 'dict' ? numberEntry( filter, 'Length' ) : undefined ) ?? 128;
		bits = bits < 40 ? bits * 8 : bits;
	}
	bits ??= 40;
	return bits >= 40 && bits <= 128 && bits % 8 === 0 ? bits / 8 : undefined;
}

/** Algorithm 2, then 4 (revision 2) or 5 (revisions 3 and 4) of ISO 32000-2, with the empty password. */
function emptyPasswordMatchesRc4( dictionary: PdfDictionary, revision: number, version: number, id: Buffer | undefined ): boolean {
	const owner = stringEntry( dictionary, 'O' );
	const user = stringEntry( dictionary, 'U' );
	const permissions = numberEntry( dictionary, 'P' );
	const length = revision === 2 ? 5 : keyLength( dictionary, version );
	if ( ! owner || owner.length < 32 || ! user || user.length < ( revision === 2 ? 32 : 16 ) || permissions === undefined || ! id || ! length ) {
		return false;
	}
	const permissionBytes = Buffer.alloc( 4 );
	permissionBytes.writeUInt32LE( permissions >>> 0 );
	const metadata = dictionary.entries.get( 'EncryptMetadata' );
	const skipsMetadata = revision >= 4 && metadata?.kind === 'boolean' && ! metadata.value;
	let hash = md5( PADDING, owner.subarray( 0, 32 ), permissionBytes, id, Buffer.alloc( skipsMetadata ? 4 : 0, 0xff ) );
	if ( revision >= 3 ) {
		for ( let round = 0; round < 50; round++ ) {
			hash = md5( hash.subarray( 0, length ) );
		}
	}
	const key = hash.subarray( 0, length );
	if ( revision === 2 ) {
		return rc4( key, PADDING ).equals( user.subarray( 0, 32 ) );
	}
	let check = rc4( key, md5( PADDING, id ) );
	for ( let round = 1; round <= 19; round++ ) {
		check = rc4( key.map( ( byte ) => byte ^ round ), check );
	}
	return check.equals( user.subarray( 0, 16 ) );
}

/** Algorithm 2.B for a user password (no `U` vector), with the number of rounds it took. */
export function hashR6( password: Buffer, salt: Buffer ): { hash: Buffer; rounds: number } {
	let key = createHash( 'sha256' ).update( Buffer.concat( [ password, salt ] ) ).digest();
	let rounds = 0;
	while ( rounds < MAX_R6_ROUNDS ) {
		const block = Buffer.concat( [ password, key ] );
		const cipher = createCipheriv( 'aes-128-cbc', key.subarray( 0, 16 ), key.subarray( 16, 32 ) ).setAutoPadding( false );
		const encrypted = Buffer.concat( [ cipher.update( Buffer.alloc( block.length * 64, block ) ), cipher.final() ] );
		let sum = 0;
		for ( let index = 0; index < 16; index++ ) {
			sum += encrypted[ index ];
		}
		key = createHash( [ 'sha256', 'sha384', 'sha512' ][ sum % 3 ] ).update( encrypted ).digest();
		rounds++;
		if ( rounds >= 64 && encrypted[ encrypted.length - 1 ] <= rounds - 32 ) {
			break;
		}
	}
	return { hash: key.subarray( 0, 32 ), rounds };
}

/** Whether a reader opens the PDF without asking for a password; only the Standard handler can. */
function opensWithEmptyPassword( { dictionary, id }: EncryptionEntry ): boolean {
	const filter = dictionary.entries.get( 'Filter' );
	const version = numberEntry( dictionary, 'V' );
	const revision = numberEntry( dictionary, 'R' );
	if ( filter?.kind !== 'name' || filter.value !== 'Standard' || version === undefined || revision === undefined ) {
		return false;
	}
	if ( revision >= 2 && revision <= 4 && [ 1, 2, 4 ].includes( version ) ) {
		return emptyPasswordMatchesRc4( dictionary, revision, version, id );
	}
	const user = stringEntry( dictionary, 'U' );
	const owner = stringEntry( dictionary, 'O' );
	if ( version !== 5 || ( revision !== 5 && revision !== 6 ) || ! user || user.length < 48 || ! owner || owner.length < 48 || numberEntry( dictionary, 'P' ) === undefined ) {
		return false;
	}
	const salt = user.subarray( 32, 40 );
	const hash = revision === 5 ? createHash( 'sha256' ).update( salt ).digest() : hashR6( Buffer.alloc( 0 ), salt ).hash;
	return hash.equals( user.subarray( 0, 32 ) );
}

/** The encryption dictionaries in file order, or `undefined` when one is unreadable or there are too many. */
function readEncryptionEntries( content: Buffer ): EncryptionEntry[] | undefined {
	const entries: EncryptionEntry[] = [];
	const objects = new Map<string, PdfDictionary[] | undefined>();
	const budget = { bytes: MAX_PARSED_BYTES };
	const positions = findNames( content, ENCRYPT_NAME, MAX_ENCRYPT_NAMES );
	if ( positions.length > MAX_ENCRYPT_NAMES ) {
		return undefined;
	}
	let text: string | undefined;
	for ( const position of positions ) {
		const trailer = findEnclosingDictionary( content, 'Encrypt', position, budget )?.dictionary;
		const value = trailer?.entries.get( 'Encrypt' );
		let dictionaries = value?.kind === 'dict' ? [ value ] : undefined;
		if ( value?.kind === 'ref' ) {
			const key = `${ value.object } ${ value.generation }`;
			if ( ! objects.has( key ) && objects.size === MAX_OBJECT_LOOKUPS ) {
				return undefined;
			}
			if ( ! objects.has( key ) ) {
				text ??= content.toString( 'latin1' );
				objects.set( key, findObjectDictionaries( content, text, value.object, value.generation, budget ) );
			}
			dictionaries = objects.get( key );
		}
		if ( ! trailer || ! dictionaries ) {
			return undefined;
		}
		entries.push( ...dictionaries.map( ( dictionary ) => ( { dictionary, id: firstId( trailer ) } ) ) );
	}
	return entries;
}

export function isEncryptedPdf( content: Buffer ): boolean {
	const entries = readEncryptionEntries( content );
	// Readers follow `startxref` to the dictionary they use, which this check does not; one appended after
	// `%%EOF` or a second copy of the object must only make it stricter, never stand in for that one.
	return entries === undefined || ! entries.every( opensWithEmptyPassword );
}
