/**
 * Strict allowlist + validation for document uploads: PDF, MS Office (also the
 * legacy formats), LibreOffice, and JPG/PNG. Validation happens on three axes: file
 * extension, declared MIME type, and the actual content, i.e. the magic-byte
 * signature plus the parts a file of that kind always has. Extension and MIME
 * alone are trivially spoofed.
 */

import { inspectExcelGlobals } from './excel-macro-sheets.js';
import { readOleDirectory, type OleDirectory } from './ole-streams.js';
import { inspectPdf } from './pdf-active-content.js';
import { hasPowerPointCode, isEncryptedPowerPoint } from './powerpoint-vba.js';
import { stripXmlMarkup } from './xml-markup.js';
import { readZipEntries, readZipEntryData, startsWithBytes, type ZipEntry } from './zip-entries.js';

export type AllowedExtension =
	| 'pdf' | 'doc' | 'docx' | 'ppt' | 'pptx' | 'xls' | 'xlsx' | 'odt' | 'ods' | 'odp' | 'jpg' | 'jpeg' | 'png';

/** Magic-byte family an extension's bytes must match. */
type MagicFamily = 'pdf' | 'zip' | 'ole' | 'jpeg' | 'png';

interface AllowedType {
	extension: AllowedExtension;
	/** Accepted declared MIME types for this extension. */
	mimeTypes: string[];
	/** Byte-signature family the actual content must match. */
	magic: MagicFamily;
	/**
	 * Entry names (lowercase) a ZIP package must list in its central directory.
	 * The signature alone lets any ZIP archive pass as a Word document.
	 */
	zipEntries?: string[];
	/** The MIME type an OpenDocument package holds in its `mimetype` entry. */
	openDocumentType?: string;
	/** Stream names of a legacy compound file, any one of which must be right below its root. */
	oleStreams?: string[];
}

const ooxml = ( mainPart: string ) => [ '[content_types].xml', mainPart ];
// VBA lives in e.g. `word/vbaProject.bin`; ActiveX controls carry code as well.
const OOXML_MACRO_ENTRY = /(?:^|\/)vbaproject\.bin$|(?:^|\/)activex\//;
// A renamed VBA part still needs its content type or a relationship to load.
// Quoted values may hold `>`, so they are skipped whole rather than ending the element.
const CONTENT_TYPE_ELEMENT = /<(?:[\w.-]+:)?(default|override)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const RELATIONSHIP_ELEMENT = /<(?:[\w.-]+:)?relationship\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const XML_ATTRIBUTE = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
// Excel 4.0 macro sheets run formulas such as EXEC without VBA.
// Embedded OLE objects run their server on a double click: a Package runs any file, Equation Editor
// has had exploits (CVE-2017-11882). Linked ones fetch and run their target on opening (CVE-2017-0199).
// An altChunk imports an HTML, MHT or RTF part, which may carry such objects in turn.
const OOXML_MACRO_CONTENT_TYPE = /application\/vnd\.ms-office\.vbaproject|macroenabled|application\/vnd\.ms-office\.activex|application\/vnd\.ms-excel\.(?:intl)?macrosheet|application\/vnd\.openxmlformats-officedocument\.oleobject/i;
const OOXML_MACRO_RELATIONSHIP_TYPE = /\/vbaproject$|\/activexcontrol|\/control|\/xl(?:intl)?macrosheet$|\/oleobject$|\/afchunk$/i;
// Subdocuments and frames fetch and run their external target.
const OOXML_REMOTE_CODE_RELATIONSHIP_TYPE = /\/(?:subdocument|frame)$/i;
const OOXML_TEMPLATE_RELATIONSHIP_TYPE = /\/attachedtemplate$/i;
const LOCAL_DRIVE_PATH = /^(?:file:\/\/\/)?[a-z]:[\\/]/i;
const XML_REFERENCE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const XML_NAMED_ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};
const CONTENT_TYPES_ENTRY = '[content_types].xml';
/** Caps on what is inflated to look for macro parts; real files need a few dozen KB. */
const MAX_INSPECTED_RELATIONSHIPS = 200;
const MAX_INSPECTED_PART_BYTES = 256 * 1024;
const MAX_INSPECTED_TOTAL_BYTES = 2 * 1024 * 1024;
/** Cap on the document text inflated to look for fields and event listeners; real files need a few MB. */
const MAX_INSPECTED_CONTENT_BYTES = 64 * 1024 * 1024;
// Word runs the command of a DDE field (with a prompt); QUOTE with character codes can spell one out.
const WORD_STORY_PART = /^word\/[^/]*\.xml$|^word\/glossary\/[^/]*\.xml$/;
const WORD_FIELD_INSTRUCTION = /<(?:[\w.-]+:)?instrText\b[^>]*>([^<]*)<|<(?:[\w.-]+:)?fldSimple\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const DDE_FIELD = /\bDDE(?:AUTO)?\b|\bQUOTE\s+\d/i;
// Excel keeps the server and topic of a DDE formula such as `=cmd|'/c calc'!A1` in an external link part.
const EXCEL_EXTERNAL_LINK_PART = /^xl\/externallinks\/[^/]*\.xml$/;
const EXCEL_DDE_LINK = /<(?:[\w.-]+:)?ddeLink[\s/>]/i;
// The manifest is read on its own, as it may name OpenOffice.org's DTD.
const OPEN_DOCUMENT_XML_PART = /^(?!meta-inf\/).*\.xml$/;
// LibreOffice runs an event listener's macro or program (presentation:action="execute") when the event
// fires, and a link to a macro URL when it is clicked.
const OPEN_DOCUMENT_EVENT_LISTENER = /<(?:[\w.-]+:)?event-listener[\s/>]/i;
const QUOTED_VALUE = /=\s*(?:"([^"]*)"|'([^']*)')/g;
const OPEN_DOCUMENT_MACRO_URL = /^\s*(?:vnd\.sun\.star\.script|macro):/i;
// LibreOffice keeps Basic modules under `Basic/`, other script languages under `Scripts/`.
const OPEN_DOCUMENT_MACRO_ENTRY = /^(?:basic|scripts)\/./;
// Word keeps macros in a `Macros` storage, Excel in `_VBA_PROJECT_CUR`; both hold `VBA`.
const OLE_MACRO_ENTRIES = [ 'vba', '_vba_project', '_vba_project_cur', 'macros' ];
// Word keeps embedded objects in `ObjectPool/_<number>`, Excel in `MBD<hex>` storages; a Package holds `\x01Ole10Native`.
const OLE_EMBEDDED_OBJECT_ENTRY = /^_\d+$|^mbd[0-9a-f]{8}$|^\x01ole10native$/i;
const OLE_SIGNATURE = [ 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1 ];
/** Cap on what is inflated to read the start of every entry; real files need well under 1 MB. */
const MAX_INSPECTED_PREFIX_BYTES = 32 * 1024 * 1024;
// Office saves a password-protected docx, xlsx or pptx as a compound file of these streams.
const ENCRYPTED_PACKAGE_STREAMS = [ 'EncryptionInfo', 'EncryptedPackage' ];
/** FibBase `wIdent` of a Word 97 or later document and its `fEncrypted` flag [MS-DOC 2.5.2]. */
const WORD_IDENT = 0xa5ec;
const FIB_FLAGS_OFFSET = 0x0a;
const FIB_ENCRYPTED_FLAG = 0x0100;
const OPEN_DOCUMENT_MANIFEST_ENTRY = 'meta-inf/manifest.xml';
const OPEN_DOCUMENT_MANIFEST_DOCTYPE = /<!DOCTYPE[^>[]*>/i;
const OPEN_DOCUMENT_ENCRYPTION_ELEMENT = /<(?:[\w.-]+:)?encryption-data[\s/>]/i;
const MIMETYPE_ENTRY = 'mimetype';
const OPEN_DOCUMENT_ENTRIES = [ MIMETYPE_ENTRY, 'content.xml' ];
/** Size of a ZIP local file header before the entry name. */
const ZIP_HEADER_SIZE = 30;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;

/**
 * The text of an OOXML package's content types and relationship parts without comments
 * and the like, or null when one of them does not inflate, decode or strip, or there are
 * more than could be inspected.
 */
function readOoxmlParts( content: Buffer, entries: ZipEntry[] ): string[] | null {
	const relationships = entries.filter( ( entry ) => entry.name.toLowerCase().endsWith( '.rels' ) );
	if ( relationships.length > MAX_INSPECTED_RELATIONSHIPS ) {
		return null;
	}
	const parts = [ ...entries.filter( ( entry ) => entry.name.toLowerCase() === CONTENT_TYPES_ENTRY ), ...relationships ];
	return readXmlParts( content, parts, MAX_INSPECTED_PART_BYTES, MAX_INSPECTED_TOTAL_BYTES );
}

/**
 * The text of XML parts without comments and the like, or null when one of them does not inflate,
 * decode or strip, or one or all together exceed their limit.
 */
function readXmlParts( content: Buffer, parts: ZipEntry[], partLimit: number, totalLimit: number ): string[] | null {
	const texts: string[] = [];
	let budget = totalLimit;
	for ( const part of parts ) {
		const data = readZipEntryData( content, part, Math.min( partLimit, budget ) );
		const decoded = data ? decodeXmlPart( data ) : null;
		const text = decoded === null ? null : stripXmlMarkup( decoded );
		if ( ! data || text === null ) {
			return null;
		}
		budget -= data.length;
		texts.push( text );
	}
	return texts;
}

/** The text parts of a ZIP package whose lower-case names match, or null when one does not read. */
function readMatchingParts( content: Buffer, entries: ZipEntry[], name: RegExp ): string[] | null {
	const parts = entries.filter( ( entry ) => name.test( entry.name.toLowerCase() ) );
	return readXmlParts( content, parts, MAX_INSPECTED_CONTENT_BYTES, MAX_INSPECTED_CONTENT_BYTES );
}

/** Whether a Word part's field instructions, read together as Word does, name DDE. */
function hasDdeField( part: string ): boolean {
	const instructions = Array.from( part.matchAll( WORD_FIELD_INSTRUCTION ), ( [ , text, attributes ] ) => {
		if ( text !== undefined ) {
			return decodeXmlReferences( text );
		}
		// An element whose attributes do not parse counts as a field: Word may read it differently.
		const values = readAttributes( attributes );
		return values ? ( values.get( 'instr' ) ?? [] ).join( ' ' ) : 'DDE';
	} );
	return DDE_FIELD.test( instructions.join( '' ) );
}

function hasOpenDocumentEvent( part: string ): boolean {
	return OPEN_DOCUMENT_EVENT_LISTENER.test( part ) || Array.from( part.matchAll( QUOTED_VALUE ) ).some(
		( [ , doubleQuoted, singleQuoted ] ) => OPEN_DOCUMENT_MACRO_URL.test( decodeXmlReferences( doubleQuoted ?? singleQuoted ) )
	);
}

/**
 * Whether a package holds an entry that is an OLE compound file: an embedded object, or a VBA
 * project under any name. Null when an entry does not inflate.
 */
function holdsOleEntry( content: Buffer, entries: ZipEntry[] ): boolean | null {
	const budget = { bytes: MAX_INSPECTED_PREFIX_BYTES };
	const verdicts = entries.map( ( entry ) => startsWithBytes( content, entry, OLE_SIGNATURE, budget ) );
	return verdicts.includes( null ) ? null : verdicts.includes( true );
}

// Office decodes character references, so `vba&#80;roject` must not slip past the checks.
function decodeXmlReferences( value: string ): string {
	return value.replace( XML_REFERENCE, ( reference, decimal?: string, hex?: string, name?: string ) => {
		if ( name ) {
			return XML_NAMED_ENTITIES[ name ];
		}
		const codePoint = decimal ? Number( decimal ) : parseInt( hex ?? '', 16 );
		return codePoint <= 0x10ffff ? String.fromCodePoint( codePoint ) : reference;
	} );
}

// OPC allows UTF-8 and UTF-16 XML parts; any other encoding could hide a macro from the checks.
const XML_ENCODING_DECLARATION = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i;
const SUPPORTED_XML_ENCODINGS = [ 'utf-8', 'utf8', 'utf-16', 'utf-16le', 'utf-16be' ];

/** The text of an XML part, decoded by its byte order mark or first bytes, or null for another encoding. */
function decodeXmlPart( data: Buffer ): string | null {
	let encoding = 'utf-8';
	if ( ( data[ 0 ] === 0xff && data[ 1 ] === 0xfe ) || ( data[ 0 ] === 0x3c && data[ 1 ] === 0x00 ) ) {
		encoding = 'utf-16le';
	} else if ( ( data[ 0 ] === 0xfe && data[ 1 ] === 0xff ) || ( data[ 0 ] === 0x00 && data[ 1 ] === 0x3c ) ) {
		encoding = 'utf-16be';
	}
	let text: string;
	try {
		text = new TextDecoder( encoding, { fatal: true } ).decode( data );
	} catch {
		return null;
	}
	const declared = XML_ENCODING_DECLARATION.exec( text )?.[ 1 ].toLowerCase();
	return declared === undefined || SUPPORTED_XML_ENCODINGS.includes( declared ) ? text : null;
}

/**
 * An element's decoded, trimmed attribute values by lower-case local name, read one attribute
 * after the other so a value cannot pose as another attribute; null when they do not parse.
 */
function readAttributes( attributes: string ): Map<string, string[]> | null {
	const pattern = new RegExp( XML_ATTRIBUTE );
	const values = new Map<string, string[]>();
	let position = 0;
	let match: RegExpExecArray | null;
	while ( ( match = pattern.exec( attributes ) ) ) {
		const [ , name, doubleQuoted, singleQuoted ] = match;
		const key = name.replace( /^.*:/, '' ).toLowerCase();
		// Values are trimmed, as .NET's `Uri` does with a relationship type.
		values.set( key, [ ...( values.get( key ) ?? [] ), decodeXmlReferences( doubleQuoted ?? singleQuoted ).trim() ] );
		position = pattern.lastIndex;
	}
	return /^\s*\/?$/.test( attributes.slice( position ) ) ? values : null;
}

function decodePartName( partName: string ): string {
	try {
		return decodeURIComponent( partName );
	} catch {
		return partName;
	}
}

/** Whether a relationship loads its target from outside the package, where Office would run its code. */
function loadsRemoteCode( values: Map<string, string[]> ): boolean {
	const types = values.get( 'type' ) ?? [];
	const targets = values.get( 'target' ) ?? [];
	if ( ! ( values.get( 'targetmode' ) ?? [] ).some( ( mode ) => mode.toLowerCase() === 'external' ) ) {
		return false;
	}
	if ( types.some( ( type ) => OOXML_REMOTE_CODE_RELATIONSHIP_TYPE.test( type ) ) ) {
		return true;
	}
	// Word records the local template a document was made from, such as Normal.dotm.
	return types.some( ( type ) => OOXML_TEMPLATE_RELATIONSHIP_TYPE.test( type ) ) &&
		! targets.every( ( target ) => LOCAL_DRIVE_PATH.test( target ) );
}

// An element whose attributes do not parse counts as a macro: Office may read it differently.
function declaresMacroRelationship( relationships: string ): boolean {
	return Array.from( relationships.matchAll( RELATIONSHIP_ELEMENT ) ).some( ( [ , attributes ] ) => {
		const values = readAttributes( attributes );
		return ! values || ( values.get( 'type' ) ?? [] ).some( ( type ) => OOXML_MACRO_RELATIONSHIP_TYPE.test( type ) ) ||
			loadsRemoteCode( values );
	} );
}

/**
 * Whether a macro content type applies to a part the package has. Generators
 * such as SheetJS declare a macro type for `.bin` in every file, unused.
 */
function declaresMacroPart( contentTypes: string, names: string[] ): boolean {
	return Array.from( contentTypes.matchAll( CONTENT_TYPE_ELEMENT ) ).some( ( [ , kind, attributes ] ) => {
		const values = readAttributes( attributes );
		if ( ! values ) {
			return true;
		}
		if ( ! ( values.get( 'contenttype' ) ?? [] ).some( ( type ) => OOXML_MACRO_CONTENT_TYPE.test( type ) ) ) {
			return false;
		}
		if ( kind.toLowerCase() === 'default' ) {
			return ( values.get( 'extension' ) ?? [] ).some( ( extension ) => names.some( ( name ) => name.endsWith( `.${ extension.toLowerCase() }` ) ) );
		}
		return ( values.get( 'partname' ) ?? [] ).some( ( partName ) => names.includes( decodePartName( partName ).replace( /^\//, '' ).toLowerCase() ) );
	} );
}

/**
 * An OpenDocument file's first ZIP entry is `mimetype`, stored uncompressed
 * without extra field, and holds exactly the file's MIME type.
 */
function isOpenDocument( mimeType: string, content: Buffer, entries: ZipEntry[] ): boolean {
	const first = entries.find( ( entry ) => entry.name === MIMETYPE_ENTRY );
	return first?.method === 0 && first.localHeaderOffset === 0 && first.uncompressedSize === mimeType.length &&
		content.length >= ZIP_HEADER_SIZE &&
		! ( content.readUInt16LE( 6 ) & ZIP_DATA_DESCRIPTOR_FLAG ) &&
		content.readUInt16LE( 8 ) === 0 &&
		content.readUInt32LE( 22 ) === mimeType.length &&
		content.readUInt16LE( 26 ) === MIMETYPE_ENTRY.length &&
		content.readUInt16LE( 28 ) === 0 &&
		content.toString( 'latin1', ZIP_HEADER_SIZE, ZIP_HEADER_SIZE + MIMETYPE_ENTRY.length + mimeType.length ) === `${ MIMETYPE_ENTRY }${ mimeType }`;
}

function holdsEncryptedPackage( directory: OleDirectory | null ): boolean {
	return ENCRYPTED_PACKAGE_STREAMS.every( ( name ) => directory?.readStream( name ) );
}

// `fObfuscated` only picks XOR over RC4 and is ignored while `fEncrypted` is clear.
function isEncryptedWordDocument( stream: Buffer ): boolean {
	return stream.length >= FIB_FLAGS_OFFSET + 2 && stream.readUInt16LE( 0 ) === WORD_IDENT &&
		( stream.readUInt16LE( FIB_FLAGS_OFFSET ) & FIB_ENCRYPTED_FLAG ) !== 0;
}

/**
 * Checks a legacy Office file by its directory: one of its main streams, no VBA storage
 * or macro sheet, and no encryption, behind which neither these checks nor a scanner see.
 */
function inspectOleFile( content: Buffer, extension: AllowedExtension, oleStreams: string[] ): FileContentVerdict {
	const directory = readOleDirectory( content );
	const stream = oleStreams.map( ( name ) => directory?.readStream( name ) ).find( Boolean );
	if ( ! stream || ! directory ) {
		// Office opens an encrypted package by its content, whatever the extension.
		return holdsEncryptedPackage( directory ) ? 'encrypted' : 'mismatch';
	}
	if ( directory.names.some( ( name ) => OLE_MACRO_ENTRIES.includes( name.toLowerCase() ) || OLE_EMBEDDED_OBJECT_ENTRY.test( name ) ) ) {
		return 'macros';
	}
	if ( extension === 'xls' ) {
		return inspectExcelGlobals( stream );
	}
	if ( extension === 'doc' ) {
		return isEncryptedWordDocument( stream ) ? 'encrypted' : 'valid';
	}
	const currentUser = directory.readStream( 'Current User' ) ?? Buffer.alloc( 0 );
	if ( isEncryptedPowerPoint( currentUser ) ) {
		return 'encrypted';
	}
	const code = hasPowerPointCode( stream, currentUser );
	return code === null ? 'mismatch' : code ? 'macros' : 'valid';
}

/** Whether an OpenDocument manifest lists encrypted entries, or null when it does not read. */
function isEncryptedOpenDocument( content: Buffer, entries: ZipEntry[] ): boolean | null {
	const manifest = entries.find( ( entry ) => entry.name.toLowerCase() === OPEN_DOCUMENT_MANIFEST_ENTRY );
	if ( ! manifest ) {
		return false;
	}
	const data = readZipEntryData( content, manifest, MAX_INSPECTED_PART_BYTES );
	// OpenOffice.org named its DTD; an internal subset, which could declare entities, stays refused.
	const decoded = data ? decodeXmlPart( data ) : null;
	const text = decoded === null ? null : stripXmlMarkup( decoded.replace( OPEN_DOCUMENT_MANIFEST_DOCTYPE, '' ) );
	return text === null ? null : OPEN_DOCUMENT_ENCRYPTION_ELEMENT.test( text );
}

const ODT = 'application/vnd.oasis.opendocument.text';
const ODS = 'application/vnd.oasis.opendocument.spreadsheet';
const ODP = 'application/vnd.oasis.opendocument.presentation';
const JPEG = { magic: 'jpeg', mimeTypes: [ 'image/jpeg', 'image/pjpeg' ] } as const satisfies Omit<AllowedType, 'extension'>;

// OOXML (docx/xlsx/pptx) and OpenDocument (odt/ods/odp) files are ZIP
// containers; legacy Office formats (doc/xls/ppt) are OLE compound files.
const ALLOWED_TYPES: readonly AllowedType[] = [
	{ extension: 'pdf', magic: 'pdf', mimeTypes: [ 'application/pdf' ] },
	{
		extension: 'doc', magic: 'ole', mimeTypes: [ 'application/msword' ], oleStreams: [ 'WordDocument' ],
	},
	{
		extension: 'docx',
		magic: 'zip',
		mimeTypes: [ 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ],
		zipEntries: ooxml( 'word/document.xml' ),
	},
	{
		extension: 'ppt', magic: 'ole', mimeTypes: [ 'application/vnd.ms-powerpoint' ], oleStreams: [ 'PowerPoint Document' ],
	},
	{
		extension: 'pptx',
		magic: 'zip',
		mimeTypes: [ 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ],
		zipEntries: ooxml( 'ppt/presentation.xml' ),
	},
	{
		extension: 'xls', magic: 'ole', mimeTypes: [ 'application/vnd.ms-excel' ], oleStreams: [ 'Workbook', 'Book' ],
	},
	{
		extension: 'xlsx',
		magic: 'zip',
		mimeTypes: [ 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ],
		zipEntries: ooxml( 'xl/workbook.xml' ),
	},
	{
		extension: 'odt', magic: 'zip', mimeTypes: [ ODT ], zipEntries: OPEN_DOCUMENT_ENTRIES, openDocumentType: ODT,
	},
	{
		extension: 'ods', magic: 'zip', mimeTypes: [ ODS ], zipEntries: OPEN_DOCUMENT_ENTRIES, openDocumentType: ODS,
	},
	{
		extension: 'odp', magic: 'zip', mimeTypes: [ ODP ], zipEntries: OPEN_DOCUMENT_ENTRIES, openDocumentType: ODP,
	},
	{ extension: 'jpg', ...JPEG },
	{ extension: 'jpeg', ...JPEG },
	{ extension: 'png', magic: 'png', mimeTypes: [ 'image/png' ] },
];

const TYPE_BY_EXTENSION = new Map<AllowedExtension, AllowedType>(
	ALLOWED_TYPES.map( ( type ) => [ type.extension, type ] )
);

export const ALLOWED_EXTENSIONS: readonly AllowedExtension[] = ALLOWED_TYPES.map( ( type ) => type.extension );

/** The `accept` attribute value for a file input that takes `extensions`. */
export function acceptAttribute( extensions: readonly AllowedExtension[] = ALLOWED_EXTENSIONS ): string {
	return extensions.map( ( extension ) => `.${ extension }` ).join( ',' );
}

/** Tolerated generic MIME types browsers send when they can't sniff the file. */
const GENERIC_MIME_TYPES = new Set( [ '', 'application/octet-stream', 'application/zip' ] );

export interface UploadDescriptor {
	filename: string;
	mimeType: string;
	size: number;
}

export interface UploadOptions {
	maxBytes: number;
	/** Narrows the built-in allowlist; defaults to every type in it. */
	allowedExtensions?: readonly AllowedExtension[];
}

export type DescriptorRejection = 'empty' | 'too-large' | 'type-not-allowed' | 'mime-mismatch';

export type ValidationResult =
	| { ok: true; extension: AllowedExtension; sanitizedFilename: string }
	| { ok: false; reason: DescriptorRejection };

export function getExtension( filename: string ): string {
	const lastDot = filename.lastIndexOf( '.' );
	if ( lastDot < 0 || lastDot === filename.length - 1 ) {
		return '';
	}
	return filename.slice( lastDot + 1 ).toLowerCase();
}

/** Longest file name kept; longer ones are cut before the extension. */
const MAX_FILENAME_LENGTH = 200;
const FALLBACK_FILENAME = 'file';

/** Strips directory components and control characters from a user filename. */
export function sanitizeFilename( filename: string ): string {
	const base = filename.split( /[/\\]/ ).pop() ?? filename;
	// Allowlist: letters (incl. umlauts), digits, and safe separators. macOS often
	// sends "ü" decomposed, so composing first keeps it one letter, and combining
	// marks stay for accents that have no precomposed form.
	const allowed = base
		.normalize( 'NFC' )
		.replace( /[^\p{L}\p{M}\p{N}._ -]/gu, '' )
		.replace( /\s+/g, ' ' )
		.trim();
	// A leading dot would hide the file once downloaded, so the fallback name goes before it.
	const cleaned = allowed.startsWith( '.' ) ? `${ FALLBACK_FILENAME }${ allowed }` : allowed;
	if ( cleaned.length <= MAX_FILENAME_LENGTH ) {
		return cleaned || FALLBACK_FILENAME;
	}

	// An allowed extension says what the file is and must survive the cut;
	// anything else after a dot is just more name.
	const suffix = isAllowedExtension( getExtension( cleaned ) ) ? cleaned.slice( cleaned.lastIndexOf( '.' ) ) : '';
	return cleaned.slice( 0, MAX_FILENAME_LENGTH - suffix.length ) + suffix;
}

function isAllowedExtension( extension: string ): extension is AllowedExtension {
	return TYPE_BY_EXTENSION.has( extension as AllowedExtension );
}

/**
 * Validates a descriptor (no byte access). Use {@link inspectFileContent} in
 * addition once the bytes are available.
 */
export function validateUploadDescriptor(
	descriptor: UploadDescriptor,
	{ maxBytes, allowedExtensions = ALLOWED_EXTENSIONS }: UploadOptions
): ValidationResult {
	const { filename, mimeType, size } = descriptor;

	if ( ! Number.isFinite( size ) || size <= 0 ) {
		return { ok: false, reason: 'empty' };
	}
	if ( size > maxBytes ) {
		return { ok: false, reason: 'too-large' };
	}

	const extension = getExtension( filename );
	const allowed = isAllowedExtension( extension ) && allowedExtensions.includes( extension ) ?
		TYPE_BY_EXTENSION.get( extension ) :
		undefined;
	if ( ! allowed ) {
		return { ok: false, reason: 'type-not-allowed' };
	}

	const normalizedMime = mimeType.toLowerCase().split( ';' )[ 0 ].trim();
	if ( ! GENERIC_MIME_TYPES.has( normalizedMime ) && ! allowed.mimeTypes.includes( normalizedMime ) ) {
		return { ok: false, reason: 'mime-mismatch' };
	}

	return { ok: true, extension: allowed.extension, sanitizedFilename: sanitizeFilename( filename ) };
}

/** The canonical MIME type to persist for a validated extension. */
export function getCanonicalMimeType( extension: AllowedExtension ): string {
	return TYPE_BY_EXTENSION.get( extension )!.mimeTypes[ 0 ];
}

function startsWith( bytes: Uint8Array, signature: number[] ): boolean {
	if ( bytes.length < signature.length ) {
		return false;
	}
	return signature.every( ( byte, index ) => bytes[ index ] === byte );
}

const MAGIC_SIGNATURES: Record<MagicFamily, ( bytes: Uint8Array ) => boolean> = {
	// "%PDF"
	pdf: ( bytes ) => startsWith( bytes, [ 0x25, 0x50, 0x44, 0x46 ] ),
	// ZIP local file header variants ("PK\x03\x04", "PK\x05\x06", "PK\x07\x08")
	zip: ( bytes ) =>
		startsWith( bytes, [ 0x50, 0x4b, 0x03, 0x04 ] ) ||
		startsWith( bytes, [ 0x50, 0x4b, 0x05, 0x06 ] ) ||
		startsWith( bytes, [ 0x50, 0x4b, 0x07, 0x08 ] ),
	// OLE2 compound file ("\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1")
	ole: ( bytes ) => startsWith( bytes, [ 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1 ] ),
	// JPEG start of image followed by a marker
	jpeg: ( bytes ) => startsWith( bytes, [ 0xff, 0xd8, 0xff ] ),
	// "\x89PNG\r\n\x1A\n"
	png: ( bytes ) => startsWith( bytes, [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] ),
};

/** What an upload's bytes turned out to be; `macros` and `encrypted` get their own refusal messages. */
export type FileContentVerdict = 'valid' | 'macros' | 'encrypted' | 'mismatch';

/**
 * Checks once that a file's bytes are what `extension` claims: the signature
 * of its family and every part a file of that kind contains, but no macros.
 */
export function inspectFileContent( extension: AllowedExtension, bytes: Uint8Array ): FileContentVerdict {
	const allowed = TYPE_BY_EXTENSION.get( extension );
	if ( allowed?.zipEntries && ! allowed.openDocumentType && MAGIC_SIGNATURES.ole( bytes ) ) {
		return holdsEncryptedPackage( readOleDirectory( toBuffer( bytes ) ) ) ? 'encrypted' : 'mismatch';
	}
	if ( ! allowed || ! MAGIC_SIGNATURES[ allowed.magic ]( bytes ) ) {
		return 'mismatch';
	}

	const content = toBuffer( bytes );
	if ( allowed.magic === 'pdf' ) {
		return inspectPdf( content );
	}
	if ( allowed.oleStreams ) {
		return inspectOleFile( content, allowed.extension, allowed.oleStreams );
	}
	if ( ! allowed.zipEntries ) {
		return 'valid';
	}

	const entries = readZipEntries( content );
	const names = entries?.map( ( entry ) => entry.name.toLowerCase() ) ?? [];
	if ( ! entries || ! allowed.zipEntries.every( ( name ) => names.includes( name ) ) ) {
		return 'mismatch';
	}
	if ( allowed.openDocumentType ) {
		if ( ! isOpenDocument( allowed.openDocumentType, content, entries ) ) {
			return 'mismatch';
		}
		if ( names.some( ( name ) => OPEN_DOCUMENT_MACRO_ENTRY.test( name ) ) ) {
			return 'macros';
		}
		const encrypted = isEncryptedOpenDocument( content, entries );
		if ( encrypted !== false ) {
			return encrypted === null ? 'mismatch' : 'encrypted';
		}
		const ole = holdsOleEntry( content, entries );
		const parts = ole === false ? readMatchingParts( content, entries, OPEN_DOCUMENT_XML_PART ) : null;
		if ( ole === null || ( ! ole && ! parts ) ) {
			return 'mismatch';
		}
		return ole || parts!.some( hasOpenDocumentEvent ) ? 'macros' : 'valid';
	}

	// The names alone give most macro files away, before anything is inflated.
	if ( names.some( ( name ) => OOXML_MACRO_ENTRY.test( name ) ) ) {
		return 'macros';
	}
	const parts = readOoxmlParts( content, entries );
	if ( ! parts ) {
		return 'mismatch';
	}
	const [ contentTypes = '', ...relationships ] = parts;
	if ( declaresMacroPart( contentTypes, names ) || relationships.some( declaresMacroRelationship ) ) {
		return 'macros';
	}
	const ole = holdsOleEntry( content, entries );
	const stories = ole === false ? readMatchingParts( content, entries, WORD_STORY_PART ) : null;
	const externalLinks = stories ? readMatchingParts( content, entries, EXCEL_EXTERNAL_LINK_PART ) : null;
	if ( ole === null || ( ! ole && ( ! stories || ! externalLinks ) ) ) {
		return 'mismatch';
	}
	return ole || stories!.some( hasDdeField ) || externalLinks!.some( ( part ) => EXCEL_DDE_LINK.test( part ) ) ?
		'macros' :
		'valid';
}

function toBuffer( bytes: Uint8Array ): Buffer {
	return Buffer.from( bytes.buffer, bytes.byteOffset, bytes.byteLength );
}
