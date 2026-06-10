/**
 * Secure storage for sensitive data (API keys) via OS keychain.
 * Windows: Credential Manager
 * macOS: Keychain
 * Linux: libsecret
 */
import keytar from 'keytar';

const SERVICE = 'CodeDert';

export const keystore = {
  async get(account: string): Promise<string | null> {
    try {
      return await keytar.getPassword(SERVICE, account);
    } catch (err) {
      console.error('keystore.get error:', err);
      return null;
    }
  },

  async set(account: string, value: string): Promise<void> {
    await keytar.setPassword(SERVICE, account, value);
  },

  async delete(account: string): Promise<boolean> {
    return keytar.deletePassword(SERVICE, account);
  },
};
