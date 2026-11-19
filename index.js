import { run } from "./src/main.js";

run().catch((e) => {
  console.log(`::error::${e.message}`);
  process.exitCode = 1;
});
