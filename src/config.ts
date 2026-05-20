import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

export const HAE_HOST = process.env.HAE_HOST ?? 'localhost';
export const HAE_PORT = parseInt(process.env.HAE_PORT ?? '9000', 10);
export const DEFAULT_TIMEOUT = parseInt(process.env.HAE_TIMEOUT ?? '86400000', 10);

export const MONGODB_URI =
    process.env.MONGODB_URI ?? '';
