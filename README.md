# Nearby Lite

Chat and send files to anyone on the same Wi-Fi. No install step, no dependencies.

## Run
1. Install Node.js 18+.
2. In this folder: `node server.js`
3. Open the printed address (like `http://192.168.1.20:3000`) on every device on the same Wi-Fi.

## Voice and video calls (optional)
Browsers only allow the mic and camera on https. Make a certificate once (replace the IP with your computer's address):

    openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 825 -subj "/CN=nearby" -addext "subjectAltName=IP:192.168.1.20"

Put `key.pem` and `cert.pem` next to `server.js` and restart. The server switches to https automatically; accept the one-time warning on each device. (On Windows, run the command in Git Bash.)

## Put it online
Push to GitHub and deploy on Render/Railway as a Node web service: Build command: (empty), Start command: `node server.js`. The host supplies https, so calls work without a certificate. Files and history reset on restart, and anyone with the link can join.
