# CrimsonCut: installable video editor (PWA)

Plain HTML/CSS/JS. No build step, no dependencies, works offline once installed.

## Run locally
    cd crimsoncut
    python3 -m http.server 8000     # then open http://localhost:8000

## Put it on your phone
PWAs need HTTPS. Upload this folder to any static host (Cloudflare Pages, Netlify,
GitHub Pages, Firebase Hosting). Open the URL in Chrome on Android, then
menu → "Install app" (or tap the install icon in the app header).

## Turn on the AdSense full-screen ad
1. Get your site approved in AdSense (the host domain must be added there).
2. Create a Display ad unit and copy your publisher ID and slot ID.
3. Edit `config.js` with both values.
4. Put your real publisher ID in `ads.txt` and host it at the domain root.
5. Optional: in AdSense → Ads → Auto ads, enable "Vignettes" for Google's own interstitials.

Until step 3 is done the ad screen shows a labelled placeholder. If the device is
offline or no ad fills, the screen closes itself so users are never stuck.
Never tap your own live ads; AdSense can suspend accounts for it.

## How export works
- Video formats are recorded in real time through the browser's MediaRecorder, so
  an export takes about as long as the edited video. Keep the screen on.
- Available formats depend on the phone's Chrome version (MP4, MKV, WebM, M4A, WAV
  are offered when supported).
- WAV export is rendered offline and is fast.

## Files
index.html · styles.css · app.js · ads.js · config.js · sw.js · manifest.webmanifest · ads.txt · icons/
