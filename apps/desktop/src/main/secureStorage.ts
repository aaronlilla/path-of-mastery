import { safeStorage } from 'electron';

/**
 * Thin wrapper around Electron's OS-keychain-backed safeStorage, kept
 * separate so callers depend on this narrow interface rather than the
 * `electron` module directly.
 */
export interface SecureStorage {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(cipherText: Buffer): string;
}

export const electronSecureStorage: SecureStorage = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plainText) => safeStorage.encryptString(plainText),
  decrypt: (cipherText) => safeStorage.decryptString(cipherText),
};
