/**
 * Checks and cleans GIF, BMP and ICO images and MP3, AAC, WAV, FLAC and Ogg audio without decoding
 * them, in the way `photo-metadata.ts` handles photos: GIF blocks, WAV chunks and FLAC metadata
 * blocks are kept only when known, so comments, XMP and tags are dropped whole while the image
 * and audio data stay byte for byte. BMP, ICO and Ogg only get a structure check: BMP and ICO
 * hold no metadata, and Ogg comments (Vorbis, Opus tags) live inside packets that can span
 * pages, so they stay in the file.
 *
 * Every function returns the bytes to store, or null when the structure does not read.
 */

const MAX_BLOCKS = 100_000;
const MAX_OGG_PAGES = 1_000_000;

const GIF_SIGNATURES = [ 'GIF87a', 'GIF89a' ];
const GIF_HEADER_SIZE = 6;
const GIF_SCREEN_DESCRIPTOR_SIZE = 7;
const GIF_IMAGE_DESCRIPTOR_SIZE = 9;
const GIF_IMAGE = 0x2c;
const GIF_EXTENSION = 0x21;
const GIF_TRAILER = 0x3b;
const GIF_GRAPHIC_CONTROL = 0xf9;
const GIF_APPLICATION = 0xff;
const GIF_COLOUR_TABLE_FLAG = 0x80;
const GIF_COLOUR_TABLE_SIZE_MASK = 0x07;
const GIF_APPLICATION_ID_SIZE = 11;
// Looping and the colour profile; any other application extension, XMP above all, may carry metadata.
const GIF_KEPT_APPLICATIONS = new Set( [ 'NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012' ] );

const BMP_FILE_HEADER_SIZE = 14;
const BMP_DIB_SIZES = new Set( [ 12, 40, 52, 56, 64, 108, 124 ] );
const BMP_CORE_HEADER_SIZE = 12;
const BMP_BITS_PER_PIXEL = new Set( [ 1, 4, 8, 16, 24, 32 ] );

const ICO_HEADER_SIZE = 6;
const ICO_ENTRY_SIZE = 16;
const ICO_TYPE_ICON = 1;
const ICO_MAX_IMAGES = 256;
const BITMAP_INFO_HEADER_SIZE = 40;
const PNG_SIGNATURE = Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] );

const ID3V2_HEADER_SIZE = 10;
const ID3V2_FOOTER_FLAG = 0x10;
const ID3V2_FOOTER_SIZE = 10;
const ID3V2_MAX_TAGS = 8;
const ID3V1_SIZE = 128;
const ID3V1_ENHANCED_SIZE = 227;
const APE_FOOTER_SIZE = 32;
const APE_HAS_HEADER = 0x80000000;
const LYRICS3_END = 'LYRICS200';
const LYRICS3_START = 'LYRICSBEGIN';
const LYRICS3_SIZE_DIGITS = 6;
const MPEG_HEADER_SIZE = 4;
const MPEG_RESERVED_VERSION = 1;
const MPEG_VERSION_1 = 3;
const MPEG_LAYER_1 = 3;
const MPEG_LAYER_3 = 1;
const MPEG_BAD_BITRATE = 15;
const MPEG_BAD_SAMPLE_RATE = 3;
// Kilobits per second by bitrate index 1 to 14: version 1 layers I, II, III, then version 2 and 2.5 layer I, then layers II and III.
const MPEG_BITRATES = {
	v1l1: [ 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448 ],
	v1l2: [ 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384 ],
	v1l3: [ 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320 ],
	v2l1: [ 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256 ],
	v2l23: [ 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160 ],
};
// Hz by sample rate index, for version 1, version 2 and version 2.5.
const MPEG_SAMPLE_RATES: Record<number, number[]> = {
	3: [ 44100, 48000, 32000 ],
	2: [ 22050, 24000, 16000 ],
	0: [ 11025, 12000, 8000 ],
};

const ADTS_HEADER_SIZE = 7;
const ADTS_HEADER_SIZE_WITH_CRC = 9;
const ADTS_MAX_FRAMES = 10_000_000;
const ADTS_SAMPLING_INDEXES = 13;

const RIFF_HEADER_SIZE = 12;
const RIFF_CHUNK_HEADER_SIZE = 8;
const WAV_KEPT_CHUNKS = new Set( [ 'fmt ', 'fact', 'data' ] );

const FLAC_SIGNATURE = 'fLaC';
const FLAC_BLOCK_HEADER_SIZE = 4;
const FLAC_LAST_BLOCK = 0x80;
const FLAC_TYPE_MASK = 0x7f;
const FLAC_STREAMINFO = 0;
const FLAC_STREAMINFO_SIZE = 34;
const FLAC_INVALID_TYPE = 127;
// STREAMINFO, SEEKTABLE and CUESHEET; padding, applications, Vorbis comments, pictures and unknown types are dropped.
const FLAC_KEPT_BLOCKS = new Set( [ 0, 3, 5 ] );
const FLAC_FRAME_SYNC = 0xfff8;
const FLAC_FRAME_SYNC_MASK = 0xfffe;

const OGG_CAPTURE = 'OggS';
const OGG_PAGE_HEADER_SIZE = 27;
const OGG_BEGIN_OF_STREAM = 0x02;
const OGG_CRC_OFFSET = 22;
const OGG_CRC_POLYNOMIAL = 0x04c11db7;

/** The bytes between `start` and `end`, as `content` itself when that is all of it. */
function slice( content: Buffer, start: number, end: number ): Buffer {
	return start === 0 && end === content.length ? content : Buffer.from( content.subarray( start, end ) );
}

/** The offset after a run of GIF data sub-blocks starting at `offset`, or -1 when it runs past the end. */
function skipSubBlocks( bytes: Buffer, offset: number ): number {
	let position = offset;
	for ( let blocks = 0; blocks <= bytes.length; blocks++ ) {
		if ( position >= bytes.length ) {
			return -1;
		}
		const size = bytes[ position ];
		position += 1 + size;
		if ( size === 0 ) {
			return position <= bytes.length ? position : -1;
		}
	}
	return -1;
}

function gifColourTableSize( flags: number ): number {
	return flags & GIF_COLOUR_TABLE_FLAG ? 3 * 2 ** ( ( flags & GIF_COLOUR_TABLE_SIZE_MASK ) + 1 ) : 0;
}

/**
 * The GIF without comments, plain text and application extensions other than looping and the colour
 * profile, or null when its blocks do not read or it holds no image. Bytes after the trailer are cut
 * off, so a GIF cannot double as an archive; a missing trailer is added when the data ended cleanly.
 */
export function stripGif( content: Buffer ): Buffer | null {
	if ( content.length < GIF_HEADER_SIZE + GIF_SCREEN_DESCRIPTOR_SIZE || ! GIF_SIGNATURES.includes( content.toString( 'latin1', 0, GIF_HEADER_SIZE ) ) ) {
		return null;
	}
	const start = GIF_HEADER_SIZE + GIF_SCREEN_DESCRIPTOR_SIZE + gifColourTableSize( content[ GIF_HEADER_SIZE + 4 ] );
	if ( start > content.length ) {
		return null;
	}
	const parts: Buffer[] = [ content.subarray( 0, start ) ];
	let images = 0;
	let offset = start;
	for ( let blocks = 0; blocks < MAX_BLOCKS; blocks++ ) {
		if ( offset === content.length ) {
			// The data ended cleanly after a complete block, only the trailer is missing.
			return images > 0 ? Buffer.concat( [ ...parts, Buffer.from( [ GIF_TRAILER ] ) ] ) : null;
		}
		const type = content[ offset ];
		if ( type === GIF_TRAILER ) {
			return images > 0 ? Buffer.concat( [ ...parts, Buffer.from( [ GIF_TRAILER ] ) ] ) : null;
		}
		if ( type === GIF_IMAGE ) {
			if ( offset + 1 + GIF_IMAGE_DESCRIPTOR_SIZE > content.length ) {
				return null;
			}
			const tableEnd = offset + 1 + GIF_IMAGE_DESCRIPTOR_SIZE + gifColourTableSize( content[ offset + GIF_IMAGE_DESCRIPTOR_SIZE ] );
			// The byte after the colour table is the LZW minimum code size, the sub-blocks follow it.
			const end = tableEnd < content.length ? skipSubBlocks( content, tableEnd + 1 ) : -1;
			if ( end < 0 ) {
				return null;
			}
			parts.push( content.subarray( offset, end ) );
			images++;
			offset = end;
		} else if ( type === GIF_EXTENSION ) {
			if ( offset + 2 > content.length ) {
				return null;
			}
			const label = content[ offset + 1 ];
			const end = skipSubBlocks( content, offset + 2 );
			if ( end < 0 ) {
				return null;
			}
			const applicationId = label === GIF_APPLICATION && content[ offset + 2 ] === GIF_APPLICATION_ID_SIZE
				? content.toString( 'latin1', offset + 3, offset + 3 + GIF_APPLICATION_ID_SIZE )
				: '';
			if ( label === GIF_GRAPHIC_CONTROL || GIF_KEPT_APPLICATIONS.has( applicationId ) ) {
				parts.push( content.subarray( offset, end ) );
			}
			offset = end;
		} else {
			return null;
		}
	}
	return null;
}

/** The BMP unchanged when its headers read, null otherwise. */
export function checkBmp( content: Buffer ): Buffer | null {
	if ( content.length < BMP_FILE_HEADER_SIZE + 4 || content.toString( 'latin1', 0, 2 ) !== 'BM' ) {
		return null;
	}
	const dibSize = content.readUInt32LE( BMP_FILE_HEADER_SIZE );
	const pixelOffset = content.readUInt32LE( 10 );
	if ( ! BMP_DIB_SIZES.has( dibSize ) || BMP_FILE_HEADER_SIZE + dibSize > content.length ) {
		return null;
	}
	if ( pixelOffset < BMP_FILE_HEADER_SIZE + dibSize || pixelOffset >= content.length ) {
		return null;
	}
	const core = dibSize === BMP_CORE_HEADER_SIZE;
	const width = core ? content.readUInt16LE( 18 ) : content.readInt32LE( 18 );
	const height = core ? content.readUInt16LE( 20 ) : content.readInt32LE( 22 );
	const planes = content.readUInt16LE( core ? 22 : 26 );
	const bitsPerPixel = content.readUInt16LE( core ? 24 : 28 );
	return width !== 0 && height !== 0 && planes === 1 && BMP_BITS_PER_PIXEL.has( bitsPerPixel ) ? content : null;
}

/** The ICO unchanged when its directory and each image's header read, null otherwise; cursors (CUR) are refused. */
export function checkIco( content: Buffer ): Buffer | null {
	if ( content.length < ICO_HEADER_SIZE || content.readUInt16LE( 0 ) !== 0 || content.readUInt16LE( 2 ) !== ICO_TYPE_ICON ) {
		return null;
	}
	const count = content.readUInt16LE( 4 );
	const directoryEnd = ICO_HEADER_SIZE + count * ICO_ENTRY_SIZE;
	if ( count < 1 || count > ICO_MAX_IMAGES || directoryEnd > content.length ) {
		return null;
	}
	for ( let index = 0; index < count; index++ ) {
		const entry = ICO_HEADER_SIZE + index * ICO_ENTRY_SIZE;
		const size = content.readUInt32LE( entry + 8 );
		const offset = content.readUInt32LE( entry + 12 );
		if ( size === 0 || offset < directoryEnd || offset + size > content.length ) {
			return null;
		}
		const isPng = size >= PNG_SIGNATURE.length && content.subarray( offset, offset + PNG_SIGNATURE.length ).equals( PNG_SIGNATURE );
		const isBitmap = size >= BITMAP_INFO_HEADER_SIZE && content.readUInt32LE( offset ) === BITMAP_INFO_HEADER_SIZE;
		if ( ! isPng && ! isBitmap ) {
			return null;
		}
	}
	return content;
}

/** The length of the MPEG audio frame whose header starts at `offset`, or 0 when it is not a valid header. */
function mpegFrameLength( bytes: Buffer, offset: number ): number {
	if ( offset + MPEG_HEADER_SIZE > bytes.length ) {
		return 0;
	}
	const [ first, second, third ] = [ bytes[ offset ], bytes[ offset + 1 ], bytes[ offset + 2 ] ];
	const version = ( second >> 3 ) & 3;
	const layer = ( second >> 1 ) & 3;
	const bitrateIndex = third >> 4;
	const rateIndex = ( third >> 2 ) & 3;
	if ( first !== 0xff || ( second & 0xe0 ) !== 0xe0 || version === MPEG_RESERVED_VERSION || layer === 0 ) {
		return 0;
	}
	if ( bitrateIndex === 0 || bitrateIndex === MPEG_BAD_BITRATE || rateIndex === MPEG_BAD_SAMPLE_RATE ) {
		return 0;
	}
	const v1 = version === MPEG_VERSION_1;
	const table = layer === MPEG_LAYER_1 ? ( v1 ? MPEG_BITRATES.v1l1 : MPEG_BITRATES.v2l1 )
		: v1 ? ( layer === MPEG_LAYER_3 ? MPEG_BITRATES.v1l3 : MPEG_BITRATES.v1l2 ) : MPEG_BITRATES.v2l23;
	const bitrate = table[ bitrateIndex - 1 ] * 1000;
	const sampleRate = MPEG_SAMPLE_RATES[ version ][ rateIndex ];
	const padding = ( third >> 1 ) & 1;
	if ( layer === MPEG_LAYER_1 ) {
		return ( Math.floor( 12 * bitrate / sampleRate ) + padding ) * 4;
	}
	return Math.floor( ( layer === MPEG_LAYER_3 && ! v1 ? 72 : 144 ) * bitrate / sampleRate ) + padding;
}

/** The end of the ID3v2 tags at the start of `bytes` (0 when there are none), or -1 when one does not read. */
function skipId3v2( bytes: Buffer ): number {
	let offset = 0;
	for ( let tags = 0; tags < ID3V2_MAX_TAGS && bytes.toString( 'latin1', offset, offset + 3 ) === 'ID3'; tags++ ) {
		if ( offset + ID3V2_HEADER_SIZE > bytes.length || bytes[ offset + 3 ] === 0xff ) {
			return -1;
		}
		const sizeBytes = [ ...bytes.subarray( offset + 6, offset + 10 ) ];
		if ( sizeBytes.some( ( byte ) => byte & 0x80 ) ) {
			return -1;
		}
		const size = sizeBytes.reduce( ( sum, byte ) => ( sum << 7 ) | byte, 0 );
		const footer = bytes[ offset + 5 ] & ID3V2_FOOTER_FLAG ? ID3V2_FOOTER_SIZE : 0;
		offset += ID3V2_HEADER_SIZE + size + footer;
		if ( offset > bytes.length ) {
			return -1;
		}
	}
	return offset;
}

/** Where the tags at the end of `bytes` (ID3v1, APEv2, Lyrics3) begin, given that the audio starts at `start`. */
function findTrailingTags( bytes: Buffer, start: number ): number {
	let end = bytes.length;
	if ( end - start >= ID3V1_SIZE && bytes.toString( 'latin1', end - ID3V1_SIZE, end - ID3V1_SIZE + 3 ) === 'TAG' ) {
		end -= ID3V1_SIZE;
		if ( end - start >= ID3V1_ENHANCED_SIZE && bytes.toString( 'latin1', end - ID3V1_ENHANCED_SIZE, end - ID3V1_ENHANCED_SIZE + 4 ) === 'TAG+' ) {
			end -= ID3V1_ENHANCED_SIZE;
		}
	}
	// APEv2 and Lyrics3 come in either order before ID3v1, a few of each at most.
	for ( let round = 0; round < 4; round++ ) {
		const footer = end - APE_FOOTER_SIZE;
		if ( footer >= start && bytes.toString( 'latin1', footer, footer + 8 ) === 'APETAGEX' ) {
			const size = bytes.readUInt32LE( footer + 12 );
			const header = bytes.readUInt32LE( footer + 20 ) & APE_HAS_HEADER ? APE_FOOTER_SIZE : 0;
			if ( size < APE_FOOTER_SIZE || size + header > end - start ) {
				break;
			}
			end -= size + header;
			continue;
		}
		const marker = end - LYRICS3_END.length;
		if ( marker - LYRICS3_SIZE_DIGITS >= start && bytes.toString( 'latin1', marker, end ) === LYRICS3_END ) {
			const digits = bytes.toString( 'latin1', marker - LYRICS3_SIZE_DIGITS, marker );
			const size = /^\d{6}$/.test( digits ) ? Number( digits ) : -1;
			const lyricsStart = marker - LYRICS3_SIZE_DIGITS - size;
			if ( size < 0 || lyricsStart < start || bytes.toString( 'latin1', lyricsStart, lyricsStart + LYRICS3_START.length ) !== LYRICS3_START ) {
				break;
			}
			end = lyricsStart;
			continue;
		}
		break;
	}
	return end;
}

/**
 * The MP3 audio without ID3v2, ID3v1, APEv2 and Lyrics3 tags, or null when it does not start with a valid
 * MPEG frame that is followed by another one (or the end). Only the first two frame headers are checked, so
 * a damaged stream further in is not noticed.
 */
export function stripMp3( content: Buffer ): Buffer | null {
	const start = skipId3v2( content );
	if ( start < 0 ) {
		return null;
	}
	const end = findTrailingTags( content, start );
	const audio = content.subarray( start, end );
	const length = mpegFrameLength( audio, 0 );
	if ( length === 0 || length > audio.length || ( length < audio.length && mpegFrameLength( audio, length ) === 0 ) ) {
		return null;
	}
	return slice( content, start, end );
}

/** The length of the ADTS frame whose header starts at `offset`, or 0 when it is not a valid header. */
function adtsFrameLength( bytes: Buffer, offset: number ): number {
	if ( offset + ADTS_HEADER_SIZE > bytes.length ) {
		return 0;
	}
	const [ first, second, third ] = [ bytes[ offset ], bytes[ offset + 1 ], bytes[ offset + 2 ] ];
	const layer = ( second >> 1 ) & 3;
	const headerSize = second & 1 ? ADTS_HEADER_SIZE : ADTS_HEADER_SIZE_WITH_CRC;
	const samplingIndex = ( third >> 2 ) & 0xf;
	const length = ( ( bytes[ offset + 3 ] & 3 ) << 11 ) | ( bytes[ offset + 4 ] << 3 ) | ( bytes[ offset + 5 ] >> 5 );
	if ( first !== 0xff || ( second & 0xf0 ) !== 0xf0 || layer !== 0 || samplingIndex >= ADTS_SAMPLING_INDEXES || length < headerSize ) {
		return 0;
	}
	return length;
}

/**
 * The raw ADTS AAC frames without ID3v2, ID3v1, APEv2 and Lyrics3 tags, or null when the audio is not a
 * run of valid ADTS frames ending exactly at the end of the audio. Every frame header is walked, so nothing
 * unchecked can sit between frames or after the last one.
 */
export function stripAac( content: Buffer ): Buffer | null {
	const start = skipId3v2( content );
	if ( start < 0 ) {
		return null;
	}
	const end = findTrailingTags( content, start );
	const audio = content.subarray( start, end );
	let offset = 0;
	for ( let frames = 0; offset < audio.length; frames++ ) {
		const length = frames < ADTS_MAX_FRAMES ? adtsFrameLength( audio, offset ) : 0;
		if ( length === 0 || offset + length > audio.length ) {
			return null;
		}
		offset += length;
	}
	return audio.length > 0 ? slice( content, start, end ) : null;
}

function riffChunk( type: string, payload: Buffer ): Buffer {
	const chunk = Buffer.alloc( RIFF_CHUNK_HEADER_SIZE + payload.length + ( payload.length & 1 ) );
	chunk.write( type, 0, 'latin1' );
	chunk.writeUInt32LE( payload.length, 4 );
	payload.copy( chunk, RIFF_CHUNK_HEADER_SIZE );
	return chunk;
}

/**
 * The WAV with only its `fmt `, `fact` and `data` chunks (LIST/INFO, id3, bext, iXML, XMP and the rest are
 * dropped), or null when the chunks do not read or `data` does not follow `fmt `. Bytes after the RIFF
 * size are cut off.
 */
export function stripWav( content: Buffer ): Buffer | null {
	if ( content.length < RIFF_HEADER_SIZE || content.toString( 'latin1', 0, 4 ) !== 'RIFF' || content.toString( 'latin1', 8, 12 ) !== 'WAVE' ) {
		return null;
	}
	const end = RIFF_CHUNK_HEADER_SIZE + content.readUInt32LE( 4 );
	if ( end > content.length || end < RIFF_HEADER_SIZE ) {
		return null;
	}
	const chunks: Buffer[] = [];
	let formatted = false;
	let drawn = false;
	let offset = RIFF_HEADER_SIZE;
	for ( let count = 0; count < MAX_BLOCKS && offset + RIFF_CHUNK_HEADER_SIZE <= end; count++ ) {
		const dataStart = offset + RIFF_CHUNK_HEADER_SIZE;
		const dataEnd = dataStart + content.readUInt32LE( offset + 4 );
		if ( dataEnd > end ) {
			return null;
		}
		const type = content.toString( 'latin1', offset, offset + 4 );
		if ( WAV_KEPT_CHUNKS.has( type ) ) {
			if ( type === 'data' && ! formatted ) {
				return null;
			}
			formatted ||= type === 'fmt ';
			drawn ||= type === 'data';
			chunks.push( riffChunk( type, content.subarray( dataStart, dataEnd ) ) );
		}
		offset = dataEnd + ( ( dataEnd - dataStart ) & 1 );
	}
	if ( offset < end && offset + RIFF_CHUNK_HEADER_SIZE <= end || ! drawn ) {
		return null;
	}
	const header = Buffer.alloc( RIFF_HEADER_SIZE );
	header.write( 'RIFF', 0, 'latin1' );
	header.writeUInt32LE( 4 + chunks.reduce( ( sum, chunk ) => sum + chunk.length, 0 ), 4 );
	header.write( 'WAVE', 8, 'latin1' );
	return Buffer.concat( [ header, ...chunks ] );
}

/**
 * The FLAC with only its STREAMINFO, SEEKTABLE and CUESHEET blocks (padding, applications, Vorbis comments and
 * pictures are dropped), or null when the blocks do not read or the audio does not start with a frame sync.
 * Whatever follows the frames, such as a trailing tag, is left as it is.
 */
export function stripFlac( content: Buffer ): Buffer | null {
	if ( content.length < FLAC_SIGNATURE.length + FLAC_BLOCK_HEADER_SIZE || content.toString( 'latin1', 0, 4 ) !== FLAC_SIGNATURE ) {
		return null;
	}
	const kept: Buffer[] = [];
	let offset = FLAC_SIGNATURE.length;
	for ( let blocks = 0, last = false; ! last; blocks++ ) {
		if ( blocks >= MAX_BLOCKS || offset + FLAC_BLOCK_HEADER_SIZE > content.length ) {
			return null;
		}
		const type = content[ offset ] & FLAC_TYPE_MASK;
		const length = content.readUIntBE( offset + 1, 3 );
		const end = offset + FLAC_BLOCK_HEADER_SIZE + length;
		if ( end > content.length || type === FLAC_INVALID_TYPE ) {
			return null;
		}
		if ( blocks === 0 && ( type !== FLAC_STREAMINFO || length !== FLAC_STREAMINFO_SIZE ) ) {
			return null;
		}
		if ( FLAC_KEPT_BLOCKS.has( type ) ) {
			kept.push( Buffer.from( content.subarray( offset, end ) ) );
		}
		last = ( content[ offset ] & FLAC_LAST_BLOCK ) !== 0;
		offset = end;
	}
	if ( offset + 2 > content.length || ( content.readUInt16BE( offset ) & FLAC_FRAME_SYNC_MASK ) !== FLAC_FRAME_SYNC ) {
		return null;
	}
	for ( const block of kept ) {
		block[ 0 ] &= FLAC_TYPE_MASK;
	}
	kept[ kept.length - 1 ][ 0 ] |= FLAC_LAST_BLOCK;
	return Buffer.concat( [ Buffer.from( FLAC_SIGNATURE, 'latin1' ), ...kept, content.subarray( offset ) ] );
}

const OGG_CRC_TABLE = Array.from( { length: 256 }, ( _, index ) => {
	let value = index << 24;
	for ( let bit = 0; bit < 8; bit++ ) {
		value = value & 0x80000000 ? ( value << 1 ) ^ OGG_CRC_POLYNOMIAL : value << 1;
	}
	return value >>> 0;
} );

/** The Ogg checksum of a page, with its own CRC field counted as zero. */
function oggCrc( page: Buffer ): number {
	let crc = 0;
	for ( let index = 0; index < page.length; index++ ) {
		const byte = index >= OGG_CRC_OFFSET && index < OGG_CRC_OFFSET + 4 ? 0 : page[ index ];
		crc = ( ( crc << 8 ) ^ OGG_CRC_TABLE[ ( ( crc >>> 24 ) ^ byte ) & 0xff ] ) >>> 0;
	}
	return crc;
}

/**
 * The Ogg unchanged when the file is a run of whole pages with correct checksums starting with a begin-of-stream
 * page, null otherwise. Comments (Vorbis, Opus tags) sit inside packets that can span pages, so they are not
 * removed; bytes after the last page make the file unreadable instead of being cut.
 */
export function checkOgg( content: Buffer ): Buffer | null {
	let offset = 0;
	for ( let pages = 0; offset < content.length; pages++ ) {
		if ( pages >= MAX_OGG_PAGES || offset + OGG_PAGE_HEADER_SIZE > content.length ) {
			return null;
		}
		if ( content.toString( 'latin1', offset, offset + 4 ) !== OGG_CAPTURE || content[ offset + 4 ] !== 0 ) {
			return null;
		}
		if ( pages === 0 && ! ( content[ offset + 5 ] & OGG_BEGIN_OF_STREAM ) ) {
			return null;
		}
		const segments = content[ offset + 26 ];
		const bodyStart = offset + OGG_PAGE_HEADER_SIZE + segments;
		if ( bodyStart > content.length ) {
			return null;
		}
		let bodySize = 0;
		for ( let segment = 0; segment < segments; segment++ ) {
			bodySize += content[ offset + OGG_PAGE_HEADER_SIZE + segment ];
		}
		const end = bodyStart + bodySize;
		if ( end > content.length || oggCrc( content.subarray( offset, end ) ) !== content.readUInt32LE( offset + OGG_CRC_OFFSET ) ) {
			return null;
		}
		offset = end;
	}
	return offset > 0 ? content : null;
}
