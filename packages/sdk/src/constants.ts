/** The Varis API. The only place the hostname appears in the SDK. */
export const VARIS_API_ORIGIN = "https://api.usevaris.com";

/** Where the gateway publishes the public keys it signs requests with. */
export const VARIS_SIGNING_KEYS_URL =
  `${VARIS_API_ORIGIN}/.well-known/varis-signing-keys`;

/*
 * `varis test` requests. The CLI signs each with a throwaway key and serves
 * that key's public half on the developer's own loopback, only for the
 * request ID it just sent. verifyRequest fetches it from here. In
 * production nothing listens on this address, so a test request can never
 * verify there. These three values must match the CLI's
 * (src/lib/test-signing.ts in varis-cli).
 */

/** The key ID on every `varis test` request. */
export const TEST_KEY_ID = "varis-test";

/** Every `varis test` request ID starts with this; gateway IDs never do. */
export const TEST_REQUEST_ID_PREFIX = "var_tst_req_";

/** Where the CLI serves a test run's public key. One fixed address only. */
export const LOCAL_TEST_KEY_URL = "http://127.0.0.1:47823/varis-test-key";
