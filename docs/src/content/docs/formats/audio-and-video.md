---
title: Strip GPS and tags from audio and video uploads
description: How MP3, AAC, WAV, FLAC, Ogg, M4A, WMA, MP4, MOV, WebM, MKV, AVI and WMV uploads are checked and cleaned.
sidebar:
  label: Audio and video
---

| Extension | MIME type |
| - | - |
| `mp3` | `audio/mpeg` |
| `aac` | `audio/aac` |
| `wav` | `audio/wav` |
| `flac` | `audio/flac` |
| `ogg` | `audio/ogg` |
| `m4a` | `audio/mp4` |
| `mp4` | `video/mp4` |
| `mov` | `video/quicktime` |
| `webm` | `video/webm` |
| `mkv` | `video/x-matroska` |
| `avi` | `video/x-msvideo` |
| `wma` | `audio/x-ms-wma` |
| `wmv` | `video/x-ms-wmv` |

All but WMA and WMV are of `low` risk and in the default list. Their structure is read, their metadata removed, and `result.bytes` holds the cleaned copy. A file whose structure does not read is refused as `content-mismatch`.

## Video

iPhones store the place a video was taken in the `moov/meta` box (`com.apple.quicktime.location.ISO6709`) and in `moov/udta`. upload-safety turns every `udta`, `meta`, `uuid` and `XMP_` box into a `free` box and zeroes its content. The file keeps its length, so no sample offset moves and nothing is re-encoded.

The `ftyp` brands must match the extension. Old QuickTime movies without `ftyp` pass when their boxes read.

In WebM and MKV, the Tags and Attachments elements and the title become Void elements of the same length. MKV attachments can hold any file, which is one more reason to blank them.

In AVI, the INFO list, XMP, date and vendor chunks (`strd`, which can hold a camera serial) become JUNK chunks of the same size.

## WMA and WMV

These use Microsoft's ASF container. They are of `elevated` risk and accepted only when named in `allowedExtensions`.

| Found | Result |
| - | - |
| A Script Command object, which makes Windows Media Player open URLs | refused, `macros` |
| DRM (content encryption) or a digital signature, which carry license URLs the player opens | refused, `encrypted` |
| Title, author, WM/ tags and pictures | blanked in place |

A `.wma` must hold an audio stream and no video, a `.wmv` a video stream. Nothing may follow the data except the index objects.

## Audio

| Format | Removed | Checked |
| - | - | - |
| MP3 | ID3v2 at the start, ID3v1, APE and Lyrics3 tags at the end | The first two frame headers |
| AAC (ADTS) | As for MP3 | Every frame, which must run to the end |
| WAV | Every chunk except `fmt `, `fact` and `data` | Chunk sizes |
| FLAC | Vorbis comments, pictures, application and padding blocks | Metadata blocks and the first frame |
| Ogg | Nothing | Every page and its CRC |
| M4A | As for video | Box structure and brands |

## Limits

- GPS that a camera records per frame in a metadata track, such as GoPro and DJI telemetry, lives with the video data and stays.
- Ogg and Opus comments stay, as they sit in packets that span pages.
- Codec data is not decoded.
- AAC is read as raw ADTS; AAC inside MP4 is an `m4a`.
- MKV chapter titles and track names stay. So does metadata stored in the media data itself, in AVI and WMV too.
- `checkUpload` takes the whole file in memory. Cap `maxBytes`, and the request body before it, at what your server can hold.
