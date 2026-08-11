import { assertValidKey, buildKey, MAX_KEY_LENGTH } from '../src/keys.js';
import { StorageError } from '../src/errors.js';

/**
 * The traversal cases are the point of this file. Everything else here is
 * scaffolding around them.
 */

describe('assertValidKey', () => {
  const wellFormed = 'organizations/8f3a/invoices/2026/APP/9c21/invoice.pdf';

  it('accepts a well-formed key', () => {
    expect(() => {
      assertValidKey(wellFormed);
    }).not.toThrow();
  });

  it.each([
    ['parent traversal', 'organizations/../../etc/passwd'],
    ['traversal mid-key', 'organizations/8f3a/../../../etc/shadow'],
    ['bare dot segment', 'organizations/./invoice.pdf'],
    ['bare double-dot segment', 'organizations/../invoice.pdf'],
    ['absolute path', '/etc/passwd'],
    ['windows separator', 'organizations\\8f3a\\invoice.pdf'],
    ['drive letter', 'C:/windows/system32/config/sam'],
    ['NUL byte truncation', 'organizations/8f3a/invoice.pdf\u0000.txt'],
    ['newline', 'organizations/8f3a\n/invoice.pdf'],
    ['space', 'organizations/8f3a/my invoice.pdf'],
    ['home expansion', '~/invoice.pdf'],
    ['url scheme', 'file:///etc/passwd'],
    ['empty', ''],
  ])('refuses %s', (_label, key) => {
    expect(() => {
      assertValidKey(key);
    }).toThrow(StorageError);
    try {
      assertValidKey(key);
    } catch (error) {
      expect((error as StorageError).code).toBe('INVALID_KEY');
    }
  });

  it('refuses a key longer than the storage_key column', () => {
    const key = 'a/'.repeat(MAX_KEY_LENGTH);
    expect(() => {
      assertValidKey(key);
    }).toThrow(/exceeds/);
  });

  it('does not leak the key into the message, only into the detail', () => {
    try {
      assertValidKey('organizations/../../etc/passwd');
      throw new Error('should have thrown');
    } catch (error) {
      const storageError = error as StorageError;
      expect(storageError.message).not.toContain('etc/passwd');
      expect(storageError.detail).toContain('..');
    }
  });
});

describe('buildKey', () => {
  it('joins parts with slashes and drops empties', () => {
    expect(buildKey('organizations', '8f3a', '', 'invoices', 'invoice.pdf')).toBe(
      'organizations/8f3a/invoices/invoice.pdf'
    );
  });

  it('flattens a part that already contains slashes', () => {
    expect(buildKey('organizations/8f3a', 'invoice.pdf')).toBe('organizations/8f3a/invoice.pdf');
  });

  /**
   * The case this function exists for: an id that is not what the call site
   * assumed it was. A template literal would have produced a working key.
   */
  it('refuses a traversal sequence smuggled in through a part', () => {
    expect(() => buildKey('organizations', '../../etc', 'passwd')).toThrow(StorageError);
  });
});
