# Vendored React for the standalone panel

The standalone panel host serves the existing dsh-client bundle (`webui/lib/client.js`) without
dsh. That bundle calls `require("react")` and `require("react/jsx-runtime")`, so the host supplies
React from these two UMD builds — they are files in this directory, not npm dependencies.

| File | Package | Version | Tarball SHA-256 |
|---|---|---|---|
| `react.production.min.js` | `react` | 18.3.1 | `8d9bed01a672e7eaf387942d781ad47c6a43089a30a0306060f9fd5ac7870347` |
| `react-dom.production.min.js` | `react-dom` | 18.3.1 | `031d4427a99f2f3f6cac18bbbf308594a67e4f47d10f4896fdec446505b040e0` |

Both tarballs were fetched with `npm pack react@18.3.1` / `npm pack react-dom@18.3.1`; the files are
`package/umd/react.production.min.js` and `package/umd/react-dom.production.min.js` copied verbatim.
`LICENSE.react` and `LICENSE.react-dom` are the packages' `LICENSE` files.

`react-dom` is only needed by the host shell (`ReactDOM.createRoot`); the plugin bundle itself uses
only `react` and `react/jsx-runtime`.

## Upgrading

1. `npm pack react@<version> react-dom@<version>`;
2. replace the two UMD files and both LICENSE files from the tarballs;
3. update the two SHA-256 values in the table above (the install stamp hashes these files, so a
   version change also shows up as stale webui content in `install.sh --check`).
