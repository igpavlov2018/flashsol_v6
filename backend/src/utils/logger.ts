import { createLogger, format, transports } from 'winston';

export const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? format.json()
      : format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
        })
  ),
  transports: [
    new transports.Console(),
    ...(process.env.NODE_ENV === 'production'
      ? [new transports.File({ filename: 'logs/error.log', level: 'error' }),
         new transports.File({ filename: 'logs/combined.log' })]
      : []),
  ],
});
