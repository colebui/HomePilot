import { runDemo } from '../src/demo.js';

runDemo().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
