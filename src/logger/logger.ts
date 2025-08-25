import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

class Logger {
    private static logFilePath: string = process.env.LOG_FILE_PATH || path.join('out', 'pandoras-box.log');
    private static initialized = false;
    private static logLevel: string = process.env.LOG_LEVEL || 'INFO';
    
    private static shouldLog(level: string): boolean {
        const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
        const currentLevelIndex = levels.indexOf(Logger.logLevel.toUpperCase());
        const messageLevelIndex = levels.indexOf(level.toUpperCase());
        return messageLevelIndex >= currentLevelIndex;
    }

    private static ensureFile() {
        if (Logger.initialized) return;
        try {
            const dir = path.dirname(Logger.logFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Touch file
            if (!fs.existsSync(Logger.logFilePath)) {
                fs.writeFileSync(Logger.logFilePath, '');
            }
            Logger.initialized = true;
        } catch {
            // If file cannot be prepared, silently ignore to not break console logs
            Logger.initialized = true;
        }
    }

    private static ts(): string {
        return new Date().toISOString();
    }

    private static writeToFile(level: string, message: string) {
        Logger.ensureFile();
        try {
            fs.appendFileSync(Logger.logFilePath, `[${Logger.ts()}] [${level}] ${message}\n`);
        } catch {
            // ignore file write errors
        }
    }

    static info(s: string) {
        if (!Logger.shouldLog('INFO')) return;
        Logger.writeToFile('INFO', s);
    }

    static title(s: string) {
        if (!Logger.shouldLog('INFO')) return;
        console.log(chalk.blue(s));
        Logger.writeToFile('TITLE', s);
    }

    static warn(s: string) {
        if (!Logger.shouldLog('WARN')) return;

        Logger.writeToFile('WARN', s);
    }

    static success(s: string) {
        if (!Logger.shouldLog('INFO')) return;
        console.log(chalk.green(`✅ ${s}`));
        Logger.writeToFile('SUCCESS', s);
    }

    static error(s: string) {
        if (!Logger.shouldLog('ERROR')) return;

        Logger.writeToFile('ERROR', s);
    }

    static debug(s: string) {
        if (!Logger.shouldLog('DEBUG')) return;
        
        Logger.writeToFile('DEBUG', s);
    }
}

export default Logger;
