type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatMessage(
  level: LogLevel,
  module: string,
  message: string,
  data?: Record<string, unknown>
): string {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] [${module}] ${message}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
  return {
    debug(message, data) {
      if (shouldLog("debug"))
        console.debug(formatMessage("debug", module, message, data));
    },
    info(message, data) {
      if (shouldLog("info"))
        console.info(formatMessage("info", module, message, data));
    },
    warn(message, data) {
      if (shouldLog("warn"))
        console.warn(formatMessage("warn", module, message, data));
    },
    error(message, data) {
      if (shouldLog("error"))
        console.error(formatMessage("error", module, message, data));
    },
  };
}
