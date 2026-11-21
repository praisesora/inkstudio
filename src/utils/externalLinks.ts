import { isTauriEnvironment } from '../hooks/useMultiplayer';

export const DISCORD_INVITE_URL = 'https://discord.gg/37dYhgBePe';
export const GITHUB_REPO_URL = 'https://github.com/praisesora/inkstudio';
export const GITHUB_ISSUES_URL = 'https://github.com/praisesora/inkstudio/issues';
export const GITHUB_LICENSE_URL = 'https://github.com/praisesora/inkstudio/blob/main/LICENSE';

/**
 * Safely opens an external http/https URL in the user's default browser
 * via Tauri's opener plugin when running as a desktop app, or window.open on web.
 */
export async function openExternalUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return;
  }

  const href = parsed.toString();
  if (isTauriEnvironment()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(href);
      return;
    } catch {
      // Fall back to window.open below
    }
  }

  window.open(href, '_blank', 'noopener,noreferrer');
}
