import { describe, it, expect } from 'vitest';
import { parseInviteUrl } from '../../services/multiplayerService';

describe('Multiplayer Invite URL Parsing', () => {
  it('parses worldwide Cloudflare HTTPS invite links with secure flag and port 443', () => {
    const parsed = parseInviteUrl(
      'https://warm-ink-42.trycloudflare.com/?room=My%20Canvas&token=abc123'
    );
    expect(parsed).toEqual({
      roomName: 'My Canvas',
      host: 'warm-ink-42.trycloudflare.com',
      port: 443,
      url: 'https://warm-ink-42.trycloudflare.com/?room=My%20Canvas&token=abc123',
      token: 'abc123',
      isSecure: true,
    });
  });

  it('parses local LAN HTTP invite links with explicit port', () => {
    const parsed = parseInviteUrl('http://192.168.1.42:30303/?room=LAN%20Room&token=tok999');
    expect(parsed).toEqual({
      roomName: 'LAN Room',
      host: '192.168.1.42',
      port: 30303,
      url: 'http://192.168.1.42:30303/?room=LAN%20Room&token=tok999',
      token: 'tok999',
      isSecure: false,
    });
  });

  it('parses forsora:// deep links and preserves HTTPS protocol flag', () => {
    const parsed = parseInviteUrl(
      'forsora://join?host=cool-cat.trycloudflare.com&port=443&room=Collab&token=xyz&protocol=https'
    );
    expect(parsed).toMatchObject({
      roomName: 'Collab',
      host: 'cool-cat.trycloudflare.com',
      port: 443,
      token: 'xyz',
      isSecure: true,
    });
  });

  it('rejects invalid or non-room URLs', () => {
    expect(parseInviteUrl('')).toBeNull();
    expect(parseInviteUrl('not-a-url')).toBeNull();
    expect(parseInviteUrl('https://example.com/no-room')).toBeNull();
    expect(parseInviteUrl('javascript:alert(1)')).toBeNull();
  });
});
