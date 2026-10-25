import { z } from 'zod';

// The V1 tool helper's runtime contract is only an identity function plus Zod.
// Keep the Zod 4 API and returned definition, with a patched pin. Importing the legacy
// SDK solely for this helper brought its unused vulnerable Effect/TOML chain.
export const tool = Object.assign(definition => definition, { schema: z });
