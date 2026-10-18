# PDF.js 6.4.299

Vendored from the npm `pdfjs-dist@6.4.299` tarball, published by Mozilla.
Upstream: https://github.com/mozilla/pdf.js
License: Apache-2.0 (`LICENSE`); bundled CMaps and fonts retain their own licenses.

Tarball integrity:
`sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`

The legacy minified ES modules are stored under `build/`; their bundled core-js
3.50.0 compatibility code retains its MIT license in `LICENSE_CORE_JS`. This
keeps PDF parsing compatible with older supported Chrome versions. CMaps and
standard fonts are also bundled. No CDN,
remote scripts, evaluation, JavaScript actions, external resources or WebAssembly
are used by the product attachment reader. The extension supplies `isEvalSupported:
false`, `useWasm: false`, `enableXfa: false` and local worker/font/CMap URLs.
The reader supplies a directly constructed local module worker, avoiding the
blob wrapper that PDF.js otherwise creates for opaque chrome-extension origins.
PDF pages requiring JBIG2/JPEG 2000 decoding are reported as unsupported for
visual extraction instead of silently producing a blank image.

To update, download a pinned release, verify npm integrity, replace the files,
preserve upstream licenses, and run the product files browser tests.
