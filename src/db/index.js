import dotenv from 'dotenv';
import pool from './sqlite.js';

dotenv.config();

// Wrapper to match the expected pg interface
const poolWrapper = {
  query: (text, params) => {
    return new Promise((resolve, reject) => {
      try {
        const res = pool.query(text, params);
        resolve(res);
      } catch (err) {
        reject(err);
      }
    });
  }
};

export default poolWrapper;
