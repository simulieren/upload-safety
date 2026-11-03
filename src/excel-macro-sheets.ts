/**
 * Finds Excel 4.0 macro sheets and VBA modules in the globals of a BIFF5/BIFF8
 * Workbook stream, which list every sheet in a BoundSheet8 record [MS-XLS 2.4.28],
 * DDE and OLE links, which a SupBook record introduces [MS-XLS 2.4.271], and
 * encryption, which a FILEPASS record announces [MS-XLS 2.4.117].
 */

const RECORD_HEADER_SIZE = 4;
const BOUND_SHEET = 0x0085;
const END_OF_FILE = 0x000a;
// Everything after FILEPASS is encrypted, the sheet type included.
const FILE_PASS = 0x002f;
/** BoundSheet8 `dt` after lbPlyPos (4 bytes) and hsState (1 byte): 1 macro sheet, 6 VBA module. */
const SHEET_TYPE_OFFSET = 5;
const MACRO_SHEET_TYPES = [ 1, 6 ];
// A SupBook names the source of external references. One of a DDE link (a formula such as
// `=cmd|'/c calc'!A1`) or an OLE link lists no sheets, unlike an external workbook, and carries no
// marker of the workbook itself or of add-in functions in place of the length of its path.
const SUP_BOOK = 0x01ae;
const SUP_BOOK_SIZE = 4;
const SELF_REFERENCE = 0x0401;
const ADD_IN_REFERENCE = 0x3a01;

/**
 * Whether the globals list a macro sheet or a DDE or OLE link, or encrypt the rest. The walk ends
 * at their EOF, at FILEPASS or at a record that overruns the stream, which Excel could not read either.
 */
export function inspectExcelGlobals( workbook: Buffer ): 'macros' | 'encrypted' | 'valid' {
	let offset = 0;
	while ( offset + RECORD_HEADER_SIZE <= workbook.length ) {
		const type = workbook.readUInt16LE( offset );
		const size = workbook.readUInt16LE( offset + 2 );
		const body = offset + RECORD_HEADER_SIZE;
		if ( type === FILE_PASS ) {
			return 'encrypted';
		}
		if ( type === END_OF_FILE ) {
			return 'valid';
		}
		if ( type === BOUND_SHEET && size > SHEET_TYPE_OFFSET && body + SHEET_TYPE_OFFSET < workbook.length &&
			MACRO_SHEET_TYPES.includes( workbook[ body + SHEET_TYPE_OFFSET ] ) ) {
			return 'macros';
		}
		if ( type === SUP_BOOK && size >= SUP_BOOK_SIZE && body + SUP_BOOK_SIZE <= workbook.length &&
			workbook.readUInt16LE( body ) === 0 &&
			! [ SELF_REFERENCE, ADD_IN_REFERENCE ].includes( workbook.readUInt16LE( body + 2 ) ) ) {
			return 'macros';
		}
		offset = body + size;
	}
	return 'valid';
}
