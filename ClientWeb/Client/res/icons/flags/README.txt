Country flag SVGs (4:3) for the player "flag" profile attribute.

Source: flag-icons (https://github.com/lipis/flag-icons), MIT licensed.
See LICENSE.txt in this directory for the full licence text.

One file per ISO 3166-1 alpha-2 code, lowercase, matching the catalog in
Common/core/text/CoreCountry.h. There is deliberately no file for the default
"Global / Anonymous" option (Core::COUNTRY_GLOBAL) — it renders no flag at all.

Why SVGs and not flag emoji: Windows has no regional-indicator glyphs in Segoe
UI Emoji, so a flag emoji falls back to boxed letters ("US") on the primary
desktop platform and in Chrome on Windows for the web client. Bundled SVGs
render identically everywhere.

To update the set, re-fetch flag-icons and copy flags/4x3/<cc>.svg for exactly
the codes in the catalog, then refresh the <file> entries in Client/qml.qrc.
