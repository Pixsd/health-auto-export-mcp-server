import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env'), quiet: true });

export const HAE_HOSTS: string[] = (process.env.HAE_HOST ?? 'localhost')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
export const HAE_HOST = HAE_HOSTS[0];
export const HAE_PORT = parseInt(process.env.HAE_PORT ?? '9000', 10);
export const DEFAULT_TIMEOUT = parseInt(process.env.HAE_TIMEOUT ?? '86400000', 10);
export const CONNECT_TIMEOUT = parseInt(process.env.HAE_CONNECT_TIMEOUT ?? '5000', 10);

export const MONGODB_URI =
    process.env.MONGODB_URI ?? '';
