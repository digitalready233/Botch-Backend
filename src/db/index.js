import dotenv from 'dotenv';
import { isMysqlUrl } from './sql-utils.js';

dotenv.config();

const useMysql = isMysqlUrl((process.env.DATABASE_URL || '').trim());

let poolImpl;
if (useMysql) {
  poolImpl = (await import('./mysql.js')).default;
} else {
  poolImpl = (await import('./sqlite.js')).default;
}

/** @returns {'mysql' | 'sqlite'} */
export function getDbKind() {
  return useMysql ? 'mysql' : 'sqlite';
}

const poolWrapper = {
  query: (text, params) => {
    return Promise.resolve().then(() => poolImpl.query(text, params));
  },
  getConnection: () => {
    if (typeof poolImpl.getConnection === 'function') {
      return poolImpl.getConnection();
    }
    return null;
  },
};

export default poolWrapper;
