// Accounts and server-wide state, kept in memory and written through to the SQLite database (store.js):
// accounts -> the accounts table (one row each), everything else in db.state -> meta 'db' (id counter, sessions,
// server-wide counters of features). The first start on an empty database imports the old data/db.json.
const store = require('./store');
if (!process.env.SQLITE_FILE) store.migrate(console.log);   // tests use their own empty database

let state = Object.assign({ nextUserId: 100001 }, store.getMeta('db', {}), { accounts: store.loadAccounts() });

function save() {
  const { accounts, ...rest } = state;
  store.setMeta('db', rest);
  store.saveAccounts(accounts);
}

// one account per (userName, site); a character exists once nickName is set
function account(userName, site) {
  const key = site + '|' + userName;
  let a = state.accounts[key];
  if (!a) {
    a = state.accounts[key] = { userName, site, userId: state.nextUserId++, created: Date.now(), char: null };
    save();
  }
  return a;
}

function byUserId(id) {
  return Object.values(state.accounts).find(a => a.userId === id) || null;
}

module.exports = { account, byUserId, save, state };
