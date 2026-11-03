import { describe, expect, it } from 'vitest';

import { stripXmlMarkup } from './xml-markup.js';

describe( 'stripXmlMarkup', () => {
	it( 'drops a leading declaration, comments and processing instructions and escapes CDATA', () => {
		expect( stripXmlMarkup( '<?xml version="1.0"?>\n<a><!-- x --><b c="1>2"/><![CDATA[<d>&]]><?pi x?></a>' ) ).toBe( '\n<a><b c="1>2"/>&lt;d&gt;&amp;</a>' );
	} );

	it( 'refuses a declaration after other content, markup left open and `<` in a quoted value', () => {
		expect( stripXmlMarkup( '<a/><?xml version="1.0"?>' ) ).toBeNull();
		expect( stripXmlMarkup( '<a><![CDATA[ </a>' ) ).toBeNull();
		expect( stripXmlMarkup( '<a b="' ) ).toBeNull();
		expect( stripXmlMarkup( '<a b="<c/>"/>' ) ).toBeNull();
		expect( stripXmlMarkup( '<a' ) ).toBeNull();
		expect( stripXmlMarkup( '<!ENTITY a "b"><a/>' ) ).toBeNull();
	} );

	it( 'stays linear on crafted input', () => {
		const started = performance.now();
		stripXmlMarkup( '<!--'.repeat( 500_000 ) );
		stripXmlMarkup( `<a${ ' b="x"'.repeat( 200_000 ) }` );
		stripXmlMarkup( '<?a?>'.repeat( 200_000 ) );
		expect( performance.now() - started ).toBeLessThan( 500 );
	} );
} );
