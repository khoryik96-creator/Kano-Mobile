// Real native adapter implementations of the platform ports. Each imports a React
// Native native module, so this directory is EXCLUDED from the Node test build
// (tsconfig.json) and only compiled by Expo/Metro on device (tsconfig.app.json). The
// port contracts they satisfy are tested in Node via the in-memory fakes.

export { KeychainSecureStore } from './secureStoreKeychain';
export { AsyncStorageNoteStore } from './noteStoreAsyncStorage';
export { xhrStreamTransport } from './aiStreamXhr';
export { pickOwlImages, keepOwlImage, discardOwlImage, readOwlImage, pruneOwlImages, owlImageUri, OWL_IMAGE_MAX_EDGE } from './owlImages';
export type { PendingOwlImage, OwlImageSource } from './owlImages';
