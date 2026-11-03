---
title: Strip GPS and tags from audio and video uploads
description: How MP3, WAV, FLAC, Ogg, M4A, MP4, MOV and WebM uploads are checked and cleaned.
sidebar:
  label: Audio and video
---

| Extension | MIME type |
| - | - |
| `mp3` | `audio/mpeg` |
| `wav` | `audio/wav` |
| `flac` | `audio/flac` |
| `ogg` | `audio/ogg` |
| `m4a` | `audio/mp4` |
| `mp4` | `video/mp4` |
| `mov` | `video/quicktime` |
| `webm` | `video/webm` |

All of them are of `low` risk and in the default list. Their structure is read, their metadata removed, and `result.bytes` holds the cleaned copy. A file whose structure does not read is refused as `content-mismatch`.

## Video

iPhones store the place a video was taken in the `moov/meta` box (`com.apple.quicktime.location.ISO6709`) and in `moov/udta`. upload-safety turns every `udta`, `meta`, `uuid` and `XMP_` box into a `free` box and zeroes its content. The file keeps its length, so no sample offset moves and nothing is re-encoded.

The `ftyp` brands must match the extension. Old QuickTime movies without `ftyp` pass when their boxes read.

In WebM, the Tags and Attachments elements and the title become Void elements of the same length.

## Audio

| Format | Removed | Checked |
| - | - | - |
| MP3 | ID3v2 at the start, ID3v1, APE and Lyrics3 tags at the end | The first two frame headers |
| WAV | Every chunk except `fmt `, `fact` and `data` | Chunk sizes |
| FLAC | Vorbis comments, pictures, application and padding blocks | Metadata blocks and the first frame |
| Ogg | Nothing | Every page and its CRC |
| M4A | As for video | Box structure and brands |

## Limits

- GPS that a camera records per frame in a metadata track, such as GoPro and DJI telemetry, lives with the video data and stays.
- Ogg and Opus comments stay, as they sit in packets that span pages.
- Codec data is not decoded.
- `checkUpload` takes the whole file in memory. Cap `maxBytes`, and the request body before it, at what your server can hold.
