---
'@opfs-vfs/file-preview': patch
'@opfs-vfs/devtools': patch
---

SVG previews load from a `data:` URL instead of a same-origin `blob:` URL, so opening a previewed SVG in a new tab can no longer run its scripts on your origin. Images larger than 50 megapixels show a message instead of being decoded.
