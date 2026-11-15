const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');

const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error('Usage: create-db-backup.js SOURCE TARGET');
if (!fs.existsSync(source)) throw new Error('Database not found: ' + source);
if (fs.existsSync(target)) throw new Error('Backup already exists: ' + target);

const db = new DatabaseSync(source);
try {
  const quote = String.fromCharCode(39);
  const sqlString = value => quote + value.replaceAll(quote, quote + quote) + quote;
  db.exec('VACUUM INTO ' + sqlString(target));
} finally {
  db.close();
}
