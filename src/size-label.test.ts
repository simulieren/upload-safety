import { expect, it } from 'vitest';

import { sizeLabel } from './size-label.js';

it( 'labels a byte count in kilobytes with one decimal', () => {
	expect( sizeLabel( 1536 ) ).toBe( '1.5 KB' );
	expect( sizeLabel( 0 ) ).toBe( '0.0 KB' );
} );
