import { z } from 'zod';

// The V1 tool helper's runtime contract is only an identity function plus Zod.
// Keep the same Zod version and returned definition. Importing the whole legacy
// SDK solely for this helper brought its unused vulnerable Effect/TOML chain.
export const tool = Object.assign(definition => definition, { schema: z });
