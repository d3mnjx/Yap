Twemoji artwork v17.0.3, https://github.com/jdecked/twemoji/tree/v17.0.3/assets/svg
Artwork: CC-BY 4.0; see LICENSE-GRAPHICS. No runtime JavaScript dependency.

artwork.json maps each original SVG filename stem to its unmodified SVG text.
It is packed as one public, compressed, service-worker-cached file so offline emoji
rendering needs neither a CDN nor thousands of individual installation requests.
To regenerate, fetch the v17.0.3 source archive and serialize assets/svg/*.svg into
this filename-to-text map. Preserve the upstream licenses and version attribution.
