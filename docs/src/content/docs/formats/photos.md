---
title: Strip GPS and EXIF from photo uploads in Node
sidebar:
  label: Photos and images
description: How JPEG, PNG, WebP, HEIC, HEIF and AVIF uploads are checked and cleaned.
---

| Extension | MIME type |
| - | - |
| `jpg` `jpeg` | `image/jpeg` (also `image/pjpeg`) |
| `png` | `image/png` |
| `webp` | `image/webp` |
| `heic` | `image/heic` |
| `heif` | `image/heif`, `image/heic` |
| `avif` | `image/avif` |
| `gif` | `image/gif` |
| `bmp` | `image/bmp` |
| `ico` | `image/vnd.microsoft.icon` |

Photos are not refused for their metadata. They are cleaned, and `result.bytes` holds the cleaned copy. A photo whose structure cannot be read is refused as `content-mismatch`.

## JPEG, PNG and WebP

EXIF (GPS included), XMP, IPTC, comments and any other metadata segment or chunk are removed. The orientation is kept, so a portrait photo stays upright. Pixel data is copied unchanged.

## HEIC, HEIF and AVIF

These are ISOBMFF files, the format iPhones save by default. The `ftyp` brands must match the extension.

EXIF and XMP items are overwritten in place with zeros instead of removed, since dropping them would shift the byte offsets the file is built on. The orientation lives in the image properties, not in EXIF, and stays.

Image sequences, such as animated AVIF or HEIF bursts, are refused as `content-mismatch`.

## GIF, BMP and ICO

GIF comments, XMP and other application extensions are removed. The animation loop and colour profile stay, and anything after the end of the image is cut off, so a GIF cannot carry a JAR or ZIP behind it.

BMP and ICO hold no metadata worth removing. Their headers are checked. ICO entries must be PNG or BMP images; cursor files (`.cur`) are refused.

## Not checked

Image dimensions. A small file can declare a huge image. Limit width and height in whatever makes thumbnails, as [Serving uploads safely](/guides/serving-uploads/) describes.

To clean a photo without the other checks, call `stripPhotoMetadata( extension, bytes )`. It returns the cleaned bytes, the input unchanged for non-photos, or `null` for a broken photo.
