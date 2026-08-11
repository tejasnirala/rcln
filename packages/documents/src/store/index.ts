/**
 * `@rcln/documents/store` — how a document is kept.
 *
 * Prisma and the filesystem live behind this entry point and not behind the
 * package root, so `apps/web` can render a document without linking a database
 * client. See the root's header.
 */

export {
  storeDocument,
  readDocument,
  getDocument,
  getDocumentUrl,
  DocumentError,
  type DocumentStatus,
  type DocumentType,
  type StoreDocumentInput,
  type StoredDocument,
} from './document.service.js';

export {
  configureDocumentStore,
  getStorageProvider,
  resetDocumentStoreForTesting,
  type DocumentStoreConfig,
  type DocumentStoreLogger,
} from './runtime.js';
