# nebula.zhoulab.io

The Nebula Notebook introduction site — one self-contained `index.html` (no build
step, no dependencies; fonts come from Google Fonts, everything else is inline).

## Deploying with GitHub Pages

`CNAME` already carries `nebula.zhoulab.io`. In the repository's
**Settings → Pages**, set the source to this branch and the `/site` folder, then
point a DNS `CNAME` record for `nebula` at `jzhoulab.github.io`.

Anything that serves static files works equally well — the page has no server
requirements.

## Editing

Copy is in the HTML, in reading order; the palette and type scale are CSS custom
properties in one `:root` block, and each band sets its own ground via
`.band` / `.band--paper`. Keep the version in the hero kicker in step with
`package.json`.
