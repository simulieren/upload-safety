/**
 * Reduces an XML part to its elements and text before pattern matching: drops
 * comments, CDATA sections and processing instructions, whose content could
 * otherwise open a quote or a tag that hides a real element.
 */

const SKIPPED_MARKUP = [
	{ start: '<!--', end: '-->' },
	{ start: '<![CDATA[', end: ']]>' },
	{ start: '<?', end: '?>' },
] as const;
const XML_DECLARATION = /^<\?xml[\s?]/i;

/**
 * The part without comments, CDATA sections and processing instructions, or null when
 * one is unterminated, a `<!DOCTYPE` or other `<!` remains, a quoted value holds `<`,
 * a tag is unterminated, an XML declaration is not first, or the text holds NUL.
 */
export function stripXmlMarkup( text: string ): string | null {
	if ( text.includes( '\0' ) ) {
		return null;
	}
	const kept: string[] = [];
	let keptFrom = 0;
	let position = 0;
	while ( position < text.length ) {
		const open = text.indexOf( '<', position );
		if ( open < 0 ) {
			break;
		}
		const markup = SKIPPED_MARKUP.find( ( { start } ) => text.startsWith( start, open ) );
		if ( markup ) {
			const close = text.indexOf( markup.end, open + markup.start.length );
			// Only the very first thing may be the declaration, as XML requires.
			const misplacedDeclaration = markup.start === '<?' && XML_DECLARATION.test( text.slice( open, open + 6 ) ) &&
				text.slice( 0, open ).trim() !== '';
			if ( close < 0 || misplacedDeclaration ) {
				return null;
			}
			kept.push( text.slice( keptFrom, open ) );
			position = keptFrom = close + markup.end.length;
			continue;
		}
		if ( text[ open + 1 ] === '!' ) {
			return null;
		}
		const end = findTagEnd( text, open + 1 );
		if ( end < 0 ) {
			return null;
		}
		position = end + 1;
	}
	kept.push( text.slice( keptFrom ) );
	return kept.join( '' );
}

/** The index of the `>` that ends a tag, skipping quoted values; -1 when none does or a value holds `<`. */
function findTagEnd( text: string, from: number ): number {
	let position = from;
	while ( position < text.length ) {
		const character = text[ position ];
		if ( character === '>' ) {
			return position;
		}
		if ( character === '<' ) {
			return -1;
		}
		if ( character === '"' || character === "'" ) {
			const close = text.indexOf( character, position + 1 );
			if ( close < 0 || text.slice( position + 1, close ).includes( '<' ) ) {
				return -1;
			}
			position = close;
		}
		position++;
	}
	return -1;
}
