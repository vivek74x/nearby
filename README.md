# Nearby

Chat, send files, and make voice or video calls with anyone on the same Wi-Fi. No accounts, no internet needed once installed.

## Run

1. Install Node.js 18 or newer on one computer (the "host").
2. In this folder run:
   ```
   npm install
   npm start
   ```
3. The terminal prints addresses like `https://192.168.1.20:3000`. Open one on every device on the same Wi-Fi.
4. Each device shows a certificate warning the first time (the certificate is self-signed). Choose Advanced, then continue. On iPhone: Show Details, then visit this website.
5. Pick a name and start talking.

## Notes

- Calls need `https://`. Browsers block the microphone and camera on plain `http://`, which is why the server uses a self-signed certificate.
- Calls are peer to peer (WebRTC), so audio and video go directly between the two devices.
- Files upload to the host computer (`uploads/`) and are deleted when the server restarts. Limit: 2 GB per file.
- If devices can't connect, allow Node.js through the host's firewall for port 3000 (change with `PORT=4000 npm start`).
- Some routers have "client isolation" or "AP isolation" turned on, or a guest network, which blocks devices from seeing each other. Turn it off or use the main network.
- Anyone on the network who opens the address can join, so use it on networks you trust.
