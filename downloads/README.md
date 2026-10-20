# Download and open VANTA Motion Studio

1. Open **VANTA-MOTION-STUDIO.zip** in this folder and select **Download raw file**.
2. Extract the ZIP on your computer.
3. Open **VANTA-OPEN.html** in a current Chrome or Edge browser.
4. Choose up to six images and arrange their order. Add a prompt such as “pan left.”
5. Select **Generate video** and keep the tab visible while rendering.
6. After generation, use the extension popup to append another scene from new
   images or the final frame, or select **Not now** to play/download the result.
   Extensions preserve the original video and can repeat up to 60 seconds total.

The ZIP contains the complete HTML app and opening instructions. It needs no
server, Node.js installation, hosting account, API key, or network connection to
run. If the HTML opens in an editor, use **Open With → Chrome or Edge**.

This app creates pan-and-zoom camera animation. It does not generate new subject
movement with an AI model. MP4/H.264 is preferred; browsers without MP4 recording
use WebM. Saved history uses browser storage; download videos you want to keep.

The source and build instructions are in [web](../web/README.md).
Rebuild with `npm run build` and package with
`python3 scripts/package-standalone.py` from that directory. Copy the rebuilt
HTML and ZIP here together when refreshing these downloadable files.
