# Watermark fonts

Font files (`.ttf` / `.otf`) placed in this folder are copied into the API image
(`/usr/share/fonts/truetype/ag-go/`) and become available to the watermark renderer.

To offer a new font in the watermark settings:

1. Add the font files here (all the weights you need, e.g. `BeVietnamPro-Regular.ttf`,
   `BeVietnamPro-Bold.ttf`). Check the license allows embedding/redistribution.
2. Add an entry to `ag-go-web/src/modules/render/utils/watermark-fonts.ts`, using the family name
   reported by `fc-list : family` inside the container. Set `google` when the family is on
   Google Fonts so the settings preview can load it in the browser.
3. Rebuild the API image.

The settings form also accepts a family name typed by hand; it renders correctly only if the font
is installed on the server.
