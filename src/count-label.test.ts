import { expect, it } from 'vitest';

import { countLabel } from './count-label.js';

it( 'labels a file count, singular for one', () => {
	expect( countLabel( 1 ) ).toBe( '1 file' );
	expect( countLabel( 3 ) ).toBe( '3 files' );
	expect( countLabel( 0 ) ).toBe( '0 files' );
} );
