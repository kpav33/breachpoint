BREACHPOINT — favicons & social images
======================================

WHERE THINGS GO (Vite)
----------------------
Copy everything in this folder EXCEPT this README and head-snippet.html
into your project's /public folder:

  public/
    favicon.ico
    icon.svg
    favicon-16.png
    favicon-32.png
    favicon-48.png
    apple-touch-icon.png        (180x180)
    favicon-192.png
    favicon-512.png
    maskable-192.png
    maskable-512.png
    og-image.png                (1200x630)
    twitter-image.png           (1200x630)
    site.webmanifest

Vite serves /public at the site root, so all the "/favicon.ico" style
paths in the head snippet resolve correctly with no config changes.

THEN
----
1. Paste the contents of head-snippet.html into the <head> of index.html.
2. Replace https://YOUR-DOMAIN/ with your real deployed URL in the four
   og:/twitter: absolute URLs (social scrapers require absolute URLs for images).
3. Deploy. Test the share preview at:
     - https://www.opengraph.xyz/
     - https://cards-dev.twitter.com/validator  (or just paste in Discord)

NOTES
-----
- icon.svg is the crisp vector source; modern browsers prefer it.
- favicon.ico bundles 16/32/48 for legacy tabs and Windows.
- maskable-*.png are the safe-area versions Android uses for adaptive icons.
- theme-color tints the mobile browser chrome to match the game's void.
