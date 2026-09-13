import { runWorker } from '../lib/server/worker';
// Run once from a scheduler, or continuously in a supervised Node process.
const watch = process.argv.includes('--watch');
do {
  console.log(new Date().toISOString(), await runWorker());
  if (watch) await new Promise((resolve) => setTimeout(resolve, 10000));
} while (watch);
