import { loadCore } from "../packages/core/src/edits.ts";

// The browser's edits run in the C++ project core (WebAssembly); the apps
// load it at start-up, and so does every test file.
await loadCore();
