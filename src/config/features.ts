const env = import.meta.env as { VITE_FEATURE_SEED_TEST_ITEMS?: string };
const seedFlag = env.VITE_FEATURE_SEED_TEST_ITEMS;
const seedFlagEnabled = seedFlag === 'true' || seedFlag === '1';

export const FEATURES = {
  seedTestItems: seedFlagEnabled,
} as const;
