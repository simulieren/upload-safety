/**
 * Checks the structure of WMA and WMV files (Microsoft ASF) and removes their metadata (title,
 * author, WM/ tags, cover pictures) without moving a byte. The metadata objects are overwritten
 * in place with Padding Objects of the same size and a zeroed payload.
 *
 * Refused: a Script Command Object makes Windows Media Player open URLs, and the DRM objects
 * carry license acquisition URLs that it opens too (Trojan.Wimad); DRM content cannot be checked
 * either.
 *
 * Limitation: markers, the file creation date and the codec data are kept.
 */

/** Bounds far above real files that keep a crafted one cheap. */
const MAX_TOP_LEVEL_OBJECTS = 1000;
const MAX_HEADER_OBJECTS = 10_000;

const GUID_LENGTH = 16;
const OBJECT_HEADER = GUID_LENGTH + 8;
/** Header Object: object header, u32 number of objects, two reserved bytes. */
const HEADER_OBJECT_PREFIX = OBJECT_HEADER + 6;
/** Header Extension payload: reserved GUID, u16 reserved, u32 data size. */
const EXTENSION_PREFIX = GUID_LENGTH + 2 + 4;

/** Converts the textual GUID of the ASF specification to its on-disk byte order (first three groups little-endian). */
function guid( text: string ): Buffer {
	const hex = text.replaceAll( '-', '' );
	const bytes = Buffer.from( hex, 'hex' );
	bytes.subarray( 0, 4 ).reverse();
	bytes.subarray( 4, 6 ).reverse();
	bytes.subarray( 6, 8 ).reverse();
	return bytes;
}

const HEADER_OBJECT = guid( '75B22630-668E-11CF-A6D9-00AA0062CE6C' );
const DATA_OBJECT = guid( '75B22636-668E-11CF-A6D9-00AA0062CE6C' );
const FILE_PROPERTIES_OBJECT = guid( '8CABDCA1-A947-11CF-8EE4-00C00C205365' );
const STREAM_PROPERTIES_OBJECT = guid( 'B7DC0791-A9B7-11CF-8EE6-00C00C205365' );
const HEADER_EXTENSION_OBJECT = guid( '5FBF03B5-A92E-11CF-8EE3-00C00C205365' );
const CONTENT_DESCRIPTION_OBJECT = guid( '75B22633-668E-11CF-A6D9-00AA0062CE6C' );
const EXTENDED_CONTENT_DESCRIPTION_OBJECT = guid( 'D2D0A440-E307-11D2-97F0-00A0C95EA850' );
const METADATA_OBJECT = guid( 'C5F8CBEA-5BAF-4877-8467-AA8C44FA4CCA' );
const METADATA_LIBRARY_OBJECT = guid( '44231C94-9498-49D1-A141-1D134E457054' );
const PADDING_OBJECT = guid( '1806D474-CADF-4509-A4BA-9AABCB96AAE8' );
const SCRIPT_COMMAND_OBJECT = guid( '1EFB1A30-0B62-11D0-A39B-00A0C90348F6' );
const AUDIO_MEDIA = guid( 'F8699E40-5B4D-11CF-A8FD-00805F5C442B' );
const VIDEO_MEDIA = guid( 'BC19EFC0-5B4D-11CF-A8FD-00805F5C442B' );

const SIMPLE_INDEX_OBJECT = guid( '33000890-E5B1-11CF-89F4-00A0C90349CB' );
const INDEX_OBJECT = guid( 'D6E229D3-35DA-11D1-9034-00A0C90349BE' );
const MEDIA_OBJECT_INDEX_OBJECT = guid( 'FEB103F8-12AD-4C64-840F-2A1D2F7AD48C' );
const TIMECODE_INDEX_OBJECT = guid( '3CB73FD0-0C4A-4803-953D-EDF7B6228F0C' );

/** The only top-level objects after the Data Object. */
const INDEX_OBJECTS: readonly Buffer[] = [ SIMPLE_INDEX_OBJECT, INDEX_OBJECT, MEDIA_OBJECT_INDEX_OBJECT, TIMECODE_INDEX_OBJECT ];

const CONTENT_ENCRYPTION_OBJECT = guid( '2211B3FB-BD23-11D2-B4B7-00A0C955FC6E' );
const EXTENDED_CONTENT_ENCRYPTION_OBJECT = guid( '298AE614-2622-4C17-B935-DAE07EE9289C' );
const DIGITAL_SIGNATURE_OBJECT = guid( '2211B3FC-BD23-11D2-B4B7-00A0C955FC6E' );
const ADVANCED_CONTENT_ENCRYPTION_OBJECT = guid( '43058533-6981-49E6-9B74-AD12CB86D58C' );

const ENCRYPTION_OBJECTS: readonly Buffer[] = [
	CONTENT_ENCRYPTION_OBJECT,
	EXTENDED_CONTENT_ENCRYPTION_OBJECT,
	DIGITAL_SIGNATURE_OBJECT,
	ADVANCED_CONTENT_ENCRYPTION_OBJECT,
];
const METADATA_OBJECTS: readonly Buffer[] = [
	CONTENT_DESCRIPTION_OBJECT,
	EXTENDED_CONTENT_DESCRIPTION_OBJECT,
	METADATA_OBJECT,
	METADATA_LIBRARY_OBJECT,
];

export interface AsfInspection {
	verdict: 'valid' | 'macros' | 'encrypted' | 'mismatch';
	/** The cleaned file when the verdict is `valid` (the input itself when nothing changed), else null. */
	bytes: Buffer | null;
}

interface AsfObject {
	/** Where the object's header starts. */
	start: number;
	end: number;
}

const MISMATCH: AsfInspection = { verdict: 'mismatch', bytes: null };

const hasGuid = ( bytes: Buffer, offset: number, expected: Buffer ): boolean => bytes.compare( expected, 0, GUID_LENGTH, offset, offset + GUID_LENGTH ) === 0;
const isOneOf = ( bytes: Buffer, offset: number, guids: readonly Buffer[] ): boolean => guids.some( ( expected ) => hasGuid( bytes, offset, expected ) );

/** The objects that follow each other exactly over `[start, end)`, or null when one does not read or there are more than `max`. */
function readObjects( bytes: Buffer, start: number, end: number, max: number ): AsfObject[] | null {
	const objects: AsfObject[] = [];
	for ( let offset = start; offset < end; ) {
		if ( objects.length === max || end - offset < OBJECT_HEADER ) {
			return null;
		}
		const size = bytes.readBigUInt64LE( offset + GUID_LENGTH );
		if ( size < BigInt( OBJECT_HEADER ) || size > BigInt( end - offset ) ) {
			return null;
		}
		objects.push( { start: offset, end: offset + Number( size ) } );
		offset += Number( size );
	}
	return objects;
}

/**
 * Checks an ASF file as a WMA (`video` false) or WMV (`video` true) and blanks its metadata.
 * Never throws.
 */
export function inspectAsf( content: Buffer, video: boolean ): AsfInspection {
	const top = readObjects( content, 0, content.length, MAX_TOP_LEVEL_OBJECTS );
	if ( ! top || top.length < 2 || ! hasGuid( content, top[ 0 ].start, HEADER_OBJECT ) ) {
		return MISMATCH;
	}
	const [ header, ...rest ] = top;
	if ( header.end - header.start < HEADER_OBJECT_PREFIX || content.readUInt16BE( header.start + OBJECT_HEADER + 4 ) !== 0x0102 ) {
		return MISMATCH;
	}
	if ( ! hasGuid( content, rest[ 0 ].start, DATA_OBJECT ) || ! rest.slice( 1 ).every( ( object ) => isOneOf( content, object.start, INDEX_OBJECTS ) ) ) {
		return MISMATCH;
	}

	const children = readObjects( content, header.start + HEADER_OBJECT_PREFIX, header.end, MAX_HEADER_OBJECTS );
	if ( ! children ) {
		return MISMATCH;
	}
	const budget = { left: MAX_HEADER_OBJECTS - children.length };
	const all: AsfObject[] = [];
	for ( const child of children ) {
		all.push( child );
		if ( hasGuid( content, child.start, HEADER_EXTENSION_OBJECT ) ) {
			const prefixEnd = child.start + OBJECT_HEADER + EXTENSION_PREFIX;
			if ( prefixEnd > child.end || content.readUInt32LE( prefixEnd - 4 ) !== child.end - prefixEnd ) {
				return MISMATCH;
			}
			const inner = readObjects( content, prefixEnd, child.end, Math.max( budget.left, 0 ) );
			if ( ! inner ) {
				return MISMATCH;
			}
			budget.left -= inner.length;
			all.push( ...inner );
		}
	}

	let hasFileProperties = false;
	let hasAudio = false;
	let hasVideo = false;
	for ( const object of all ) {
		if ( isOneOf( content, object.start, ENCRYPTION_OBJECTS ) ) {
			return { verdict: 'encrypted', bytes: null };
		}
		if ( hasGuid( content, object.start, SCRIPT_COMMAND_OBJECT ) ) {
			return { verdict: 'macros', bytes: null };
		}
	}
	for ( const object of all ) {
		if ( hasGuid( content, object.start, FILE_PROPERTIES_OBJECT ) ) {
			hasFileProperties = true;
		} else if ( hasGuid( content, object.start, STREAM_PROPERTIES_OBJECT ) ) {
			if ( object.end - object.start < OBJECT_HEADER + GUID_LENGTH ) {
				return MISMATCH;
			}
			const type = object.start + OBJECT_HEADER;
			hasAudio ||= hasGuid( content, type, AUDIO_MEDIA );
			hasVideo ||= hasGuid( content, type, VIDEO_MEDIA );
		}
	}
	if ( ! hasFileProperties || ! ( video ? hasVideo : hasAudio && ! hasVideo ) ) {
		return MISMATCH;
	}

	const metadata = all.filter( ( object ) => isOneOf( content, object.start, METADATA_OBJECTS ) );
	if ( metadata.length === 0 ) {
		return { verdict: 'valid', bytes: content };
	}
	const cleaned = Buffer.from( content );
	for ( const object of metadata ) {
		PADDING_OBJECT.copy( cleaned, object.start );
		cleaned.fill( 0, object.start + OBJECT_HEADER, object.end );
	}
	return { verdict: 'valid', bytes: cleaned };
}
