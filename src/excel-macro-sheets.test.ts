import { describe, expect, it } from 'vitest';

import { inspectExcelGlobals } from './excel-macro-sheets.js';
import { buildWorkbook, SHEET_TYPE } from './ole-fixture.js';

const record = ( type: number, size: number, body = Buffer.alloc( size ) ) => {
	const header = Buffer.alloc( 4 );
	header.writeUInt16LE( type, 0 );
	header.writeUInt16LE( size, 2 );
	return Buffer.concat( [ header, body ] );
};
const macroSheet = buildWorkbook( [ { type: SHEET_TYPE.macro } ] ).subarray( 20 );

describe( 'inspectExcelGlobals', () => {
	it( 'reports encryption at FILEPASS, after which the sheet type is encrypted, and stops at the globals EOF', () => {
		expect( inspectExcelGlobals( Buffer.concat( [ record( 0x002f, 6 ), macroSheet ] ) ) ).toBe( 'encrypted' );
		expect( inspectExcelGlobals( Buffer.concat( [ record( 0x000a, 0 ), macroSheet ] ) ) ).toBe( 'valid' );
		expect( inspectExcelGlobals( macroSheet ) ).toBe( 'macros' );
	} );

	it( 'ends at a record that overruns the stream or a sheet record too short for its type', () => {
		expect( inspectExcelGlobals( record( 0x0085, 5, Buffer.from( [ 0, 0, 0, 0, 0 ] ) ) ) ).toBe( 'valid' );
		expect( inspectExcelGlobals( Buffer.concat( [ record( 0x00fc, 100 ).subarray( 0, 50 ), macroSheet ] ) ) ).toBe( 'valid' );
	} );

	it( 'walks a 16 MB stream of empty records quickly', () => {
		const stream = Buffer.concat( [ Buffer.alloc( 16 * 1024 * 1024 ), macroSheet ] );
		const started = performance.now();
		expect( inspectExcelGlobals( stream ) ).toBe( 'macros' );
		expect( performance.now() - started ).toBeLessThan( 500 );
	} );
} );
