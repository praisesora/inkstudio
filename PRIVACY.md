# Privacy Policy

Ink Studio is designed to work locally on your device. **Ink Studio does not collect, store, or transmit personal data, usage analytics, telemetry, or artwork contents to the developer or any third-party analytics service.**

## Local Data

All data created or managed by Ink Studio stays on your computer, including:

- Native project files (`.sora`, `.ink`) and exported artwork
- Application settings, custom shortcuts, brush presets, and workspace layouts
- Temporary LZ4-compressed scratch disk files and write-ahead log (WAL) crash recovery data

No user account or registration is required to use Ink Studio.

## Network Access

Ink Studio operates offline by default and only initiates network connections in the following cases:

| Feature | Destination | Purpose | When It Runs |
| --- | --- | --- | --- |
| **Update Check** | `github.com/praisesora/inkstudio` (`releases/latest/download/latest.json`) | Checks for newer releases and downloads signed update packages if you choose to update | Automatic check / manual update |
| **LAN Collaboration** | Local network (`localhost` / LAN IP) | Hosts or joins a local WebSocket drawing session directly between peers | Only when explicitly started by the user |
| **Public Collaboration Tunnel** | `trycloudflare.com` (Cloudflare) | Exposes your local collaboration session via a temporary invite link for remote peers | Only when explicitly enabled by the user |
| **Cloudflare Tunnel Binary Download** | `github.com/cloudflare/cloudflared` | Downloads an official, SHA-256-verified `cloudflared` binary if it is not already installed | Only when explicitly confirmed by the user |

### Third-Party Services

- **GitHub**: Checking for updates or downloading releases and `cloudflared` involves standard HTTP requests to GitHub, subject to the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- **Cloudflare**: If you opt in to public collaboration links, encrypted session traffic is routed through Cloudflare Quick Tunnels (`trycloudflare.com`), subject to the [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/). Ink Studio does not operate any relay servers and never receives your session traffic or drawings.

## Data Sharing & Tracking

- No telemetry or usage tracking
- No advertising or third-party trackers
- No automatic crash-report uploads
- No background data collection

## Changes & Contact

Because Ink Studio is open-source software under the [GNU General Public License v3.0](./LICENSE), all network behavior can be audited directly in the [source repository](https://github.com/praisesora/inkstudio).

If you have questions or privacy concerns, please open an issue on [GitHub Issues](https://github.com/praisesora/inkstudio/issues).
