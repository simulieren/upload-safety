---
title: File picker
description: Match the browser file dialog to the types the server accepts.
---

`acceptAttribute()` returns the value for an `<input type="file">` `accept` attribute, built from the same list the server checks against:

```tsx
import { acceptAttribute } from 'upload-safety';

<input type="file" name="file" accept={ acceptAttribute( [ 'pdf', 'docx' ] ) } />
```

Without an argument it lists every supported extension.

:::note
`accept` only filters the dialog. Users can switch it to "All files", and scripts can post anything. The server check is the one that counts.
:::

The package entry imports `node:zlib` and `node:crypto`. If your bundler refuses those in client code, call `acceptAttribute()` on the server and pass the string down, or copy the value into a constant.
