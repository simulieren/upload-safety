/**
 * Finds out whether a legacy PowerPoint file (.ppt) holds a VBA project. PowerPoint
 * compresses the project into its document stream, so no VBA storage shows in the
 * OLE directory; the VBAInfoAtom of the DocumentContainer says whether there is one.
 */

/** A record's type and the bounds of its body within the stream. */
interface PowerPointRecord {
	type: number;
	start: number;
	end: number;
}

const RECORD_HEADER_SIZE = 8;
const CURRENT_USER_ATOM = 0x0ff6;
/** The atom's header, size, token and the offset of the current edit. */
const CURRENT_USER_FIELDS_END = 20;
// Encrypted files carry another token; their records cannot be read without the password.
const UNENCRYPTED_TOKEN = 0xe391c05f;
const ENCRYPTED_TOKEN = 0xf3d1c4df;
const USER_EDIT_ATOM = 0x0ff5;
const USER_EDIT_SIZE = 28;
const PERSIST_DIRECTORY_ATOM = 0x1772;
const DOCUMENT_CONTAINER = 0x03e8;
// DocumentContainer > DocInfoListContainer > VBAInfoContainer > VBAInfoAtom.
const VBA_INFO_PATH = [ 0x07d0, 0x03ff, 0x0400 ];
const VBA_INFO_SIZE = 12;
/** Caps far above real files (at most a few hundred of each) that bound a crafted one. */
const MAX_EDITS = 4096;
const MAX_PERSIST_OFFSETS = 65536;
const MAX_RECORDS = 65536;

function readRecord( stream: Buffer, offset: number ): PowerPointRecord | null {
	if ( offset + RECORD_HEADER_SIZE > stream.length ) {
		return null;
	}
	const end = offset + RECORD_HEADER_SIZE + stream.readUInt32LE( offset + 4 );
	return end <= stream.length ? { type: stream.readUInt16LE( offset + 2 ), start: offset + RECORD_HEADER_SIZE, end } : null;
}

/** The records within a container's body, or null when one runs past it or the budget runs out. */
function readChildren( stream: Buffer, container: PowerPointRecord, budget: { records: number } ): PowerPointRecord[] | null {
	const children: PowerPointRecord[] = [];
	for ( let offset = container.start; offset < container.end; ) {
		const child = readRecord( stream, offset );
		if ( ! child || child.end > container.end || --budget.records < 0 ) {
			return null;
		}
		children.push( child );
		offset = child.end;
	}
	return children;
}

/** Whether a DocumentContainer's VBAInfoAtom sets `fHasMacros` or a `persistIdRef`, or null when malformed. */
function documentHasVba( stream: Buffer, document: PowerPointRecord, budget: { records: number } ): boolean | null {
	let records = [ document ];
	for ( const type of VBA_INFO_PATH ) {
		const children = records.map( ( record ) => readChildren( stream, record, budget ) );
		if ( children.includes( null ) ) {
			return null;
		}
		records = children.flat().filter( ( child ): child is PowerPointRecord => child?.type === type );
	}
	if ( records.some( ( atom ) => atom.end - atom.start < VBA_INFO_SIZE ) ) {
		return null;
	}
	// A reference alone counts, in case PowerPoint loads the project despite a cleared flag.
	return records.some( ( atom ) => stream.readUInt32LE( atom.start ) !== 0 || stream.readUInt32LE( atom.start + 4 ) !== 0 );
}

/** Whether the CurrentUserAtom marks the file as encrypted. */
export function isEncryptedPowerPoint( currentUser: Buffer ): boolean {
	const user = readRecord( currentUser, 0 );
	return user?.type === CURRENT_USER_ATOM && user.end >= CURRENT_USER_FIELDS_END && currentUser.readUInt32LE( 12 ) === ENCRYPTED_TOKEN;
}

/**
 * Whether any DocumentContainer that a user edit's persist directory points at
 * holds a VBA project; null for an encrypted or malformed file.
 */
export function hasPowerPointVba( stream: Buffer, currentUser: Buffer ): boolean | null {
	const user = readRecord( currentUser, 0 );
	if ( user?.type !== CURRENT_USER_ATOM || user.end < CURRENT_USER_FIELDS_END ||
		currentUser.readUInt32LE( 12 ) !== UNENCRYPTED_TOKEN ) {
		return null;
	}

	const visited = new Set<number>();
	const documents = new Set<number>();
	let persistOffsets = 0;
	let editOffset = currentUser.readUInt32LE( 16 );
	do {
		const edit = readRecord( stream, editOffset );
		if ( edit?.type !== USER_EDIT_ATOM || edit.end - edit.start < USER_EDIT_SIZE ||
			visited.has( editOffset ) || visited.size === MAX_EDITS ) {
			return null;
		}
		visited.add( editOffset );
		const directory = readRecord( stream, stream.readUInt32LE( edit.start + 12 ) );
		if ( directory?.type !== PERSIST_DIRECTORY_ATOM ) {
			return null;
		}
		// Each entry packs a 20-bit first persist ID and a 12-bit count of the offsets that follow.
		for ( let position = directory.start; position < directory.end; ) {
			const count = position + 4 <= directory.end ? stream.readUInt32LE( position ) >>> 20 : -1;
			const offsetsEnd = position + 4 + count * 4;
			persistOffsets += count;
			if ( count < 0 || offsetsEnd > directory.end || persistOffsets > MAX_PERSIST_OFFSETS ) {
				return null;
			}
			for ( let entry = position + 4; entry < offsetsEnd; entry += 4 ) {
				const offset = stream.readUInt32LE( entry );
				if ( readRecord( stream, offset )?.type === DOCUMENT_CONTAINER ) {
					documents.add( offset );
				}
			}
			position = offsetsEnd;
		}
		editOffset = stream.readUInt32LE( edit.start + 8 );
	} while ( editOffset !== 0 );

	if ( ! documents.size ) {
		return null;
	}
	const budget = { records: MAX_RECORDS };
	const verdicts = Array.from( documents, ( offset ) => documentHasVba( stream, readRecord( stream, offset )!, budget ) );
	return verdicts.includes( null ) ? null : verdicts.includes( true );
}
