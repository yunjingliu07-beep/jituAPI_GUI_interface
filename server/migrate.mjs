import {migrate} from './database.mjs';
if(!process.env.DATA_DIR)throw new Error('DATA_DIR is required.');
migrate(process.env.DATA_DIR);
console.log('Database migrations complete.');
