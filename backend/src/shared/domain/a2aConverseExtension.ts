/**
 * The URI that names the Radioso converse extension to A2A. One string, three jobs: the Agent
 * Card lists it under `capabilities.extensions`, a client activates it with it in the
 * `A2A-Extensions` request header, and it is the key under which the extension's metadata
 * travels on messages, task status, and artifacts. It is versioned in the path, so a change
 * to the extension's contract is a new URI rather than a silent one, and it resolves to the
 * extension's reference page on the docs portal.
 */
export const A2A_CONVERSE_EXTENSION_URI = "https://docs.radioso.ai/reference/a2a-converse-extension/v1";
