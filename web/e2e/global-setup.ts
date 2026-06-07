// Playwright globalSetup — seed the real Postgres once before the browser specs.
import { seed } from './seed.js';

export default async function globalSetup(): Promise<void> {
  await seed();
}
