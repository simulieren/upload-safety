// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const repository = 'https://github.com/simulieren/upload-safety';
const site = 'https://upload-safety.simonhalimonov.com';

export default defineConfig( {
	site,
	integrations: [
		starlight( {
			title: 'upload-safety',
			description: 'Server-side upload checks for Node: refuse macros, embedded objects, DDE, PDF scripts and CSV formulas, strip photo metadata. Zero dependencies.',
			logo: { src: './src/assets/logo.svg' },
			favicon: '/favicon.svg',
			head: [
				{ tag: 'meta', attrs: { property: 'og:image', content: `${ site }/og.png` } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: `${ site }/og.png` } },
			],
			social: [
				{ icon: 'github', label: 'GitHub', href: repository },
				{ icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/upload-safety' },
			],
			editLink: { baseUrl: `${ repository }/edit/main/docs/` },
			lastUpdated: true,
			customCss: [ './src/styles/custom.css' ],
			sidebar: [
				{
					label: 'Start here',
					items: [ 'getting-started', 'what-it-catches' ],
				},
				{
					label: 'Guides',
					items: [ 'guides/web-request', 'guides/express', 'guides/file-picker', 'guides/serving-uploads' ],
				},
				{
					label: 'Formats',
					items: [ 'formats/pdf', 'formats/office', 'formats/opendocument', 'formats/photos', 'formats/csv-and-text' ],
				},
				{
					label: 'Reference',
					items: [ 'reference/api', 'reference/rejections', 'reference/limits' ],
				},
				'security',
			],
		} ),
	],
} );
