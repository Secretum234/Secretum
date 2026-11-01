#!/usr/bin/env node
// Single source of truth for the program id: the declare_id! in programs/launchpad/src/lib.rs.
//   require('./program-id').PROGRAM_ID         -> current id
//   node devtools/program-id.js <NEW_ID>       -> rewrites lib.rs, app/config.js, certifier/.env.example
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'programs/launchpad/src/lib.rs');
const read = () => fs.readFileSync(LIB, 'utf8').match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/)[1];

module.exports = { PROGRAM_ID: read() };

if (require.main === module) {
  const next = process.argv[2];
  if (!next) { console.log(read()); process.exit(0); }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(next)) { console.error('Not a valid base58 address'); process.exit(1); }
  const old = read();
  for (const rel of ['programs/launchpad/src/lib.rs', 'app/config.js', 'certifier/.env.example']) {
    const f = path.join(ROOT, rel);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split(old).join(next));
    console.log('updated', rel);
  }
  console.log(`Program id ${old} -> ${next}. Rebuild with "npm run build" (or build:devnet).`);
}
