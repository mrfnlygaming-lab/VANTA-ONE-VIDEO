# Download VANTA Motion Studio

1. Download **VANTA-MOTION-STUDIO.zip** in this folder using **Download raw file**.
2. Extract the ZIP and open **VANTA-OPEN.html** in Chrome or Edge.
3. Set generation mode to **Camera sequence · pan and zoom**.
4. Add one to six photos, a camera prompt, and select **Generate video**.
5. Keep the tab visible. Download the result or append a scene from the extension
   popup. Extensions can repeat up to 60 seconds total.

This is the **offline camera app**, with 1080p pan/zoom exports. It needs no
server or key, but cannot create AI subject movement. Browser recording prefers
MP4/H.264, with WebM fallback. Download videos before clearing browser storage.

**For AI subject movement:** run the [server version](../web/README.md) with an
xAI API key. AI scene combines one to three references in one scene and sends
the full prompt to Grok. It uses xAI credits and exports a clearly labeled
720p-to-1080p upscale. The key belongs in secure server settings, never this HTML.
Live paid generation has not been verified without the missing key.

Rebuild in `web` using `npm run build` and
`python3 scripts/package-standalone.py`. Copy the HTML, ZIP, and OPEN-ME.txt here
together. The cloud environment's publication does not host the web app.
