// The email designer's document model + its MJML serializer. Isomorphic (no DOM,
// no Node APIs) so the SPA designer AND the server share one implementation: the
// server re-serializes a template when a linked component it uses changes.
export * from './model.js';
export * from './mjml-serializer.js';
export * from './components.js';
