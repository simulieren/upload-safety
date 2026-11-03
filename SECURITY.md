# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the [Security tab](https://github.com/simulieren/upload-safety/security) and choose **Report a vulnerability**. Please do not open a public issue.

Useful reports name the check that was bypassed, include a file or a script that builds one, and say which version you tested.

You should hear back within a week. Once a fix is released, the advisory is published with credit, unless you ask not to be named.

## In scope

- A file with active content (macros, embedded objects, DDE, PDF scripts or attachments, event listeners) that passes `checkUpload` or `inspectFileContent`.
- A file whose bytes are of another type than its extension that passes.
- Metadata that survives `stripPhotoMetadata`.
- Input that makes a check crash, hang or use far more memory than the file's size suggests.

## Out of scope

The limitations listed in the README, such as DDE in legacy `.doc` files and documents nested inside other documents. These checks are not an antivirus scan and do not judge whether the data in an otherwise plain file is malicious.

## Supported versions

Only the latest release gets fixes.
