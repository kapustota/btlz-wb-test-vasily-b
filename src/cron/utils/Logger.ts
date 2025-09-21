/**
 * Простой логгер для крон-скриптов
 */
export class Logger {
    private readonly component: string;

    constructor(component: string) {
        this.component = component;
    }

    info(message: string, ...args: any[]) {
        console.log(`[${new Date().toISOString()}] [INFO] [${this.component}] ${message}`, ...args);
    }

    warn(message: string, ...args: any[]) {
        console.warn(`[${new Date().toISOString()}] [WARN] [${this.component}] ${message}`, ...args);
    }

    error(message: string, ...args: any[]) {
        console.error(`[${new Date().toISOString()}] [ERROR] [${this.component}] ${message}`, ...args);
    }
}
