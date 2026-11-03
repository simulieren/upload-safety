import { stripPhotoMetadata } from './photo-metadata.js';
import {
	getCanonicalMimeType,
	inspectFileContent,
	validateUploadDescriptor,
	type AllowedExtension,
	type DescriptorRejection,
	type UploadOptions,
} from './upload-allowlist.js';

export type UploadRejection = DescriptorRejection | 'macros' | 'encrypted' | 'content-mismatch';

export interface UploadInput {
	filename: string;
	/** The MIME type the client declared; empty when it sent none. */
	mimeType: string;
	bytes: Uint8Array;
}

export type UploadCheck =
	| {
		ok: true;
		extension: AllowedExtension;
		filename: string;
		/** The canonical MIME type for the extension, not the declared one. */
		mimeType: string;
		/** The bytes to store; photos come without their metadata. */
		bytes: Uint8Array;
	}
	| { ok: false; reason: UploadRejection };

/** Runs every check on an upload and returns what is safe to store. */
export function checkUpload( { filename, mimeType, bytes }: UploadInput, options: UploadOptions ): UploadCheck {
	const descriptor = validateUploadDescriptor( { filename, mimeType, size: bytes.byteLength }, options );
	if ( ! descriptor.ok ) {
		return descriptor;
	}
	const { extension, sanitizedFilename } = descriptor;
	const verdict = inspectFileContent( extension, bytes );
	if ( verdict === 'macros' || verdict === 'encrypted' ) {
		return { ok: false, reason: verdict };
	}
	const stored = verdict === 'valid' ? stripPhotoMetadata( extension, bytes ) : null;
	if ( ! stored ) {
		return { ok: false, reason: 'content-mismatch' };
	}
	return {
		ok: true, extension, filename: sanitizedFilename, mimeType: getCanonicalMimeType( extension ), bytes: stored,
	};
}
