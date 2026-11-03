# Third-party components

## cbor-x 1.6.4

Source: https://github.com/kriszyp/cbor-x

Official npm package: https://registry.npmjs.org/cbor-x/-/cbor-x-1.6.4.tgz

SHA-512 (base64): `UGKHjp6RHC6QuZ2yy5LCKm7MojM4716DwoSaqwQpaH4DvZvbBTGcoDNTiG9Y2lByXZYFEs9WRkS5tLl96IrF1Q==`

The `dist/index-no-eval.cjs` distribution is included with a small ES module export wrapper in `vendor/cbor-x-1.6.4.mjs`. The MIT license is in `vendor/cbor-x-LICENSE`. No remotely hosted code is executed by the extension.

## Kio protocol reference

The request fields and share-ID representation were checked against the public kiodl implementation at https://github.com/myparsleycat/kiodl (client.ts, stream.ts, share-url.ts). This extension implements only the required bounded download flow, without running the kiodl application. Kio does not document a stable public API; protocol or delivery-host changes may require an extension update. Authentication failures or browser challenges stop the request; the extension does not bypass them.
