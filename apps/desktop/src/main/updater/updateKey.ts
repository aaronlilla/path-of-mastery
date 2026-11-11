/**
 * Update trust anchors baked into every build (they are source constants, so they end up in dist/).
 * Shipped installers use ONLY these; the POM_UPDATE_* env overrides work in unpackaged dev runs (see config.ts).
 *
 * The private half is kept outside the repo and signs
 * the manifest at release time. Rotating the key means changing this constant and shipping a new installer.
 */
/** base64 SPKI DER ed25519 public key the manifest's layer signatures are checked against. */
export const BAKED_UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAWUp24GIfISYZ9Btom3O9dk+8yZMsZ0dHq42tXWWIu3o=';
